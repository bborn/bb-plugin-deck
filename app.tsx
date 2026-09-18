// bb-plugin-deck — frontend entry.
//
// The deck. One searchable list of threads on the left, the context you need
// to answer one of them on the right. No columns and nothing to drag: a
// thread's state is read off the thread, so the only thing you do here is
// find the right one, remember what it was, say something, and move on.
//
// The list itself is the host's own live thread data, so it never goes stale
// and costs no round trip. The backend only supplies what the host does not:
// tags, the agent's standing note, saved views, and search that reaches
// archived threads and message bodies.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { KeyboardEvent, ReactNode, RefObject } from "react";
import {
  definePluginApp,
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  experimental_useSidebarThreadPullRequest as useSidebarThreadPullRequest,
  experimental_useSidebarThreadSplit as useSidebarThreadSplit,
  experimental_useSidebarThreads as useSidebarThreads,
  useBbNavigate,
  useRealtime,
  useRpc,
  type PluginSidebarThread,
  type PluginSidebarThreadActivity,
  type PluginSidebarThreadIndicator,
  type PluginThreadListProps,
} from "@get-bb/plugin-sdk/app";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { toast } from "sonner";
import type { Hit, Meta, Project, View, rpcContract } from "./server";
import {
  matches,
  parseQuery,
  projectSuggestions,
  type Matchable,
  type State,
} from "@/lib/query";
import {
  DEFAULT_DISPLAY,
  DEFAULT_SESSION,
  GROUP_BY_LABEL,
  parseDisplay,
  parseSession,
  SORT_BY_LABEL,
  displayBranch,
  cycleGroupBy,
  cycleSortBy,
  groupRows,
  type Display,
  type GroupBy,
  type Groupable,
  type Session,
  type SortBy,
} from "@/lib/display";
import {
  ACTIONS,
  DEFAULT_BINDINGS,
  encodeChord,
  formatChord,
  isReserved,
  lookup,
  resolveBindings,
  type ActionId,
  type Bindings,
} from "@/lib/bindings";
import { colorForHue, projectInitials } from "@/lib/project-visuals";
import { Button } from "@/components/ui/button";
import { Icon, type IconName } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** A thread as the deck sees it: host truth plus what this plugin knows. */
interface Row extends Matchable, Groupable {
  projectId: string;
  projectHue: number;
  projectIconUrl: string | null;
  blockedOn: string | null;
  /** Forked and spawned threads nest under this, the way bb's own list does. */
  parentThreadId: string | null;
  /**
   * bb's own rolled-up signal and its live counts, carried through rather than
   * flattened. `state` still answers "does this need me", but it collapses
   * five kinds of busy into one; these say which kind, the way bb's sidebar
   * does. `indicatorLabel` is bb's accessible wording — reuse it verbatim so
   * screen readers hear the same thing in both lists.
   */
  indicator: PluginSidebarThreadIndicator;
  indicatorLabel: string | null;
  activity: PluginSidebarThreadActivity;
}

const SEARCH_PLACEHOLDER = "Find anything: ENG-482, #1284, a branch, [project]";

/**
 * A thread's state, read off the thread rather than assigned. "Needs you" is
 * the only one that matters much, so anything that blocks the agent on a human
 * lands there.
 */
const WORKING_INDICATORS = new Set([
  "runtime",
  "background-agent",
  "background-command",
  "workflow",
  "goal",
  "plan-mode",
]);

function stateOf(thread: PluginSidebarThread, blockedOn: string | null): State {
  if (thread.isArchived) return "done";
  // An agent that declared what it is waiting for is authoritative. bb only
  // knows about its own interaction prompts, so without this a thread that
  // asked for a decision in prose would sit in "Idle" looking finished.
  if (blockedOn !== null) return "needs-me";
  // `indicator` is bb's own rolled-up "what is this thread doing" signal, so
  // deriving from it keeps the deck agreeing with the sidebar for free.
  if (
    thread.hasPendingInteraction ||
    thread.indicator === "waiting-for-input" ||
    thread.indicator === "unread-error"
  ) {
    return "needs-me";
  }
  const busy =
    thread.activity.workflows +
      thread.activity.backgroundAgents +
      thread.activity.backgroundCommands +
      thread.activity.planMode +
      thread.activity.goals >
    0;
  if (busy || WORKING_INDICATORS.has(thread.indicator)) return "working";
  return "idle";
}

function relativeTime(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return `${Math.round(days / 7)}w`;
}

interface DeckData {
  meta: Meta[];
  views: View[];
  projects: Project[];
  display: Display;
  session: Session;
  bindings: Bindings;
}

const CACHE_KEY = "bb-plugin-deck:cache:1";

/** How long typing has to stop before the search box is written down. */
const SESSION_WRITE_DELAY_MS = 500;

/**
 * The last payload, read synchronously so the very first paint already has
 * project icons, saved views and the grouping. Without it the list renders
 * once with initials and default grouping, then again a round trip later,
 * which is the flicker.
 */
function readCache(): DeckData | null {
  try {
    const raw = globalThis.localStorage?.getItem(CACHE_KEY);
    if (raw == null) return null;
    const parsed = JSON.parse(raw) as Partial<DeckData>;
    if (!Array.isArray(parsed.projects)) return null;
    return {
      meta: Array.isArray(parsed.meta) ? parsed.meta : [],
      views: Array.isArray(parsed.views) ? parsed.views : [],
      projects: parsed.projects,
      display: parseDisplay(parsed.display),
      session: parseSession(parsed.session),
      bindings: resolveBindings(parsed.bindings),
    };
  } catch {
    return null;
  }
}

function useDeck() {
  const rpc = useRpc<typeof rpcContract>();
  const cached = useRef(readCache()).current;
  const [meta, setMeta] = useState<Meta[]>(cached?.meta ?? []);
  const [views, setViews] = useState<View[]>(cached?.views ?? []);
  const [projects, setProjects] = useState<Project[]>(cached?.projects ?? []);
  const [display, setDisplay] = useState<Display>(
    cached?.display ?? DEFAULT_DISPLAY,
  );
  const [session, setSession] = useState<Session>(
    cached?.session ?? DEFAULT_SESSION,
  );
  const [bindings, setBindings] = useState<Bindings>(
    cached?.bindings ?? DEFAULT_BINDINGS,
  );
  // The server is authoritative until the first load lands or you touch one of
  // these yourself, whichever comes first; after that the window owns its own
  // display and session so a refetch cannot yank a setting back or retype the
  // search box under you.
  const loaded = useRef(false);
  const displayRef = useRef(display);
  displayRef.current = display;
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const cacheRef = useRef<DeckData | null>(cached);
  const cacheKeyRef = useRef<string>("");

  // Only write when something actually moved, so a realtime signal does not
  // churn storage on every keystroke elsewhere in the app.
  const saveCache = useCallback((next: DeckData) => {
    cacheRef.current = next;
    const encoded = JSON.stringify(next);
    if (encoded === cacheKeyRef.current) return;
    cacheKeyRef.current = encoded;
    try {
      globalThis.localStorage?.setItem(CACHE_KEY, encoded);
    } catch {
      // A browser with storage off still works, just without the instant
      // first paint.
    }
  }, []);

  /**
   * Fold a local change into the cached payload. Without this the next paint
   * starts from whatever the last fetch saw — the old grouping, the empty
   * search box — and only corrects a round trip later, which is the flicker
   * this cache exists to prevent.
   */
  const patchCache = useCallback(
    (patch: Partial<DeckData>) => {
      const base = cacheRef.current;
      if (base === null) return;
      saveCache({ ...base, ...patch });
    },
    [saveCache],
  );

  const refetch = useCallback(() => {
    rpc.call("deck_get").then(
      (next) => {
        const merged = resolveBindings(next.bindings);
        setMeta(next.meta);
        setViews(next.views);
        setProjects(next.projects);
        setBindings(merged);
        if (!loaded.current) {
          setDisplay(next.display);
          setSession(next.session);
          loaded.current = true;
          saveCache({ ...next, bindings: merged });
        } else {
          // Ours are newer than anything this response can carry, and a write
          // in flight may not be in it at all.
          saveCache({
            ...next,
            bindings: merged,
            display: displayRef.current,
            session: sessionRef.current,
          });
        }
      },
      (cause: unknown) => {
        toast.error(cause instanceof Error ? cause.message : String(cause));
      },
    );
  }, [rpc, saveCache]);

  useEffect(refetch, [refetch]);
  useRealtime("deck-changed", refetch);

  const changeDisplay = useCallback(
    (next: Display) => {
      loaded.current = true;
      setDisplay(next);
      patchCache({ display: next });
      rpc.call("display_set", next).catch(() => {
        toast.error("Could not save that display setting.");
      });
    },
    [rpc, patchCache],
  );

  // The session moves on every keystroke, so it is written once the typing
  // stops rather than per character.
  const pendingSession = useRef<Session | null>(null);
  const sessionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushSession = useCallback(() => {
    if (sessionTimer.current !== null) {
      clearTimeout(sessionTimer.current);
      sessionTimer.current = null;
    }
    const next = pendingSession.current;
    if (next === null) return;
    pendingSession.current = null;
    // Quiet on failure: this fires while you type, and a toast per keystroke
    // would be worse than losing the last word of a search.
    rpc.call("session_set", next).catch(() => undefined);
  }, [rpc]);

  const changeSession = useCallback(
    (next: Session) => {
      loaded.current = true;
      setSession(next);
      patchCache({ session: next });
      pendingSession.current = next;
      if (sessionTimer.current !== null) clearTimeout(sessionTimer.current);
      sessionTimer.current = setTimeout(flushSession, SESSION_WRITE_DELAY_MS);
    },
    [flushSession, patchCache],
  );

  // Leaving the deck is exactly the moment the session has to be saved, and
  // it is also the moment the debounce would otherwise be thrown away.
  useEffect(() => flushSession, [flushSession]);

  return {
    rpc,
    meta,
    views,
    projects,
    display,
    session,
    bindings,
    changeDisplay,
    changeSession,
    setViews,
    refetch,
  };
}

/** The fields a project mark needs. A group header has these; so does a row. */
interface Marked {
  projectName: string;
  projectHue: number;
  projectIconUrl: string | null;
}

/**
 * A project's own icon where we found one, and coloured initials where we did
 * not. The colour is now only ever a stand-in for a missing icon: an invented
 * hue sitting next to a real brand mark reads as noise, not information.
 */
/** Build the plugin's view of the host's threads. Shared by both surfaces. */
function useRows(
  threads: readonly PluginSidebarThread[],
  hostProjects: readonly { id: string; name: string }[],
  projects: Project[],
  meta: Meta[],
): Row[] {
  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project] as const)),
    [projects],
  );
  const metaById = useMemo(
    () => new Map(meta.map((entry) => [entry.threadId, entry] as const)),
    [meta],
  );
  return useMemo(
    () =>
      threads.map((thread) => {
        const project = projectById.get(thread.projectId);
        const own = metaById.get(thread.id);
        const hostProject = hostProjects.find(
          (candidate) => candidate.id === thread.projectId,
        );
        return {
          threadId: thread.id,
          title: thread.title ?? thread.titleFallback ?? "Untitled",
          projectId: thread.projectId,
          projectName: project?.name ?? hostProject?.name ?? "Unknown",
          projectHue: project?.hue ?? 0,
          projectIconUrl: project?.iconUrl ?? null,
          parentThreadId: thread.parentThreadId,
          branchName: thread.environment?.branchName ?? null,
          prNumber: null,
          prTitle: null,
          tags: own?.tags ?? [],
          note: own?.note ?? null,
          blockedOn: own?.blockedOn ?? null,
          state: stateOf(thread, own?.blockedOn ?? null),
          indicator: thread.indicator,
          indicatorLabel: thread.indicatorLabel,
          activity: thread.activity,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          isUnread: thread.isUnread,
          isPinned: thread.isPinned,
        };
      }),
    [threads, projectById, metaById, hostProjects],
  );
}

/**
 * What bb draws for each `indicator`, so a row says which kind of busy it is
 * rather than just "busy". Anything unlisted falls through to a plain dot:
 * bb adds kinds over time and an older plugin has to degrade quietly rather
 * than throw.
 */
const INDICATOR_ICON: Partial<Record<PluginSidebarThreadIndicator, IconName>> = {
  "background-agent": "Bot",
  "background-command": "Terminal",
  workflow: "Workflow",
  "plan-mode": "ListTodo",
  goal: "Target",
  "waiting-for-input": "MessageQuestion",
  "unread-error": "AlertCircle",
  "unread-success": "CircleCheck",
  draft: "Edit",
  "working-draft": "Edit",
  runtime: "Loading",
};

/** Total live work on a thread; 0 means nothing is running. */
function activityCount(activity: PluginSidebarThreadActivity): number {
  return (
    activity.workflows +
    activity.backgroundAgents +
    activity.backgroundCommands +
    activity.planMode +
    activity.goals
  );
}

/**
 * The leading mark on a row. Needing you outranks everything, since it is the
 * only state that costs something to miss; below that we show bb's own
 * indicator so the deck and the sidebar never disagree about what a thread is
 * doing.
 */
/**
 * The quick palette runs its commands outside React, so they cannot touch the
 * display through a hook. They post here instead and the mounted list does the
 * real work — one channel, so a command still behaves the same whether the
 * sidebar is showing or not.
 */
type DisplayCommand = "groupBy" | "sortBy" | "unreadFirst";

const displayCommands = {
  listeners: new Set<(kind: DisplayCommand) => void>(),
  emit(kind: DisplayCommand) {
    for (const listener of displayCommands.listeners) listener(kind);
  },
  subscribe(listener: (kind: DisplayCommand) => void) {
    displayCommands.listeners.add(listener);
    // Swallow Set.delete's boolean: this is an effect destructor.
    return () => {
      displayCommands.listeners.delete(listener);
    };
  },
};

function cycleDisplay(kind: DisplayCommand) {
  displayCommands.emit(kind);
}

/**
 * Flatten rows into render order with a depth per row, nesting a fork or a
 * spawned thread under its parent the way bb's own list does. A child whose
 * parent is filtered out stays visible at the top level rather than vanishing
 * with it — a search that hid matching threads would be the worse bug.
 */
function nestRows(rows: readonly Row[]): { row: Row; depth: number }[] {
  const present = new Set(rows.map((row) => row.threadId));
  const children = new Map<string, Row[]>();
  const roots: Row[] = [];
  for (const row of rows) {
    const parent = row.parentThreadId;
    if (parent !== null && parent !== row.threadId && present.has(parent)) {
      const kin = children.get(parent);
      if (kin === undefined) children.set(parent, [row]);
      else kin.push(row);
    } else {
      roots.push(row);
    }
  }
  const out: { row: Row; depth: number }[] = [];
  const walk = (row: Row, depth: number) => {
    out.push({ row, depth });
    // Depth is capped for indent purposes by the renderer, not here: the tree
    // is whatever bb says it is.
    for (const child of children.get(row.threadId) ?? []) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  return out;
}

function ThreadMark({ row }: { row: Row }) {
  // An agent that declared what it is waiting for outranks bb's indicator:
  // bb only knows about its own prompts, not a question asked in prose.
  if (row.state === "needs-me") {
    return (
      <Icon
        name={row.blockedOn !== null ? "MessageQuestion" : "AlertCircle"}
        aria-label={row.indicatorLabel ?? "Needs you"}
        className="size-3.5 shrink-0 text-destructive"
      />
    );
  }
  const icon = INDICATOR_ICON[row.indicator];
  if (row.state === "working") {
    const count = activityCount(row.activity);
    return (
      <span className="flex shrink-0 items-center gap-1">
        <Icon
          name={icon ?? "Loading"}
          aria-label={row.indicatorLabel ?? "Working"}
          className={cn(
            "size-3.5 shrink-0 text-foreground",
            // A spoked ring that only fades reads as stopped, which is the
            // opposite of what this mark is for. The spinner turns; a bot or
            // a terminal glyph would look silly rotating, so those breathe.
            (icon ?? "Loading") === "Loading"
              ? "animate-spin"
              : "animate-pulse",
          )}
        />
        {count > 1 ? (
          <span className="text-[10px] tabular-nums text-muted-foreground">
            {count}
          </span>
        ) : null}
      </span>
    );
  }
  // Idle threads can still carry a signal worth seeing — an error you have not
  // read, a draft you left behind.
  if (icon !== undefined && row.indicator !== "runtime") {
    return (
      <Icon
        name={icon}
        aria-label={row.indicatorLabel ?? undefined}
        className={cn(
          "size-3.5 shrink-0",
          row.indicator === "unread-error"
            ? "text-destructive"
            : "text-muted-foreground",
        )}
      />
    );
  }
  if (row.isUnread) {
    return (
      <span
        aria-label="Unread"
        className="size-2 shrink-0 rounded-full bg-foreground"
      />
    );
  }
  return <span aria-hidden className="size-2 shrink-0" />;
}

function ProjectMark({ of, className }: { of: Marked; className?: string }) {
  const [broken, setBroken] = useState(false);
  if (of.projectIconUrl !== null && !broken) {
    return (
      <img
        src={of.projectIconUrl}
        alt=""
        // Not lazy: these are a handful of tiny, immutably-cached images, and
        // lazy decoding is exactly what makes them pop in after the rows.
        loading="eager"
        decoding="sync"
        onError={() => setBroken(true)}
        className={cn("size-4 shrink-0 rounded-[3px] object-contain", className)}
      />
    );
  }
  return (
    <span
      aria-hidden
      style={{ backgroundColor: colorForHue(of.projectHue) }}
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-[3px] text-[8px] font-semibold leading-none text-white",
        className,
      )}
    >
      {projectInitials(of.projectName)}
    </span>
  );
}

/** The PR badge. Its own component so one lookup per row stays contained. */
function PullRequestBadge({ threadId }: { threadId: string }) {
  const { pullRequest } = useSidebarThreadPullRequest(threadId);
  if (pullRequest === null) return null;
  const wants =
    pullRequest.attention === "changes_requested" ||
    pullRequest.attention === "checks_failed" ||
    pullRequest.attention === "conflicts" ||
    pullRequest.attention === "review_requested";
  return (
    <span
      title={`${pullRequest.title} (${pullRequest.attention.replace(/_/g, " ")})`}
      className={cn(
        "shrink-0 rounded px-1 font-mono text-[10px] leading-4",
        wants
          ? "bg-destructive/15 text-destructive"
          : "bg-muted text-muted-foreground",
      )}
    >
      #{pullRequest.number}
    </span>
  );
}

/**
 * bb's own row actions, in our chrome. Every item routes through
 * `useSidebarThreadActions`, so confirmations, toasts, optimistic updates and
 * route repair behave exactly as they do in the built-in sidebar — notably
 * Delete, which opens bb's own dialog because it counts children first.
 *
 * A button rather than a right-click menu: that is what bb's rows do, and the
 * context-menu primitive is not a dependency here.
 */
function RowMenu({ row, canSplit }: { row: Row; canSplit: boolean }) {
  const actions = useSidebarThreadActions();
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Actions for ${row.title}`}
          onClick={(event) => event.stopPropagation()}
          className="size-6 shrink-0 text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100 data-[state=open]:opacity-100"
        >
          <Icon name="MoreHorizontal" className="size-4" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          onClick={(event) => event.stopPropagation()}
          className="z-50 min-w-48 rounded-lg border border-border bg-card p-1 shadow-md"
        >
          <DropdownMenu.Item
            className={MENU_ITEM}
            onSelect={() => actions.open(row.threadId)}
          >
            Open
          </DropdownMenu.Item>
          {canSplit ? (
            <DropdownMenu.Item
              className={MENU_ITEM}
              onSelect={() => actions.open(row.threadId, { split: true })}
            >
              Open in a split
            </DropdownMenu.Item>
          ) : null}
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Item
            className={MENU_ITEM}
            onSelect={() => void actions.setPinned(row.threadId, !row.isPinned)}
          >
            {row.isPinned ? "Unpin" : "Pin"}
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className={MENU_ITEM}
            onSelect={() => void actions.setRead(row.threadId, row.isUnread)}
          >
            {row.isUnread ? "Mark read" : "Mark unread"}
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Item
            className={MENU_ITEM}
            onSelect={() => actions.archive(row.threadId)}
          >
            Archive
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className={cn(MENU_ITEM, "text-destructive")}
            onSelect={() => actions.requestDelete(row.threadId)}
          >
            Delete…
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function ThreadRow({
  row,
  selected,
  active,
  showProject,
  depth,
  onSelect,
  onOpen,
}: {
  row: Row;
  selected: boolean;
  /** True when the list itself holds the caret. */
  active: boolean;
  /** False under a project group, where the header already says which one. */
  showProject: boolean;
  /** How deep under a parent thread this row sits. */
  depth: number;
  onSelect: () => void;
  onOpen: () => void;
}) {
  // bb names a worktree branch after the thread, so most branches here are the
  // title in kebab-case with the thread id on the end. Those say nothing the
  // title has not; a branch someone chose does.
  const shownBranch = displayBranch(row.branchName, row.threadId);
  // Once per rendered row, the way the built-in sidebar does it. The host owns
  // every rule of the gesture; spreading splitProps is safe even when splits
  // are off, because it is empty then.
  const split = useSidebarThreadSplit(row.threadId);
  return (
    <li>
      <div
        id={`row-${row.threadId}`}
        role="option"
        aria-selected={selected}
        tabIndex={-1}
        onClick={onSelect}
        onDoubleClick={onOpen}
        {...split.splitProps}
        // Indent by nesting depth, capped so a long fork chain cannot push the
        // title off the edge of a 300px column.
        style={{ paddingLeft: `${0.75 + Math.min(depth, 4) * 0.875}rem` }}
        className={cn(
          "group/row cursor-pointer border-l-2 pr-2 py-2.5 text-sm",
          selected
            ? active
              ? "border-foreground bg-muted"
              : "border-transparent bg-muted/50"
            : "border-transparent hover:bg-muted/50",
        )}
      >
        <div className="flex items-center gap-2.5">
          <ThreadMark row={row} />
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              // Read rows recede and unread rows stay bright. Bolding the
              // unread ones alone was too small a difference to see.
              row.isUnread
                ? "font-semibold text-foreground"
                : "text-muted-foreground",
            )}
          >
            {row.title}
          </span>
          {row.isPinned ? (
            <Icon name="Pin" className="size-3 shrink-0 text-muted-foreground" />
          ) : null}
          <PullRequestBadge threadId={row.threadId} />
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {relativeTime(row.updatedAt)}
          </span>
          <RowMenu row={row} canSplit={split.isAvailable} />
        </div>
        {showProject || shownBranch !== null || row.tags.length > 0 ? (
          <div className="mt-1.5 flex items-center gap-1.5 pl-[1.125rem] text-xs text-muted-foreground">
            {showProject ? (
              <>
                <ProjectMark of={row} />
                <span className="shrink-0">{row.projectName}</span>
                {shownBranch === null ? null : <span aria-hidden>/</span>}
              </>
            ) : null}
            {shownBranch === null ? null : (
              <span className="truncate font-mono text-[11px]">
                {shownBranch}
              </span>
            )}
            {row.tags.map((tag) => (
              <span
                key={tag}
                className="shrink-0 rounded bg-muted px-1 text-[10px] leading-4"
              >
                {tag}
              </span>
            ))}
          </div>
        ) : null}
        {row.blockedOn !== null ? (
          <p className="mt-1.5 truncate pl-[1.125rem] text-xs text-muted-foreground">
            <span className="text-destructive/80">Waiting on you</span>
            {" · "}
            {row.blockedOn}
          </p>
        ) : row.note !== null ? (
          <p className="mt-1.5 truncate pl-[1.125rem] text-xs text-muted-foreground">
            {row.note}
          </p>
        ) : null}
      </div>
    </li>
  );
}

/** The search box, with the project picker that opens on `[`. */
function SearchBar({
  value,
  onChange,
  projectNames,
  inputRef,
  onSubmit,
}: {
  value: string;
  onChange: (next: string) => void;
  projectNames: readonly string[];
  inputRef: RefObject<HTMLInputElement | null>;
  onSubmit: () => void;
}) {
  const parsed = useMemo(() => parseQuery(value), [value]);
  const suggestions = useMemo(
    () => projectSuggestions(projectNames, parsed.partialProject),
    [projectNames, parsed.partialProject],
  );
  const [highlighted, setHighlighted] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => setHighlighted(0), [value]);
  useEffect(() => setDismissed(false), [parsed.partialProject === null]);
  const open = suggestions.length > 0 && !dismissed;

  const complete = (name: string) => {
    const tagStart = value.lastIndexOf("[");
    const head = tagStart === -1 ? value : value.slice(0, tagStart);
    onChange(`${head}[${name}] `);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Arrows move the list even while the caret is in the box, so search and
    // pick is one uninterrupted motion.
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!open) return;
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setHighlighted(
        (at) => (at + step + suggestions.length) % suggestions.length,
      );
      return;
    }
    if (open && (event.key === "Enter" || event.key === "Tab")) {
      event.preventDefault();
      complete(suggestions[highlighted] ?? suggestions[0]!);
      return;
    }
    // With no suggestion to take, Enter means "I am done typing this filter":
    // commit it and hand over the list, so the arrow keys work straight away.
    if (event.key === "Enter") {
      event.preventDefault();
      onSubmit();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (open) setDismissed(true);
      else if (value !== "") onChange("");
      else inputRef.current?.blur();
    }
  };

  return (
    <div className="relative">
      <Icon
        name="Search"
        className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        ref={inputRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={SEARCH_PLACEHOLDER}
        aria-label="Find a thread"
        className="h-8 pl-8 pr-8 text-sm"
      />
      {value === "" ? (
        <kbd
          aria-hidden
          className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-border px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted-foreground"
        >
          /
        </kbd>
      ) : (
        <Button
          variant="ghost"
          size="icon"
          className="absolute right-1 top-1/2 size-6 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          aria-label="Clear the search"
          onClick={() => onChange("")}
        >
          <Icon name="X" className="size-3.5" />
        </Button>
      )}
      {open ? (
        <ul className="absolute left-0 top-9 z-20 w-full overflow-hidden rounded-md border border-border bg-card py-1 shadow-md">
          {suggestions.map((name, index) => (
            <li key={name}>
              <button
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  complete(name);
                }}
                className={cn(
                  "w-full px-3 py-1.5 text-left text-sm",
                  index === highlighted && "bg-muted",
                )}
              >
                {name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const MENU_ITEM =
  "flex cursor-pointer items-center justify-between gap-6 rounded px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-muted";

/**
 * Organize and Sort by, in bb's own sidebar wording so the two surfaces do not
 * teach different words. What differs is the default: the deck groups by state,
 * which is the question it exists to answer.
 */
function DisplayMenu({
  display,
  onChange,
}: {
  display: Display;
  onChange: (next: Display) => void;
}) {
  const check = (on: boolean) =>
    on ? <Icon name="Check" className="size-3.5" /> : <span className="size-3.5" />;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
          aria-label="Organize and sort"
        >
          <Icon name="SlidersHorizontal" className="size-4" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-50 min-w-52 rounded-lg border border-border bg-card p-1 shadow-md"
        >
          <DropdownMenu.Label className="flex items-center justify-between px-2 py-1 text-xs text-muted-foreground">
            <span>Organize</span>
            <kbd className="font-mono text-[10px]">⌘⇧G</kbd>
          </DropdownMenu.Label>
          {(Object.keys(GROUP_BY_LABEL) as GroupBy[]).map((option) => (
            <DropdownMenu.Item
              key={option}
              className={MENU_ITEM}
              // Keeping the menu open makes trying two groupings one gesture
              // instead of four.
              onSelect={(event) => {
                event.preventDefault();
                onChange({ ...display, groupBy: option });
              }}
            >
              {GROUP_BY_LABEL[option]}
              {check(display.groupBy === option)}
            </DropdownMenu.Item>
          ))}

          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Label className="flex items-center justify-between px-2 py-1 text-xs text-muted-foreground">
            <span>Sort by</span>
            <kbd className="font-mono text-[10px]">⌘⇧S</kbd>
          </DropdownMenu.Label>
          {(Object.keys(SORT_BY_LABEL) as SortBy[]).map((option) => (
            <DropdownMenu.Item
              key={option}
              className={MENU_ITEM}
              onSelect={(event) => {
                event.preventDefault();
                onChange({ ...display, sortBy: option });
              }}
            >
              {SORT_BY_LABEL[option]}
              {check(display.sortBy === option)}
            </DropdownMenu.Item>
          ))}

          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Item
            className={MENU_ITEM}
            onSelect={(event) => {
              event.preventDefault();
              onChange({ ...display, unreadFirst: !display.unreadFirst });
            }}
          >
            Show unread first
            {check(display.unreadFirst)}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/**
 * The right-hand pane: the actual thread, rendered by bb. A hand-rolled "last
 * message plus a reply box" was a worse copy of a thing the host already does
 * properly, and it could not show a tool call, a diff, or an approval prompt.
 * The strip above it carries what the transcript does not: the agent's standing
 * note, what it is blocked on, the branch, the PR, and the tags.
 */
/**
 * The plugin's own settings page, under bb's declarative form. The declarative
 * field is a single line-per-project text blob: fine as storage, useless as a
 * UI, because it cannot show which projects exist, which already have a mark,
 * or where that mark was found.
 */
function Card({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card/40 p-4">
      <h4 className="text-sm font-medium">{title}</h4>
      <p className="mt-1 max-w-prose text-sm leading-relaxed text-muted-foreground">
        {hint}
      </p>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Chord({ chord }: { chord: string }) {
  return (
    <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] leading-4 text-foreground">
      {formatChord(chord)}
    </kbd>
  );
}

/** One action's chords, with a recorder that listens for the next keystroke. */
function BindingRow({
  action,
  chords,
  onChange,
}: {
  action: (typeof ACTIONS)[number];
  chords: string[];
  onChange: (next: string[]) => void;
}) {
  const [recording, setRecording] = useState(false);
  const isDefault =
    JSON.stringify(chords) === JSON.stringify(DEFAULT_BINDINGS[action.id]);

  return (
    <div className="flex items-center gap-3 py-2">
      <span className="min-w-0 flex-1 text-sm">{action.label}</span>
      <div className="flex shrink-0 items-center gap-1">
        {chords.length === 0 ? (
          <span className="text-xs text-muted-foreground">Unbound</span>
        ) : (
          chords.map((chord) => (
            <button
              key={chord}
              type="button"
              title="Remove this key"
              onClick={() => onChange(chords.filter((one) => one !== chord))}
              className="group/chord"
            >
              <Chord chord={chord} />
            </button>
          ))
        )}
      </div>
      <Button
        size="sm"
        variant={recording ? "default" : "ghost"}
        className="w-24 shrink-0"
        onKeyDown={(event) => {
          if (!recording) return;
          event.preventDefault();
          event.stopPropagation();
          if (event.key === "Escape") {
            setRecording(false);
            return;
          }
          // A lone modifier is the first half of a chord, not a chord.
          if (["Shift", "Meta", "Control", "Alt"].includes(event.key)) return;
          const chord = encodeChord(event.nativeEvent);
          if (isReserved(chord)) {
            toast.error(`${formatChord(chord)} belongs to bb or the system.`);
            setRecording(false);
            return;
          }
          onChange([...new Set([...chords, chord])].slice(0, 3));
          setRecording(false);
        }}
        onBlur={() => setRecording(false)}
        onClick={() => setRecording(true)}
      >
        {recording ? "Press a key" : "Add key"}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="w-16 shrink-0 text-muted-foreground"
        disabled={isDefault}
        onClick={() => onChange(DEFAULT_BINDINGS[action.id])}
      >
        Reset
      </Button>
    </div>
  );
}

function IconPicker({
  project,
  onPick,
}: {
  project: Project;
  onPick: (path: string) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [query, setQuery] = useState(project.iconOverride ?? "");
  const [paths, setPaths] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setBusy(true);
    const timer = setTimeout(() => {
      rpc.call("icon_candidates", { projectId: project.id, query }).then(
        (next) => {
          setPaths(next.paths);
          setBusy(false);
        },
        () => setBusy(false),
      );
    }, 180);
    return () => clearTimeout(timer);
  }, [rpc, project.id, query, open]);

  return (
    <div className="relative w-72 shrink-0">
      <Input
        value={query}
        placeholder="Search this project for an image"
        aria-label={`Icon for ${project.name}`}
        className="h-8 font-mono text-xs"
        onFocus={() => setOpen(true)}
        // A click inside the list fires before blur would close it, so the
        // close is deferred rather than immediate.
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onPick(query.trim());
            setOpen(false);
          }
          if (event.key === "Escape") setOpen(false);
        }}
      />
      {open ? (
        <div className="absolute right-0 top-9 z-20 max-h-64 w-96 overflow-y-auto rounded-lg border border-border bg-card py-1 shadow-md">
          {query.trim() !== "" ? (
            <button
              type="button"
              onMouseDown={(event) => {
                event.preventDefault();
                onPick("");
                setQuery("");
                setOpen(false);
              }}
              className="w-full px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted"
            >
              Clear, and go back to auto-detect
            </button>
          ) : null}
          {busy && paths.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">Looking…</p>
          ) : paths.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              No images match. Type part of a filename.
            </p>
          ) : (
            paths.map((path) => (
              <button
                key={path}
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  setQuery(path);
                  onPick(path);
                  setOpen(false);
                }}
                className="block w-full truncate px-3 py-1.5 text-left font-mono text-xs hover:bg-muted"
              >
                {path}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

function SettingsSection() {
  const rpc = useRpc<typeof rpcContract>();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [views, setViews] = useState<View[]>([]);
  const [saving, setSaving] = useState<string | null>(null);
  const [bindings, setBindings] = useState<Bindings>(DEFAULT_BINDINGS);

  const load = useCallback(() => {
    rpc.call("deck_get").then(
      (next) => {
        setProjects(next.projects);
        setViews(next.views);
        setBindings(resolveBindings(next.bindings));
      },
      () => setProjects([]),
    );
  }, [rpc]);
  useEffect(load, [load]);
  useRealtime("deck-changed", load);

  const save = (project: Project, path: string) => {
    setSaving(project.id);
    rpc.call("icon_override_set", { projectName: project.name, path }).then(
      (next) => {
        setProjects(next.projects);
        setSaving(null);
        toast.success(
          path.trim() === ""
            ? `Back to auto-detect for ${project.name}`
            : `Icon set for ${project.name}`,
        );
      },
      (cause: unknown) => {
        setSaving(null);
        toast.error(cause instanceof Error ? cause.message : String(cause));
      },
    );
  };

  if (projects === null) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  const setChords = (action: ActionId, chords: string[]) => {
    const next = { ...bindings, [action]: chords };
    setBindings(next);
    rpc.call("bindings_set", { bindings: next }).then(
      (saved) => setBindings(resolveBindings(saved.bindings)),
      () => toast.error("Could not save that key."),
    );
  };

  return (
    <div className="space-y-4">
      <Card
        title="Project marks"
        hint="Each project shows its own icon, found automatically in conventional places in its checkout. To use a different one, search that project's files and pick it. The search only covers the project itself, since a path outside it is not something this can store."
      >
        <ul className="divide-y divide-border">
          {projects.map((project) => (
            <li key={project.id} className="flex items-center gap-3 py-2.5">
              <ProjectMark
                of={{
                  projectName: project.name,
                  projectHue: project.hue,
                  projectIconUrl: project.iconUrl,
                }}
                className="size-6"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{project.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {!project.hasCheckout
                    ? "No checkout, so there is nowhere to look"
                    : project.iconSource === null
                      ? "No icon found"
                      : `${project.iconOverride === null ? "Found at" : "Set to"} ${project.iconSource}`}
                </p>
              </div>
              {project.hasCheckout ? (
                <IconPicker
                  project={project}
                  onPick={(path) => save(project, path)}
                />
              ) : null}
            </li>
          ))}
        </ul>
      </Card>

      <Card
        title="Saved views"
        hint="Save the search you are looking at from the Deck. The number keys jump to them, in this order."
      >
        {views.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            None yet.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {views.map((view, index) => (
              <li key={view.id} className="flex items-center gap-3 py-2.5">
                <Chord chord={String(index + 1)} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{view.name}</p>
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {view.query || "(everything)"} ·{" "}
                    {GROUP_BY_LABEL[view.display.groupBy]} ·{" "}
                    {SORT_BY_LABEL[view.display.sortBy]}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => {
                    rpc.call("view_delete", { id: view.id }).then(
                      (next) => setViews(next.views),
                      () => toast.error("Could not delete that view."),
                    );
                  }}
                >
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Keyboard"
        hint="bb owns the keyboard in its own sidebar, so Deck binds only these three, and only with a modifier — a bare letter would fire while you were typing. All three are also in bb's quick palette under Deck."
      >
        <div className="mt-1 divide-y divide-border">
          {ACTIONS.map((action) => (
            <BindingRow
              key={action.id}
              action={action}
              chords={bindings[action.id]}
              onChange={(chords) => setChords(action.id, chords)}
            />
          ))}
        </div>
      </Card>
    </div>
  );
}


/**
 * Deck's rows in bb's sidebar.
 *
 * Deliberately not the page in miniature. The last attempt put the filter bar,
 * the organize menu and saved views into a 300px column and made both surfaces
 * worse: the sidebar is a browser, the page is a workspace. So this is the row
 * treatment and the grouping, and nothing else — search and views stay on the
 * page, one keystroke away.
 *
 * bb owns the on/off switch for this (Settings → Appearance), so there is no
 * setting here to disagree with it.
 */
function SidebarList({ activeThreadId, onNavigate }: PluginThreadListProps) {
  const { threads, projects: hostProjects } = useSidebarThreads();
  const {
    rpc,
    meta,
    views,
    projects,
    display,
    session,
    bindings,
    changeDisplay,
    changeSession,
    setViews,
  } = useDeck();
  const actions = useSidebarThreadActions();
  const rows = useRows(threads, hostProjects, projects, meta);
  // The same grammar the page used, so [project], is:, #1284 and a branch name
  // all work out here too. A lookalike box that only matched titles would be a
  // worse lie than no box at all.
  //
  // The text lives in the persisted session rather than in local state: this
  // list is mounted and unmounted by bb as you move around, and a filter that
  // emptied itself every time you came back would make a saved view the only
  // way to hold a search.
  const text = session.query;
  const setText = useCallback(
    (next: string) => changeSession({ ...session, query: next }),
    [changeSession, session],
  );
  const inputRef = useRef<HTMLInputElement | null>(null);
  const query = useMemo(() => parseQuery(text), [text]);
  const matching = useMemo(
    () => rows.filter((row) => matches(row, query)),
    [rows, query],
  );
  const groups = useMemo(
    () => groupRows(matching, display),
    [matching, display],
  );
  const projectNames = useMemo(
    () => projects.map((project) => project.name),
    [projects],
  );
  const folded = useMemo(
    () => new Set(session.folded),
    [session.folded],
  );
  const toggleFold = useCallback(
    (key: string) => {
      const next = new Set(session.folded);
      if (!next.delete(key)) next.add(key);
      changeSession({ ...session, folded: [...next] });
    },
    [changeSession, session],
  );
  const byProject = display.groupBy === "project";

  const runDisplayCommand = useCallback(
    (kind: DisplayCommand) => {
      if (kind === "groupBy") {
        changeDisplay({ ...display, groupBy: cycleGroupBy(display.groupBy) });
      } else if (kind === "sortBy") {
        changeDisplay({ ...display, sortBy: cycleSortBy(display.sortBy) });
      } else {
        changeDisplay({ ...display, unreadFirst: !display.unreadFirst });
      }
    },
    [changeDisplay, display],
  );

  // Commands from bb's quick palette land here, where there is a hook to use.
  useEffect(
    () => displayCommands.subscribe(runDisplayCommand),
    [runDisplayCommand],
  );

  // ...and the same three as keys. Only modified chords: Deck no longer owns a
  // surface that holds the caret, so a bare letter would fire while you type in
  // bb's composer.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const action = lookup(bindings, encodeChord(event), "global");
      if (action === null) return;
      event.preventDefault();
      runDisplayCommand(
        action === "group-cycle"
          ? "groupBy"
          : action === "sort-cycle"
            ? "sortBy"
            : "unreadFirst",
      );
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [bindings, runDisplayCommand]);

  // Deep search runs only when the live list comes up short, so the common case
  // stays instant and finished work is still reachable — most of the board is
  // done, and the sidebar's own threads cannot see any of it.
  const [deepHits, setDeepHits] = useState<Hit[]>([]);
  const thin = query.text.length >= 2 && matching.length < 5;
  useEffect(() => {
    if (!thin) {
      setDeepHits([]);
      return;
    }
    const timer = setTimeout(() => {
      rpc.call("search_deep", { text: query.text }).then(
        (next) => setDeepHits(next.hits),
        () => setDeepHits([]),
      );
    }, 250);
    return () => clearTimeout(timer);
  }, [rpc, thin, query.text]);
  const known = useMemo(
    () => new Set(matching.map((row) => row.threadId)),
    [matching],
  );
  const extraHits = useMemo(
    () => deepHits.filter((hit) => !known.has(hit.threadId)),
    [deepHits, known],
  );

  const saveView = () => {
    const name = window.prompt("Name this view", "")?.trim();
    if (name === undefined || name === "") return;
    rpc.call("view_save", { name, query: text, display }).then(
      (next) => {
        setViews(next.views);
        toast.success(`Saved "${name}"`);
      },
      (cause: unknown) => {
        toast.error(cause instanceof Error ? cause.message : String(cause));
      },
    );
  };

  const open = (threadId: string) => {
    actions.open(threadId);
    onNavigate();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Paint bb's own sidebar surface, not --background: that one is the main
          area's colour, so naming it gave an opaque band in the wrong shade.
          There is no bg-sidebar utility in this build — Tailwind only emits
          utilities for tokens it knows, and --sidebar is bb's — so take the
          variable directly. */}
      <div className="sticky top-0 z-20 flex shrink-0 flex-col gap-1 bg-[var(--sidebar,var(--background))] px-2 pb-1 pt-1">
        <SearchBar
          value={text}
          onChange={setText}
          projectNames={projectNames}
          inputRef={inputRef}
          onSubmit={() => inputRef.current?.blur()}
        />
        {views.length === 0 && text.trim() === "" ? null : (
          <div className="flex flex-wrap items-center gap-1">
            {views.map((view, index) => (
              <button
                key={view.id}
                type="button"
                onClick={() => {
                  setText(view.query);
                  changeDisplay(view.display);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  rpc.call("view_delete", { id: view.id }).then(
                    (next) => setViews(next.views),
                    () => undefined,
                  );
                }}
                title={`${view.query}  (right-click to delete)`}
                className={cn(
                  "rounded px-1.5 py-0.5 text-xs",
                  view.query === text
                    ? "bg-foreground text-background"
                    : "bg-muted text-muted-foreground hover:text-foreground",
                )}
              >
                <span className="mr-1 font-mono text-[10px] opacity-60">
                  {index + 1}
                </span>
                {view.name}
              </button>
            ))}
            {text.trim() === "" ? null : (
              <button
                type="button"
                onClick={saveView}
                className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
              >
                + save view
              </button>
            )}
          </div>
        )}
      </div>
      <ul className="flex min-h-0 flex-1 flex-col overflow-y-auto py-1">
        {groups.map((group) => (
          <div key={group.key}>
            <li
              role="button"
              tabIndex={-1}
              onClick={() => toggleFold(group.key)}
              className="sticky top-0 z-10 mt-1 flex cursor-pointer select-none items-center gap-1.5 bg-[var(--sidebar,var(--background))] px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
            >
              <Icon
                name={folded.has(group.key) ? "ChevronRight" : "ChevronDown"}
                className="size-3 shrink-0"
                aria-hidden
              />
              {group.key.startsWith("p:") && group.rows[0] !== undefined ? (
                <ProjectMark of={group.rows[0]} className="size-3.5" />
              ) : null}
              <span>{group.label}</span>
              <span className="tabular-nums opacity-60">
                {group.rows.length}
              </span>
            </li>
            {(folded.has(group.key) ? [] : nestRows(group.rows)).map(
              ({ row, depth }) => (
                <ThreadRow
                  key={row.threadId}
                  row={row}
                  selected={row.threadId === activeThreadId}
                  // The sidebar never holds the caret: bb owns focus out here,
                  // and drawing a focus ring we do not own would be a lie.
                  active={false}
                  showProject={!byProject}
                  depth={depth}
                  onSelect={() => open(row.threadId)}
                  onOpen={() => open(row.threadId)}
                />
              ),
            )}
          </div>
        ))}
        {matching.length === 0 && extraHits.length === 0 ? (
          <li className="px-3 py-6 text-center text-xs text-muted-foreground">
            Nothing matches.
          </li>
        ) : null}
        {extraHits.length === 0 ? null : (
          <>
            <li className="sticky top-0 z-10 mt-1 bg-[var(--sidebar,var(--background))] px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Also in the archive
            </li>
            {extraHits.map((hit) => (
              <li key={hit.threadId}>
                <button
                  type="button"
                  onClick={() => open(hit.threadId)}
                  className="w-full px-3 py-2 text-left hover:bg-muted/50"
                >
                  <span className="block truncate text-sm text-muted-foreground">
                    {hit.title}
                  </span>
                  {hit.snippet === "" ? null : (
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground/70">
                      {hit.snippet}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </>
        )}
      </ul>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "settings",
    title: "Deck",
    description:
      "Project marks, saved views, and every key the Deck binds.",
    component: SettingsSection,
  });
  // bb owns thread detail now, so Deck has no page of its own. Its commands
  // live in bb's quick palette (Mod+Shift+P) instead of a keymap that would
  // fight the host for focus in a sidebar the host owns.
  app.slots.commandPaletteAction({
    id: "cycle-grouping",
    title: "Deck: cycle grouping",
    run: () => cycleDisplay("groupBy"),
  });
  app.slots.commandPaletteAction({
    id: "cycle-sorting",
    title: "Deck: cycle sorting",
    run: () => cycleDisplay("sortBy"),
  });
  app.slots.commandPaletteAction({
    id: "unread-first",
    title: "Deck: toggle unread first",
    run: () => cycleDisplay("unreadFirst"),
  });
  // Exclusive slot: registering it makes Deck's rows the sidebar list while the
  // plugin is enabled. bb owns the choice under Settings → Appearance, and
  // falls back to its own list if this one is absent or throws.
  app.slots.experimental_threadList({
    id: "deck-threads",
    title: "Deck",
    description:
      "Deck's rows: bb's own working and needs-you indicators, grouped the way the Deck page is grouped.",
    component: SidebarList,
  });
});
