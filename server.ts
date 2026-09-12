// bb-plugin-inbox — backend entry.
//
// This is not a board. It is an inbox: one searchable list of threads, and a
// context pane for whichever one you are looking at. The states you care about
// are derived from the thread itself (an agent is working, an agent is waiting
// on you, it is done), never assigned by hand, so there is nothing to drag.
//
// The live list comes from the host on the frontend, so this backend only owns
// what the host does not:
//   - tags and the agent's standing note, per thread
//   - saved views
//   - deep search, which reaches archived threads and message bodies
//   - replying to a thread without leaving the list
//   - project icons, read out of each project's checkout
import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hueForSlot } from "./lib/project-visuals.ts";
import { DEFAULT_DISPLAY, parseDisplay, type Display } from "./lib/display.ts";
import {
  ICON_CANDIDATES,
  isSafeRelativePath,
  mimeForPath,
  parseIconOverrides,
} from "./lib/icon-candidates.ts";

/** Realtime channel app.tsx listens on for plugin-owned changes. */
const INBOX_CHANGED = "inbox-changed";

const MAX_TAGS = 12;
const MAX_TAG_LENGTH = 32;
const MAX_NOTE_LENGTH = 200;
const MAX_VIEWS = 9;
/** Icons above this are page art, not a mark, and too big to cache per project. */
const MAX_ICON_BYTES = 256 * 1024;
/** Re-look for a project's icon this often; repos gain and lose logos slowly. */
const ICON_RECHECK_MS = 24 * 60 * 60 * 1000;
/** Deep-search results past this are noise, and the payload has to stay small. */
const MAX_SEARCH_HITS = 60;
/** How much of a matching message to carry back as a snippet. */
const SNIPPET_LENGTH = 220;

const metaSchema = z.object({
  threadId: z.string(),
  tags: z.array(z.string()),
  note: z.string().nullable(),
  blockedOn: z.string().nullable(),
});
const displaySchema = z.object({
  groupBy: z.enum(["state", "project", "day", "none"]),
  sortBy: z.enum(["updated", "created", "alphabetical"]),
  unreadFirst: z.boolean(),
});
const viewSchema = z.object({
  id: z.string(),
  name: z.string(),
  query: z.string(),
  // A view restores how the list was organised as well as what it showed. A
  // view that only restored the query would land you in someone else's layout.
  display: displaySchema,
});
const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  iconUrl: z.string().nullable(),
  hue: z.number(),
  /** Repo-relative path the icon was read from, shown on the settings page. */
  iconSource: z.string().nullable(),
  /** The override in effect for this project, if the user set one. */
  iconOverride: z.string().nullable(),
  /** False when the project has no checkout to look in. */
  hasCheckout: z.boolean(),
});
const hitSchema = z.object({
  threadId: z.string(),
  title: z.string(),
  projectId: z.string(),
  snippet: z.string(),
  archived: z.boolean(),
  updatedAt: z.number(),
});

export type Meta = z.infer<typeof metaSchema>;
export type View = z.infer<typeof viewSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Hit = z.infer<typeof hitSchema>;

export const rpcContract = defineRpcContract({
  // Everything the host's own live thread list cannot tell the page, in one
  // call: plugin-owned metadata, saved views, and project identity.
  inbox_get: {
    input: z.null(),
    output: z.object({
      meta: z.array(metaSchema),
      views: z.array(viewSchema),
      projects: z.array(projectSchema),
      display: displaySchema,
    }),
  },
  // Archiving is one keystroke, so undo has to be one too.
  thread_unarchive: {
    input: z.object({ threadId: z.string() }),
    output: z.object({ restored: z.boolean() }),
  },
  thread_read: {
    input: z.object({ threadId: z.string(), read: z.boolean() }),
    output: z.object({ read: z.boolean() }),
  },
  tag_toggle: {
    input: z.object({
      threadId: z.string(),
      tag: z.string().trim().min(1).max(MAX_TAG_LENGTH),
    }),
    output: metaSchema,
  },
  // Reaches archived threads and message bodies, which the live list cannot.
  search_deep: {
    input: z.object({ text: z.string().trim().min(2).max(200) }),
    output: z.object({ hits: z.array(hitSchema) }),
  },
  display_set: {
    input: displaySchema,
    output: displaySchema,
  },
  view_save: {
    input: z.object({
      name: z.string().trim().min(1).max(24),
      query: z.string().max(200),
      display: displaySchema,
    }),
    output: z.object({ views: z.array(viewSchema) }),
  },
  // Per-project icon override, so the settings page can be a row per project
  // rather than a text blob whose syntax the user has to learn.
  icon_override_set: {
    input: z.object({
      projectName: z.string().min(1),
      path: z.string().max(256),
    }),
    output: z.object({ projects: z.array(projectSchema) }),
  },
  view_delete: {
    input: z.object({ id: z.string() }),
    output: z.object({ views: z.array(viewSchema) }),
  },
});

interface MetaRow {
  thread_id: string;
  tags: string | null;
  note: string | null;
  blocked_on: string | null;
}
interface ViewRow {
  id: string;
  name: string;
  query: string;
  display: string | null;
  position: number;
}
interface IconRow {
  project_id: string;
  source_path: string | null;
  mime: string | null;
  bytes: Buffer | null;
  sha256: string | null;
  checked_at: number;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    iconPaths: {
      type: "string",
      label: "Project icon overrides (edited above, one `project = path` per line)",
      experimental_multiline: true,
      default: "",
      // One `project = repo/relative/path.svg` per line. Detection only looks
      // in conventional places, so this is the escape hatch for a repo that
      // keeps its mark somewhere else.
      experimental_schema: z
        .string()
        .max(4096, "Keep the overrides under 4096 characters."),
    },
  });

  const db: Database = bb.storage.database();
  // Append-only: never reorder or edit a shipped statement, only push new ones.
  // Statements 0-3 were the per-project board, 4-8 folded it into one
  // board-wide column set, 9-10 added project icons and colour slots. 11-14
  // retire the board entirely: states are derived now, so stored placement is
  // dead weight, and tags plus saved views take its place.
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS board_columns (
       id TEXT PRIMARY KEY,
       project_id TEXT NOT NULL,
       name TEXT NOT NULL,
       position INTEGER NOT NULL,
       created_at INTEGER NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS board_columns_project
       ON board_columns (project_id, position)`,
    `CREATE TABLE IF NOT EXISTS board_cards (
       thread_id TEXT PRIMARY KEY,
       project_id TEXT NOT NULL,
       column_id TEXT,
       position INTEGER NOT NULL,
       note TEXT,
       updated_at INTEGER NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS board_cards_column
       ON board_cards (project_id, column_id, position)`,
    `CREATE TABLE IF NOT EXISTS board_columns_v2 (
       id TEXT PRIMARY KEY,
       name TEXT NOT NULL,
       position INTEGER NOT NULL,
       created_at INTEGER NOT NULL
     )`,
    `INSERT INTO board_columns_v2 (id, name, position, created_at)
       SELECT id, name, MIN(position), created_at
         FROM board_columns
        GROUP BY lower(name)`,
    `UPDATE board_cards
        SET column_id = (
              SELECT fresh.id
                FROM board_columns_v2 fresh, board_columns stale
               WHERE stale.id = board_cards.column_id
                 AND lower(stale.name) = lower(fresh.name)
            )
      WHERE column_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS board_columns_v2_position
       ON board_columns_v2 (position)`,
    `DROP TABLE IF EXISTS board_columns`,
    `CREATE TABLE IF NOT EXISTS project_icons (
       project_id TEXT PRIMARY KEY,
       source_path TEXT,
       mime TEXT,
       bytes BLOB,
       sha256 TEXT,
       checked_at INTEGER NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS project_slots (
       project_id TEXT PRIMARY KEY,
       slot INTEGER NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS thread_meta (
       thread_id TEXT PRIMARY KEY,
       tags TEXT,
       note TEXT,
       blocked_on TEXT,
       updated_at INTEGER NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS saved_views (
       id TEXT PRIMARY KEY,
       name TEXT NOT NULL,
       query TEXT NOT NULL,
       position INTEGER NOT NULL,
       created_at INTEGER NOT NULL
     )`,
    // The board's own note survived as thread_meta.note: it was already the
    // agent's one-line "where this stands", which is what the inbox shows.
    `INSERT OR IGNORE INTO thread_meta (thread_id, tags, note, blocked_on, updated_at)
       SELECT thread_id, NULL, note, NULL, updated_at
         FROM board_cards WHERE note IS NOT NULL`,
    `DROP TABLE IF EXISTS board_cards`,
    `ALTER TABLE saved_views ADD COLUMN display TEXT`,
  ]);
  db.exec(`DROP TABLE IF EXISTS board_columns_v2`);

  const selectMeta = db.prepare<[], MetaRow>(
    `SELECT thread_id, tags, note, blocked_on FROM thread_meta`,
  );
  const selectOneMeta = db.prepare<[string], MetaRow>(
    `SELECT thread_id, tags, note, blocked_on FROM thread_meta WHERE thread_id = ?`,
  );
  const upsertMeta = db.prepare(
    `INSERT INTO thread_meta (thread_id, tags, note, blocked_on, updated_at)
     VALUES (@threadId, @tags, @note, @blockedOn, @updatedAt)
     ON CONFLICT (thread_id) DO UPDATE SET
       tags = COALESCE(excluded.tags, thread_meta.tags),
       note = COALESCE(excluded.note, thread_meta.note),
       blocked_on = excluded.blocked_on,
       updated_at = excluded.updated_at`,
  );
  const selectViews = db.prepare<[], ViewRow>(
    `SELECT id, name, query, display, position FROM saved_views
      ORDER BY position, created_at`,
  );
  const insertView = db.prepare(
    `INSERT INTO saved_views (id, name, query, display, position, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const updateView = db.prepare(
    `UPDATE saved_views SET query = ?, display = ? WHERE id = ?`,
  );
  const deleteView = db.prepare(`DELETE FROM saved_views WHERE id = ?`);
  const selectSlots = db.prepare<[], { project_id: string; slot: number }>(
    `SELECT project_id, slot FROM project_slots`,
  );
  const insertSlot = db.prepare(
    `INSERT OR IGNORE INTO project_slots (project_id, slot) VALUES (?, ?)`,
  );
  const selectIcon = db.prepare<[string], IconRow>(
    `SELECT project_id, source_path, mime, bytes, sha256, checked_at
       FROM project_icons WHERE project_id = ?`,
  );
  const selectIconMeta = db.prepare<[], Omit<IconRow, "bytes">>(
    `SELECT project_id, source_path, mime, sha256, checked_at FROM project_icons`,
  );
  const upsertIcon = db.prepare(
    `INSERT INTO project_icons
       (project_id, source_path, mime, bytes, sha256, checked_at)
     VALUES (@projectId, @sourcePath, @mime, @bytes, @sha256, @checkedAt)
     ON CONFLICT (project_id) DO UPDATE SET
       source_path = excluded.source_path,
       mime = excluded.mime,
       bytes = excluded.bytes,
       sha256 = excluded.sha256,
       checked_at = excluded.checked_at`,
  );

  // --- Tags and the agent's standing note ---------------------------------

  function readMeta(threadId: string): Meta {
    return toMeta(selectOneMeta.get(threadId) ?? null, threadId);
  }

  function writeMeta(
    threadId: string,
    change: { tags?: string[]; note?: string | null; blockedOn?: string | null },
  ): Meta {
    const current = readMeta(threadId);
    upsertMeta.run({
      threadId,
      tags: change.tags === undefined ? null : JSON.stringify(change.tags),
      note: change.note === undefined ? null : change.note,
      blockedOn:
        change.blockedOn === undefined ? current.blockedOn : change.blockedOn,
      updatedAt: Date.now(),
    });
    const next = readMeta(threadId);
    bb.realtime.publish(INBOX_CHANGED, { threadId });
    return next;
  }

  // --- Saved views --------------------------------------------------------

  function listViews(): View[] {
    return selectViews.all().map((row) => ({
      id: row.id,
      name: row.name,
      query: row.query,
      display: parseDisplay(safeJson(row.display)),
    }));
  }

  /**
   * How the list is organised, kept server-side so it follows him between the
   * desktop app and a browser. The pane width deliberately does not: that one
   * depends on the screen, this one is a preference.
   */
  async function readDisplay(): Promise<Display> {
    return parseDisplay(await bb.storage.kv.get("display"));
  }

  // --- Project identity ---------------------------------------------------

  const iconRoute = `/api/v1/plugins/${bb.pluginId}/http/project-icon`;

  function iconUrlFor(projectId: string): string | null {
    const row = selectIconMeta
      .all()
      .find((candidate) => candidate.project_id === projectId);
    if (row === undefined || row.mime === null) return null;
    // The digest in the query string makes the URL change when the icon does,
    // which is what lets the response be cached immutably.
    return `${iconRoute}?project=${encodeURIComponent(projectId)}&v=${row.sha256 ?? "0"}`;
  }

  /**
   * Each project's colour slot, handing out the next free one to any project
   * we have not seen. Assignment is permanent: a project keeps its colour when
   * others are added or removed.
   */
  function projectHues(projectIds: readonly string[]): Map<string, number> {
    const assigned = new Map(
      selectSlots.all().map((row) => [row.project_id, row.slot] as const),
    );
    const missing = projectIds.filter((id) => !assigned.has(id));
    if (missing.length > 0) {
      let next = [...assigned.values()].reduce(
        (highest, slot) => Math.max(highest, slot + 1),
        0,
      );
      const assign = db.transaction(() => {
        for (const id of [...missing].sort()) {
          insertSlot.run(id, next);
          assigned.set(id, next);
          next += 1;
        }
      });
      assign();
    }
    return new Map(
      projectIds.map((id) => [id, hueForSlot(assigned.get(id) ?? 0)] as const),
    );
  }

  /** The project's default local checkout, or null when it has none. */
  function localSource(project: {
    sources: readonly {
      type: string;
      isDefault: boolean;
      path: string;
      hostId: string;
    }[];
  }): { path: string; hostId: string } | null {
    const source =
      project.sources.find(
        (candidate) => candidate.type === "local_path" && candidate.isDefault,
      ) ?? project.sources.find((candidate) => candidate.type === "local_path");
    return source === undefined
      ? null
      : { path: source.path, hostId: source.hostId };
  }

  /**
   * Look for one project's icon and cache the result. A miss is cached too:
   * the row records that we checked, so a project with no mark is not restatted
   * on every read.
   */
  async function refreshProjectIcon(project: {
    id: string;
    name: string;
    sources: readonly {
      type: string;
      isDefault: boolean;
      path: string;
      hostId: string;
    }[];
  }): Promise<void> {
    const now = Date.now();
    const miss = {
      projectId: project.id,
      sourcePath: null,
      mime: null,
      bytes: null,
      sha256: null,
      checkedAt: now,
    };
    const source = localSource(project);
    if (source === null) {
      upsertIcon.run(miss);
      return;
    }

    const { iconPaths } = await settings.get();
    const override = parseIconOverrides(iconPaths).get(
      project.name.toLowerCase(),
    );
    const candidates =
      override !== undefined && isSafeRelativePath(override)
        ? [override, ...ICON_CANDIDATES]
        : ICON_CANDIDATES;

    const absolute = candidates.map((relative) => `${source.path}/${relative}`);
    let existence: Record<string, boolean>;
    try {
      ({ existence } = await bb.sdk.hosts.pathsExist({
        hostId: source.hostId,
        paths: absolute,
      }));
    } catch (cause) {
      bb.log.warn(`icon probe failed for ${project.name}: ${String(cause)}`);
      upsertIcon.run(miss);
      return;
    }

    for (const [index, relative] of candidates.entries()) {
      const path = absolute[index]!;
      if (existence[path] !== true) continue;
      const mime = mimeForPath(relative);
      if (mime === null) continue;
      let file;
      try {
        file = await bb.sdk.files.read({ hostId: source.hostId, path });
      } catch {
        continue;
      }
      // Rails and friends ship zero-byte placeholder favicons; treating one as
      // a find would put a broken image on every row in that project.
      if (file.sizeBytes === 0 || file.sizeBytes > MAX_ICON_BYTES) continue;
      const bytes = Buffer.from(
        file.content,
        file.contentEncoding === "base64" ? "base64" : "utf8",
      );
      if (bytes.byteLength === 0) continue;
      upsertIcon.run({
        projectId: project.id,
        sourcePath: relative,
        mime,
        bytes,
        sha256: file.sha256.slice(0, 16),
        checkedAt: now,
      });
      bb.log.info(`icon for ${project.name}: ${relative}`);
      return;
    }

    upsertIcon.run(miss);
  }

  /** Re-check every project, and tell open inboxes when anything changed. */
  async function refreshAllIcons(force: boolean): Promise<void> {
    const projects = await bb.sdk.projects.list({ includePersonal: true });
    const known = new Map(
      selectIconMeta.all().map((row) => [row.project_id, row] as const),
    );
    let changed = false;
    for (const project of projects) {
      const row = known.get(project.id);
      const stale =
        row === undefined ||
        force ||
        Date.now() - row.checked_at > ICON_RECHECK_MS;
      if (!stale) continue;
      const before = row?.sha256 ?? null;
      await refreshProjectIcon(project);
      if (before !== (selectIcon.get(project.id)?.sha256 ?? null)) changed = true;
    }
    if (changed) bb.realtime.publish(INBOX_CHANGED, { icons: true });
  }

  async function readProjects(): Promise<Project[]> {
    const listed = await bb.sdk.projects.list({ includePersonal: true });
    const hues = projectHues(listed.map((project) => project.id));
    // A project the sweep has never seen gets looked at in the background. The
    // inbox renders on its colour immediately and the icon arrives with the next
    // "inbox-changed" signal rather than holding up this response.
    if (listed.some((project) => selectIcon.get(project.id) === undefined)) {
      void refreshAllIcons(false).catch((cause: unknown) => {
        bb.log.warn(`icon lookup failed: ${String(cause)}`);
      });
    }
    const { iconPaths } = await settings.get();
    const overrides = parseIconOverrides(iconPaths);
    return listed
      .map((project) => ({
        id: project.id,
        name: project.name,
        iconUrl: iconUrlFor(project.id),
        hue: hues.get(project.id) ?? 0,
        iconSource: selectIcon.get(project.id)?.source_path ?? null,
        iconOverride: overrides.get(project.name.toLowerCase()) ?? null,
        hasCheckout: localSource(project) !== null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  bb.http.route(
    "GET",
    "/project-icon",
    (context) => {
      const projectId = new URL(context.req.url).searchParams.get("project");
      const row = projectId === null ? undefined : selectIcon.get(projectId);
      if (row?.bytes == null || row.mime === null) {
        return new Response("Not found", { status: 404 });
      }
      return new Response(new Uint8Array(row.bytes), {
        headers: {
          "content-type": row.mime,
          // The URL carries the digest, so a hit is always the right bytes.
          "cache-control": "public, max-age=31536000, immutable",
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'",
        },
      });
    },
    { auth: "local" },
  );

  bb.background.service("icon-sweep", {
    async start(signal) {
      await refreshAllIcons(false).catch((cause: unknown) => {
        bb.log.warn(`icon sweep failed: ${String(cause)}`);
      });
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  });
  bb.background.schedule("icon-refresh", "17 4 * * *", async () => {
    await refreshAllIcons(true);
  });
  // An override is useless if it waits for the daily sweep, so editing one
  // re-looks immediately. Only that field forces the work.
  settings.onChange((next, previous) => {
    if (next.iconPaths === previous.iconPaths) return;
    void refreshAllIcons(true).catch((cause: unknown) => {
      bb.log.warn(`icon refresh after settings change failed: ${String(cause)}`);
    });
  });

  // --- RPC ----------------------------------------------------------------

  bb.rpc.register(rpcContract, {
    inbox_get: async () => ({
      meta: selectMeta.all().map((row) => toMeta(row, row.thread_id)),
      views: listViews(),
      projects: await readProjects(),
      display: await readDisplay(),
    }),

    display_set: async (next) => {
      await bb.storage.kv.set("display", next);
      // No realtime publish: the window that changed it already has it, and
      // republishing would make every other open inbox jump under the user.
      return next;
    },

    thread_unarchive: async ({ threadId }) => {
      await bb.sdk.threads.unarchive({ threadId });
      bb.realtime.publish(INBOX_CHANGED, { threadId });
      return { restored: true };
    },

    thread_read: async ({ threadId, read }) => {
      if (read) await bb.sdk.threads.markRead({ threadId });
      else await bb.sdk.threads.markUnread({ threadId });
      bb.realtime.publish(INBOX_CHANGED, { threadId });
      return { read };
    },

    tag_toggle: ({ threadId, tag }) => {
      const wanted = normalizeTag(tag);
      if (wanted === null) throw new Error("That is not a usable tag.");
      const current = readMeta(threadId).tags;
      const next = current.includes(wanted)
        ? current.filter((existing) => existing !== wanted)
        : [...current, wanted].slice(0, MAX_TAGS);
      return writeMeta(threadId, { tags: next });
    },

    search_deep: async ({ text }) => {
      const found = await bb.sdk.threads.search({ query: text });
      const hits: Hit[] = [];
      for (const [group, archived] of [
        [found.active, false],
        [found.archived, true],
      ] as const) {
        for (const result of group.results) {
          if (hits.length >= MAX_SEARCH_HITS) break;
          const best = result.matches[0];
          hits.push({
            threadId: result.thread.id,
            title:
              result.thread.title ?? result.thread.titleFallback ?? "Untitled",
            projectId: result.thread.projectId,
            snippet: (best?.text ?? "").slice(0, SNIPPET_LENGTH),
            archived,
            updatedAt: result.thread.updatedAt,
          });
        }
      }
      return { hits };
    },

    view_save: ({ name, query, display }) => {
      const encoded = JSON.stringify(display);
      const existing = selectViews
        .all()
        .find((row) => row.name.toLowerCase() === name.toLowerCase());
      if (existing !== undefined) {
        updateView.run(query, encoded, existing.id);
      } else {
        const views = selectViews.all();
        if (views.length >= MAX_VIEWS) {
          throw new Error(
            `The inbox holds ${MAX_VIEWS} saved views, one per number key.`,
          );
        }
        insertView.run(
          randomUUID().slice(0, 8),
          name,
          query,
          encoded,
          views.length,
          Date.now(),
        );
      }
      bb.realtime.publish(INBOX_CHANGED, { views: true });
      return { views: listViews() };
    },

    icon_override_set: async ({ projectName, path }) => {
      const wanted = path.trim();
      if (wanted !== "" && !isSafeRelativePath(wanted)) {
        throw new Error(
          "Use a relative path to an image inside the project, like public/icon.svg.",
        );
      }
      // Rewrite only the line this project owns, so a hand-edited field
      // survives a click here.
      const { iconPaths } = await settings.get();
      const key = projectName.toLowerCase();
      const kept = iconPaths.split("\n").filter((line) => {
        const split = line.indexOf("=");
        if (split === -1) return line.trim() !== "";
        return line.slice(0, split).trim().toLowerCase() !== key;
      });
      if (wanted !== "") kept.push(`${projectName} = ${wanted}`);
      await settings.experimental_set({ iconPaths: kept.join("\n") });
      await refreshAllIcons(true);
      return { projects: await readProjects() };
    },

    view_delete: ({ id }) => {
      deleteView.run(id);
      bb.realtime.publish(INBOX_CHANGED, { views: true });
      return { views: listViews() };
    },
  });

  // --- Agent tools --------------------------------------------------------
  // The point of these is context reload. An agent that keeps one honest line
  // current means you can pick a thread back up without reading a transcript.

  bb.agents.registerTool({
    name: "task_note",
    description:
      "Set this thread's standing one-line summary in the inbox: where the " +
      "work actually stands right now. Replace it whenever that changes. If " +
      "you are stuck waiting on the user, say what you need in blockedOn.",
    instructions:
      "Keep task_note current. It is the line the user reads to remember what " +
      "this thread is, so write it for someone who has not looked in a week.",
    presentation: {
      label: { pending: "Updating the inbox", completed: "Updated the inbox" },
      icon: { glyph: "inbox/inbox" },
    },
    parameters: z.object({
      note: z
        .string()
        .min(1)
        .max(MAX_NOTE_LENGTH)
        .describe('Where the work stands, e.g. "tests green, needs review".'),
      blockedOn: z
        .string()
        .max(MAX_NOTE_LENGTH)
        .optional()
        .describe(
          'What you need from the user before you can continue, e.g. "the Stripe test key". Omit when you are not blocked.',
        ),
    }),
    execute({ note, blockedOn }, { threadId }) {
      writeMeta(threadId, { note, blockedOn: blockedOn ?? null });
      return blockedOn === undefined
        ? `Noted: ${note}`
        : `Noted: ${note} (blocked on ${blockedOn})`;
    },
  });

  bb.agents.registerTool({
    name: "task_tag",
    description:
      "Add or remove tags on this thread so it can be found later. Use short " +
      "lowercase tags for the things a title does not already say.",
    presentation: {
      label: { pending: "Tagging the thread", completed: "Tagged the thread" },
      icon: { glyph: "inbox/inbox" },
    },
    parameters: z.object({
      add: z.array(z.string()).max(MAX_TAGS).optional(),
      remove: z.array(z.string()).max(MAX_TAGS).optional(),
    }),
    execute({ add, remove }, { threadId }) {
      const dropped = new Set(
        (remove ?? []).map(normalizeTag).filter((tag) => tag !== null),
      );
      const added = (add ?? [])
        .map(normalizeTag)
        .filter((tag): tag is string => tag !== null);
      const next = [
        ...readMeta(threadId).tags.filter((tag) => !dropped.has(tag)),
        ...added,
      ];
      const meta = writeMeta(threadId, {
        tags: [...new Set(next)].slice(0, MAX_TAGS),
      });
      return meta.tags.length === 0
        ? "No tags on this thread."
        : `Tags: ${meta.tags.join(", ")}`;
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}

/** JSON that came out of our own database, but might be from a future version. */
function safeJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function toMeta(row: MetaRow | null, threadId: string): Meta {
  let tags: string[] = [];
  if (row?.tags != null) {
    try {
      const parsed: unknown = JSON.parse(row.tags);
      if (Array.isArray(parsed)) {
        tags = parsed.filter((tag): tag is string => typeof tag === "string");
      }
    } catch {
      // A row written by a future version, or a hand edit. Tags are decoration;
      // losing them must never take the inbox down.
      tags = [];
    }
  }
  return {
    threadId,
    tags,
    note: row?.note ?? null,
    blockedOn: row?.blocked_on ?? null,
  };
}

/** Tags are lowercase, single-token, and short, so they stay typeable. */
function normalizeTag(raw: string): string | null {
  const tag = raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9:_-]/g, "");
  return tag === "" || tag.length > MAX_TAG_LENGTH ? null : tag;
}
