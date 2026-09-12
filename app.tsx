// bb-plugin-inbox — frontend entry.
//
// The inbox. One searchable list of threads on the left, the context you need
// to answer one of them on the right. No columns and nothing to drag: a
// thread's state is read off the thread, so the only thing you do here is
// find the right one, remember what it was, say something, and move on.
//
// The list itself is the host's own live thread data, so it never goes stale
// and costs no round trip. The backend only supplies what the host does not:
// tags, the agent's standing note, saved views, and search that reaches
// archived threads and message bodies.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, RefObject } from "react";
import {
  ThreadChat,
  definePluginApp,
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  experimental_useSidebarThreadPullRequest as useSidebarThreadPullRequest,
  experimental_useSidebarThreads as useSidebarThreads,
  useBbNavigate,
  useRealtime,
  useRpc,
  type PluginNavPanelProps,
  type PluginSidebarThread,
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
  GROUP_BY_LABEL,
  parseDisplay,
  SORT_BY_LABEL,
  displayBranch,
  cycleGroupBy,
  cycleSortBy,
  groupRows,
  type Display,
  type GroupBy,
  type Groupable,
  type SortBy,
} from "@/lib/display";
import { colorForHue, projectInitials } from "@/lib/project-visuals";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** A thread as the inbox sees it: host truth plus what this plugin knows. */
interface Row extends Matchable, Groupable {
  projectId: string;
  projectHue: number;
  projectIconUrl: string | null;
  blockedOn: string | null;
}

/**
 * Every key the Inbox binds, in one place. The overlay renders from this, so
 * the cheatsheet cannot drift from the handler.
 */
const SHORTCUTS: { keys: string; does: string }[] = [
  { keys: "↑ ↓  or  j k", does: "Move between threads" },
  { keys: "⇧↑ ⇧↓", does: "Move, from inside the message box" },
  { keys: "Tab", does: "Write: focus the message box" },
  { keys: "Esc", does: "Back to the list" },
  { keys: "/", does: "Search" },
  { keys: "⏎", does: "Open the thread" },
  { keys: "o", does: "Open it in a split" },
  { keys: "e", does: "Archive" },
  { keys: "u", does: "Undo the last archive" },
  { keys: "p", does: "Pin or unpin" },
  { keys: "m", does: "Mark read or unread" },
  { keys: ".", does: "Open the pull request" },
  { keys: "g", does: "Cycle grouping  (⌘⇧G anywhere)" },
  { keys: "s", does: "Cycle sorting  (⌘⇧S anywhere)" },
  { keys: "f", does: "Toggle unread first" },
  { keys: "v", does: "Save this search as a view" },
  { keys: "x", does: "Delete the view you are in" },
  { keys: "1 - 9", does: "Jump to a saved view" },
  { keys: "[ ]", does: "Narrow or widen the list  (\\ resets)" },
  { keys: "←", does: "Up to the group header, then fold it" },
  { keys: "→", does: "Unfold the group header you are on" },
  { keys: "c", does: "Toggle the group you are in" },
  { keys: "?", does: "This list" },
];

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
  // deriving from it keeps the inbox agreeing with the sidebar for free.
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

interface InboxData {
  meta: Meta[];
  views: View[];
  projects: Project[];
  display: Display;
}

const CACHE_KEY = "bb-plugin-inbox:cache:1";
const COLLAPSED_KEY = "bb-plugin-inbox:collapsed:1";

/**
 * The last payload, read synchronously so the very first paint already has
 * project icons, saved views and the grouping. Without it the list renders
 * once with initials and default grouping, then again a round trip later,
 * which is the flicker.
 */
function readCache(): InboxData | null {
  try {
    const raw = globalThis.localStorage?.getItem(CACHE_KEY);
    if (raw == null) return null;
    const parsed = JSON.parse(raw) as Partial<InboxData>;
    if (!Array.isArray(parsed.projects)) return null;
    return {
      meta: Array.isArray(parsed.meta) ? parsed.meta : [],
      views: Array.isArray(parsed.views) ? parsed.views : [],
      projects: parsed.projects,
      display: parseDisplay(parsed.display),
    };
  } catch {
    return null;
  }
}

function useInbox() {
  const rpc = useRpc<typeof rpcContract>();
  const cached = useRef(readCache()).current;
  const [meta, setMeta] = useState<Meta[]>(cached?.meta ?? []);
  const [views, setViews] = useState<View[]>(cached?.views ?? []);
  const [projects, setProjects] = useState<Project[]>(cached?.projects ?? []);
  const [display, setDisplay] = useState<Display>(
    cached?.display ?? DEFAULT_DISPLAY,
  );
  // The server is authoritative until the first load lands; after that the
  // window owns its own display so a refetch cannot yank a setting back.
  const loaded = useRef(false);
  const cacheKeyRef = useRef<string>("");

  const refetch = useCallback(() => {
    rpc.call("inbox_get").then(
      (next) => {
        setMeta(next.meta);
        setViews(next.views);
        setProjects(next.projects);
        if (!loaded.current) {
          setDisplay(next.display);
          loaded.current = true;
        }
        // Only write when something actually moved, so a realtime signal does
        // not churn storage on every keystroke elsewhere in the app.
        const encoded = JSON.stringify(next);
        if (encoded !== cacheKeyRef.current) {
          cacheKeyRef.current = encoded;
          try {
            globalThis.localStorage?.setItem(CACHE_KEY, encoded);
          } catch {
            // A browser with storage off still works, just without the
            // instant first paint.
          }
        }
      },
      (cause: unknown) => {
        toast.error(cause instanceof Error ? cause.message : String(cause));
      },
    );
  }, [rpc]);

  useEffect(refetch, [refetch]);
  useRealtime("inbox-changed", refetch);

  const changeDisplay = useCallback(
    (next: Display) => {
      setDisplay(next);
      rpc.call("display_set", next).catch(() => {
        toast.error("Could not save that display setting.");
      });
    },
    [rpc],
  );

  return {
    rpc,
    meta,
    views,
    projects,
    display,
    changeDisplay,
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

function ThreadRow({
  row,
  selected,
  active,
  showProject,
  onSelect,
  onOpen,
}: {
  row: Row;
  selected: boolean;
  /** True when the list itself holds the caret. */
  active: boolean;
  /** False under a project group, where the header already says which one. */
  showProject: boolean;
  onSelect: () => void;
  onOpen: () => void;
}) {
  // bb names a worktree branch after the thread, so most branches here are the
  // title in kebab-case with the thread id on the end. Those say nothing the
  // title has not; a branch someone chose does.
  const shownBranch = displayBranch(row.branchName, row.threadId);
  return (
    <li>
      <div
        id={`row-${row.threadId}`}
        role="option"
        aria-selected={selected}
        tabIndex={-1}
        onClick={onSelect}
        onDoubleClick={onOpen}
        className={cn(
          "cursor-pointer border-l-2 px-3 py-2.5 text-sm",
          selected
            ? active
              ? "border-foreground bg-muted"
              : "border-transparent bg-muted/50"
            : "border-transparent hover:bg-muted/50",
        )}
      >
        <div className="flex items-center gap-2.5">
          {row.state === "needs-me" ? (
            <span
              aria-label="Needs you"
              className="size-2 shrink-0 rounded-full bg-destructive"
            />
          ) : row.state === "working" ? (
            <span
              aria-label="Working"
              className="size-2 shrink-0 animate-pulse rounded-full bg-foreground"
            />
          ) : row.isUnread ? (
            <span
              aria-label="Unread"
              className="size-2 shrink-0 rounded-full bg-foreground"
            />
          ) : (
            <span aria-hidden className="size-2 shrink-0" />
          )}
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
          <p className="mt-1.5 pl-[1.125rem] text-xs text-destructive">
            Waiting on you: {row.blockedOn}
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
}: {
  value: string;
  onChange: (next: string) => void;
  projectNames: readonly string[];
  inputRef: RefObject<HTMLInputElement | null>;
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
 * teach different words. What differs is the default: the inbox groups by state,
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
function ThreadPane({
  row,
  focusRequest,
  onPullRequest,
}: {
  row: Row | null;
  focusRequest: number;
  onPullRequest: (url: string | null) => void;
}) {
  const pullRequest = useSidebarThreadPullRequest(row?.threadId ?? "").pullRequest;
  const navigate = useBbNavigate();
  useEffect(() => {
    onPullRequest(pullRequest?.url ?? null);
  }, [pullRequest, onPullRequest]);

  if (row === null) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        Nothing selected.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border px-4 py-2.5">
        <h2 className="truncate text-sm font-medium">{row.title}</h2>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <ProjectMark of={row} />
          <span>{row.projectName}</span>
          {row.branchName === null ? null : (
            <span className="font-mono text-[11px]">{row.branchName}</span>
          )}
          {pullRequest === null ? null : (
            <button
              type="button"
              onClick={() => navigate.openUrl(pullRequest.url)}
              className="font-mono text-[11px] underline-offset-2 hover:underline"
            >
              #{pullRequest.number} {pullRequest.state}
            </button>
          )}
          {row.tags.map((tag) => (
            <span key={tag} className="rounded bg-muted px-1 text-[10px] leading-4">
              {tag}
            </span>
          ))}
        </div>
        {row.blockedOn !== null ? (
          <p className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
            Waiting on you: {row.blockedOn}
          </p>
        ) : row.note !== null ? (
          <p className="mt-2 text-xs text-muted-foreground">{row.note}</p>
        ) : null}
      </div>
      <div className="min-h-0 flex-1">
        <ThreadChat
          // Deliberately NOT keyed on the thread: remounting per selection
          // throws the caret away, and the caret staying put while you walk
          // threads is the entire point of the shift-arrow keys.
          threadId={row.threadId}
          variant="compact"
          focusRequest={focusRequest}
          className="h-full"
        />
      </div>
    </div>
  );
}

function InboxPage({ subPath }: PluginNavPanelProps) {
  const { threads, projects: hostProjects } = useSidebarThreads();
  const actions = useSidebarThreadActions();
  const { rpc, meta, views, projects, display, changeDisplay, setViews } =
    useInbox();
  const [text, setText] = useState(() =>
    subPath === "" ? "" : decodeURIComponent(subPath),
  );
  // The cursor walks headers AND rows, the way a tree does: a folded group has
  // no rows to land on, so its header has to be a stop or you can never reopen
  // it from the keyboard.
  const [cursor, setCursor] = useState<
    { kind: "group"; key: string } | { kind: "row"; threadId: string } | null
  >(null);
  const [deepHits, setDeepHits] = useState<Hit[]>([]);
  const [sheetOpen, setSheetOpen] = useState(false);
  // Which side holds the caret. Without a cue you cannot tell whether the next
  // arrow key moves the list or edits a message.
  const [focusSide, setFocusSide] = useState<"list" | "chat">("list");
  // Collapsed group keys, per grouping mode: the groups you fold under "by
  // project" are not the ones you fold under "by day".
  const [collapsed, setCollapsed] = useState<Record<string, string[]>>(() => {
    try {
      const raw = globalThis.localStorage?.getItem(COLLAPSED_KEY);
      return raw == null ? {} : (JSON.parse(raw) as Record<string, string[]>);
    } catch {
      return {};
    }
  });
  /** Threads archived from here, newest last. `u` pops one back. */
  const archived = useRef<string[]>([]);
  /** The group the fold key last shut, so the unfold key can reopen it. */
  const lastFolded = useRef<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // Bumping this is how the host is asked to put the caret in the composer.
  const [focusRequest, setFocusRequest] = useState(0);
  const splitRef = useRef<HTMLDivElement>(null);
  /** Filled by the pane, which is where the PR lookup already lives. */
  const pullRequestUrl = useRef<string | null>(null);
  const { width, dragging, startDrag, clamp, commit } = useListWidth(splitRef);
  const navigate = useBbNavigate();

  const query = useMemo(() => parseQuery(text), [text]);

  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project] as const)),
    [projects],
  );
  const metaById = useMemo(
    () => new Map(meta.map((entry) => [entry.threadId, entry] as const)),
    [meta],
  );

  const rows = useMemo<Row[]>(() => {
    return threads.map((thread) => {
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
        branchName: thread.environment?.branchName ?? null,
        prNumber: null,
        prTitle: null,
        tags: own?.tags ?? [],
        note: own?.note ?? null,
        blockedOn: own?.blockedOn ?? null,
        state: stateOf(thread, own?.blockedOn ?? null),
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        isUnread: thread.isUnread,
        isPinned: thread.isPinned,
      };
    });
  }, [threads, projectById, metaById, hostProjects]);

  const matching = useMemo(
    () => rows.filter((row) => matches(row, query)),
    [rows, query],
  );
  const groups = useMemo(
    () => groupRows(matching, display),
    [matching, display],
  );

  const folded = useMemo(
    () => new Set(collapsed[display.groupBy] ?? []),
    [collapsed, display.groupBy],
  );
  const toggleGroup = useCallback(
    (key: string, force?: boolean) => {
      setCollapsed((current) => {
        const mode = display.groupBy;
        const set = new Set(current[mode] ?? []);
        const shut = force ?? !set.has(key);
        if (shut) set.add(key);
        else set.delete(key);
        const next = { ...current, [mode]: [...set] };
        try {
          globalThis.localStorage?.setItem(COLLAPSED_KEY, JSON.stringify(next));
        } catch {
          // Folding still works for this session without storage.
        }
        return next;
      });
    },
    [display.groupBy],
  );

  // The flat order the keyboard walks, which has to be the order on screen:
  // a folded group's rows are not reachable with the arrow keys either.
  const visible = useMemo(
    () =>
      groups.flatMap((group) => (folded.has(group.key) ? [] : group.rows)),
    [groups, folded],
  );

  // Deep search runs only when the local list comes up short, so the common
  // case stays instant and the archive is still reachable.
  const thin = query.text.length >= 2 && visible.length < 5;
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
    () => new Set(visible.map((row) => row.threadId)),
    [visible],
  );
  const extraHits = useMemo(
    () => deepHits.filter((hit) => !known.has(hit.threadId)),
    [deepHits, known],
  );

  /** Headers and their visible rows, in screen order: what the arrows walk. */
  const navigable = useMemo(
    () =>
      groups.flatMap((group) => [
        { kind: "group" as const, key: group.key },
        ...(folded.has(group.key)
          ? []
          : group.rows.map((row) => ({ kind: "row" as const, row }))),
      ]),
    [groups, folded],
  );

  const cursorAt = useMemo(() => {
    const index = navigable.findIndex((item) =>
      cursor === null
        ? false
        : item.kind === "group"
          ? cursor.kind === "group" && item.key === cursor.key
          : cursor.kind === "row" && item.row.threadId === cursor.threadId,
    );
    return index === -1 ? 0 : index;
  }, [navigable, cursor]);

  /**
   * The thread the pane shows. It holds the last row the cursor was on, so
   * stepping onto a group header does not blank the conversation beside it.
   */
  const [shownId, setShownId] = useState<string | null>(null);
  const here = navigable[cursorAt];
  useEffect(() => {
    if (here?.kind === "row") setShownId(here.row.threadId);
  }, [here]);
  const selected = useMemo(
    () =>
      visible.find((row) => row.threadId === shownId) ??
      (here?.kind === "row" ? here.row : null) ??
      visible[0] ??
      null,
    [visible, shownId, here],
  );
  const cursorRow = here?.kind === "row" ? here.row : null;
  const cursorGroup =
    here?.kind === "group"
      ? here.key
      : here?.kind === "row"
        ? groups.find((group) =>
            group.rows.some((row) => row.threadId === here.row.threadId),
          )?.key ?? null
        : null;

  // Keep the URL in step so back/forward walks searches.
  const lastPushed = useRef(text);
  useEffect(() => {
    if (lastPushed.current === text) return;
    const timer = setTimeout(() => {
      lastPushed.current = text;
      navigate.toPluginPanel("inbox", {
        subPath: encodeURIComponent(text),
        replace: true,
      });
    }, 400);
    return () => clearTimeout(timer);
  }, [text, navigate]);

  const move = useCallback(
    (step: number) => {
      if (navigable.length === 0) return;
      const next = Math.min(
        Math.max(cursorAt + step, 0),
        navigable.length - 1,
      );
      const item = navigable[next]!;
      setCursor(
        item.kind === "group"
          ? { kind: "group", key: item.key }
          : { kind: "row", threadId: item.row.threadId },
      );
      const id = item.kind === "group" ? `group-${item.key}` : `row-${item.row.threadId}`;
      document.getElementById(id)?.scrollIntoView({ block: "nearest" });
    },
    [navigable, cursorAt],
  );

  const saveView = useCallback(() => {
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
  }, [rpc, text, display, setViews]);

  const resizeList = useCallback(
    (delta: number | null) => {
      commit(clamp(delta === null ? LIST_WIDTH_DEFAULT : width + delta));
    },
    [clamp, commit, width],
  );

  const openPullRequest = useCallback(() => {
    if (pullRequestUrl.current === null) {
      toast("No pull request on this thread.");
      return;
    }
    navigate.openUrl(pullRequestUrl.current);
  }, [navigate]);

  const focusList = useCallback(() => {
    composerWanted.current = false;
    listRef.current?.focus();
  }, []);
  // The panel opens with the list focused, so the first arrow key works
  // without touching the mouse.
  useEffect(focusList, [focusList]);
  /**
   * False unless you asked for the composer with Tab. The host's chat takes
   * focus for itself when its thread changes, which reads as the arrow keys
   * dying mid-navigation, so after every selection change we take it back
   * unless you actually asked to write.
   */
  const composerWanted = useRef(false);
  const focusComposer = useCallback(() => {
    composerWanted.current = true;
    setFocusRequest((at) => at + 1);
  }, []);
  const shownThreadId = selected?.threadId ?? null;
  useEffect(() => {
    if (composerWanted.current || shownThreadId === null) return;
    const timer = setTimeout(() => {
      if (!composerWanted.current) listRef.current?.focus();
    }, 120);
    return () => clearTimeout(timer);
  }, [shownThreadId]);


  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      // Organize and sort are on mod+shift so they still land while you are
      // typing. Both chords are unbound in bb, checked against
      // `bb settings keyboard list`.
      if ((event.metaKey || event.ctrlKey) && event.shiftKey) {
        const letter = event.key.toLowerCase();
        if (letter === "g") {
          event.preventDefault();
          const groupBy = cycleGroupBy(display.groupBy);
          changeDisplay({ ...display, groupBy });
          toast.success(GROUP_BY_LABEL[groupBy]);
          return;
        }
        if (letter === "s") {
          event.preventDefault();
          const sortBy = cycleSortBy(display.sortBy);
          changeDisplay({ ...display, sortBy });
          toast.success(SORT_BY_LABEL[sortBy]);
          return;
        }
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // Any key dismisses the cheatsheet, which is the only thing it should do
      // while it is up.
      if (sheetOpen) {
        event.preventDefault();
        setSheetOpen(false);
        return;
      }

      // Shift+arrows walk threads from ANYWHERE in the panel, including mid
      // sentence in the composer. That is the whole point: changing which
      // thread you are answering should not cost you the caret.
      const typing = isTypingTarget(event.target);
      const inSearch = event.target === searchRef.current;

      // Shift+arrows reach the list from inside the composer, and land you
      // back in the list rather than holding the caret. Keeping the caret in
      // the composer was tried and it steals the plain arrow keys: once you
      // are navigating, navigation is what the arrows should do.
      if (event.shiftKey && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault();
        move(event.key === "ArrowDown" ? 1 : -1);
        if (typing) focusList();
        return;
      }

      if (typing) {
        // Tab from the search box continues into the composer rather than
        // walking the browser's focus order through every control.
        if (inSearch && event.key === "Tab" && !event.shiftKey) {
          event.preventDefault();
          focusComposer();
          return;
        }
        // Escape anywhere you are typing comes back to the list, which is the
        // one key that always gets you home.
        if (event.key === "Escape" && !inSearch) {
          event.preventDefault();
          focusList();
          return;
        }
        if (
          inSearch &&
          (event.key === "ArrowDown" || event.key === "ArrowUp") &&
          !event.defaultPrevented
        ) {
          event.preventDefault();
          move(event.key === "ArrowDown" ? 1 : -1);
        }
        return;
      }

      const key = event.key;
      // Escape returns to the list from anywhere that is not the search box,
      // including the chat's own buttons, which are not text fields.
      if (key === "Escape" && document.activeElement !== listRef.current) {
        event.preventDefault();
        focusList();
        return;
      }
      if (key === "Tab" && !event.shiftKey) {
        event.preventDefault();
        focusComposer();
        return;
      }
      if (key === "/") {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (key === "g" || key === "s") {
        event.preventDefault();
        const next =
          key === "g"
            ? { ...display, groupBy: cycleGroupBy(display.groupBy) }
            : { ...display, sortBy: cycleSortBy(display.sortBy) };
        changeDisplay(next);
        toast.success(
          key === "g" ? GROUP_BY_LABEL[next.groupBy] : SORT_BY_LABEL[next.sortBy],
        );
        return;
      }
      if (key === "j" || key === "ArrowDown") {
        event.preventDefault();
        move(1);
        return;
      }
      if (key === "k" || key === "ArrowUp") {
        event.preventDefault();
        move(-1);
        return;
      }
      // Inbox-wide keys come before the selection guard: with nothing matching
      // there is no selected row, and that is exactly when you need Escape and
      // the view keys to get you out again.
      if (key === "Escape") {
        if (text !== "") {
          event.preventDefault();
          setText("");
        }
        return;
      }
      if (/^[1-9]$/.test(key)) {
        const view = views[Number(key) - 1];
        if (view !== undefined) {
          event.preventDefault();
          setText(view.query);
          changeDisplay(view.display);
        }
        return;
      }

      if (key === "?") {
        event.preventDefault();
        setSheetOpen(true);
        return;
      }
      if (key === "ArrowLeft" || key === "ArrowRight" || key === "c") {
        if (cursorGroup === null) return;
        event.preventDefault();
        if (key === "c") {
          toggleGroup(cursorGroup);
          setCursor({ kind: "group", key: cursorGroup });
          return;
        }
        if (key === "ArrowRight") {
          // On a folded header this opens it. Anywhere else there is nothing
          // to the right, which is what a tree does too.
          if (folded.has(cursorGroup)) toggleGroup(cursorGroup, false);
          return;
        }
        // Left on a row climbs to its header, the way a tree does; left again
        // folds it. Two presses, each one obvious.
        if (cursorRow !== null) {
          setCursor({ kind: "group", key: cursorGroup });
          return;
        }
        toggleGroup(cursorGroup, true);
        return;
      }
      if (key === "f") {
        event.preventDefault();
        const unreadFirst = !display.unreadFirst;
        changeDisplay({ ...display, unreadFirst });
        toast.success(unreadFirst ? "Unread first" : "Unread in order");
        return;
      }
      if (key === "[" || key === "]" || key === "\\") {
        event.preventDefault();
        resizeList(key === "[" ? -48 : key === "]" ? 48 : null);
        return;
      }
      if (key === "u") {
        event.preventDefault();
        const last = archived.current.pop();
        if (last === undefined) {
          toast("Nothing to undo.");
          return;
        }
        rpc.call("thread_unarchive", { threadId: last }).then(
          () => toast.success("Restored"),
          () => toast.error("Could not restore that thread."),
        );
        return;
      }
      if (key === "v") {
        event.preventDefault();
        saveView();
        return;
      }
      if (key === "x") {
        event.preventDefault();
        const applied = views.find((view) => view.query === text);
        if (applied === undefined) {
          toast("You are not in a saved view.");
          return;
        }
        rpc.call("view_delete", { id: applied.id }).then(
          (next) => {
            setViews(next.views);
            toast.success(`Deleted "${applied.name}"`);
          },
          () => toast.error("Could not delete that view."),
        );
        return;
      }

      // Row actions need a row under the cursor, not merely something shown in
      // the pane: pressing archive on a group header should do nothing.
      if (cursorRow === null) return;
      const selected = cursorRow;
      if (key === "Enter") {
        event.preventDefault();
        actions.open(selected.threadId);
      } else if (key === "o") {
        event.preventDefault();
        actions.open(selected.threadId, { split: true });
      } else if (key === "e") {
        event.preventDefault();
        // The host archives and raises its own undo toast; `u` is the keyboard
        // path to the same thing, which is why the id goes on a stack here.
        archived.current.push(selected.threadId);
        actions.archive(selected.threadId);
      } else if (key === "p") {
        event.preventDefault();
        void actions.setPinned(selected.threadId, !selected.isPinned);
      } else if (key === "m") {
        event.preventDefault();
        const read = selected.isUnread;
        rpc
          .call("thread_read", { threadId: selected.threadId, read })
          .then(
            () => toast.success(read ? "Marked read" : "Marked unread"),
            () => toast.error("Could not change that."),
          );
      } else if (key === ".") {
        event.preventDefault();
        openPullRequest();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [
    move,
    selected,
    actions,
    views,
    text,
    display,
    changeDisplay,
    focusList,
    focusComposer,
    rpc,
    setViews,
    saveView,
    sheetOpen,
    resizeList,
    openPullRequest,
    groups,
    folded,
    toggleGroup,
    cursorRow,
    cursorGroup,
  ]);

  // A project group names its project once, in the header, so the rows under it
  // stop repeating it.
  const byProject = display.groupBy === "project";

  const counts = useMemo(() => {
    const tally: Record<State, number> = {
      "needs-me": 0,
      working: 0,
      idle: 0,
      done: 0,
    };
    for (const row of visible) tally[row.state] += 1;
    return tally;
  }, [visible]);

  return (
    <div
      ref={splitRef}
      onFocusCapture={(event) => {
        setFocusSide(
          listRef.current?.contains(event.target as Node) ? "list" : "chat",
        );
      }}
      className={cn(
        "relative flex h-full min-h-0 flex-1",
        // Killing selection while dragging stops the pointer from painting the
        // list blue as it crosses rows.
        dragging && "select-none",
      )}
    >
      <div
        style={{ width }}
        className={cn(
          "flex min-h-0 shrink-0 flex-col transition-colors",
          // The side without the caret recedes a hair. Subtle on purpose: it
          // has to be readable at a glance, not a spotlight.
          focusSide === "list" ? "bg-background" : "bg-muted/20",
        )}
      >
        <div className="space-y-2 border-b border-border px-3 py-2.5">
          <div className="flex items-center gap-1">
            <div className="min-w-0 flex-1">
              <SearchBar
                value={text}
                onChange={setText}
                projectNames={projects.map((project) => project.name)}
                inputRef={searchRef}
              />
            </div>
            <DisplayMenu display={display} onChange={changeDisplay} />
          </div>
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
                  rpc
                    .call("view_delete", { id: view.id })
                    .then((next) => setViews(next.views), () => undefined);
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
            <span className="ml-auto text-xs text-muted-foreground">
              {counts["needs-me"] > 0 ? (
                <span className="text-destructive">
                  {counts["needs-me"]} need you
                </span>
              ) : (
                `${visible.length} shown`
              )}
            </span>
          </div>
        </div>

        <ul
          ref={listRef}
          role="listbox"
          tabIndex={0}
          aria-label="Threads"
          aria-activedescendant={
            here === undefined
              ? undefined
              : here.kind === "group"
                ? `group-${here.key}`
                : `row-${here.row.threadId}`
          }
          className="min-h-0 flex-1 overflow-y-auto outline-none"
        >
          {groups.map((group) => (
            <div key={group.key}>
              <li
                role="button"
                tabIndex={-1}
                id={`group-${group.key}`}
                onClick={() => {
                  toggleGroup(group.key);
                  setCursor({ kind: "group", key: group.key });
                }}
                className={cn(
                  "sticky top-0 z-10 mt-1 flex cursor-pointer select-none items-center gap-1.5 border-l-2 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide backdrop-blur hover:text-foreground",
                  here?.kind === "group" && here.key === group.key
                    ? focusSide === "list"
                      ? "border-foreground bg-muted text-foreground"
                      : "border-transparent bg-muted/50 text-foreground"
                    : "border-transparent bg-card/95 text-muted-foreground",
                )}
              >
                <Icon
                  name={folded.has(group.key) ? "ChevronRight" : "ChevronDown"}
                  className="size-3 shrink-0"
                  aria-hidden
                />
                {/* Only real project buckets carry a mark. "Pinned" is a
                    group under every grouping, and stamping it with whichever
                    project happened to sort first would be a lie. */}
                {group.key.startsWith("p:") && group.rows[0] !== undefined ? (
                  <ProjectMark of={group.rows[0]} className="size-3.5" />
                ) : null}
                <span>{group.label}</span>
                <span className="tabular-nums opacity-60">
                  {group.rows.length}
                </span>
              </li>
              {(folded.has(group.key) ? [] : group.rows).map((row) => (
                <div key={row.threadId} data-thread={row.threadId}>
                  <ThreadRow
                    row={row}
                    selected={cursorRow?.threadId === row.threadId}
                    active={focusSide === "list"}
                    showProject={!byProject}
                    onSelect={() => setCursor({ kind: "row", threadId: row.threadId })}
                    onOpen={() => actions.open(row.threadId)}
                  />
                </div>
              ))}
            </div>
          ))}
          {visible.length === 0 ? (
            <li className="px-3 py-8 text-center text-sm text-muted-foreground">
              Nothing matches.
            </li>
          ) : null}
          {extraHits.length === 0 ? null : (
            <>
              <li className="sticky top-0 z-10 bg-card/95 px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground backdrop-blur">
                Also in the archive
              </li>
              {extraHits.map((hit) => (
                <li key={hit.threadId}>
                  <button
                    type="button"
                    onClick={() => actions.open(hit.threadId)}
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

        <div className="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
          <kbd className="font-mono">↑↓</kbd> move ·{" "}
          <kbd className="font-mono">tab</kbd> write ·{" "}
          <kbd className="font-mono">esc</kbd> list ·{" "}
          <kbd className="font-mono">/</kbd> find ·{" "}
          <kbd className="font-mono">⏎</kbd> open ·{" "}
          <kbd className="font-mono">e</kbd> done ·{" "}
          <kbd className="font-mono">u</kbd> undo ·{" "}
          <kbd className="font-mono">?</kbd> all keys
        </div>
      </div>

      <PaneHandle
        width={width}
        dragging={dragging}
        onStartDrag={startDrag}
        onNudge={(delta) => commit(clamp(width + delta))}
        onReset={() => commit(clamp(LIST_WIDTH_DEFAULT))}
      />

      {sheetOpen ? <ShortcutSheet onClose={() => setSheetOpen(false)} /> : null}

      <div
        className={cn(
          "min-h-0 flex-1 transition-colors",
          focusSide === "chat" ? "bg-background" : "bg-muted/20",
        )}
      >
        <ThreadPane
          row={selected}
          focusRequest={focusRequest}
          onPullRequest={(url) => {
            pullRequestUrl.current = url;
          }}
        />
      </div>
    </div>
  );
}

const LIST_WIDTH_KEY = "bb-plugin-inbox:list-width";
const LIST_WIDTH_DEFAULT = 416;
const LIST_WIDTH_MIN = 280;
/** Leave at least this much for the context pane, whatever the window size. */
const CONTEXT_WIDTH_MIN = 360;

/**
 * The list pane's width, remembered per device. localStorage rather than plugin
 * storage on purpose: the right split depends on the screen you are sitting at,
 * not on the account, and a laptop should not inherit a monitor's layout.
 */
function useListWidth(containerRef: RefObject<HTMLDivElement | null>) {
  const [width, setWidth] = useState(() => {
    const saved = Number(globalThis.localStorage?.getItem(LIST_WIDTH_KEY));
    return Number.isFinite(saved) && saved >= LIST_WIDTH_MIN
      ? saved
      : LIST_WIDTH_DEFAULT;
  });
  const [dragging, setDragging] = useState(false);

  const clamp = useCallback(
    (next: number) => {
      const total = containerRef.current?.clientWidth ?? Infinity;
      return Math.round(
        Math.min(Math.max(next, LIST_WIDTH_MIN), Math.max(LIST_WIDTH_MIN, total - CONTEXT_WIDTH_MIN)),
      );
    },
    [containerRef],
  );

  const commit = useCallback((next: number) => {
    setWidth(next);
    try {
      globalThis.localStorage?.setItem(LIST_WIDTH_KEY, String(next));
    } catch {
      // A browser with storage disabled still gets a working, unsaved split.
    }
  }, []);

  // The window can shrink below the split we remembered, so re-clamp on resize
  // rather than letting the context pane get squeezed to nothing.
  useEffect(() => {
    const onResize = () => setWidth((current) => clamp(current));
    globalThis.addEventListener("resize", onResize);
    return () => globalThis.removeEventListener("resize", onResize);
  }, [clamp]);

  /**
   * Drag from a pointerdown on the handle. The move and up listeners go on the
   * window, not the handle: the handle is one pixel wide, and a fast drag
   * leaves it behind long before the pointer stops.
   */
  const startDrag = useCallback(() => {
    setDragging(true);
    const onMove = (event: PointerEvent) => {
      const left = containerRef.current?.getBoundingClientRect().left ?? 0;
      setWidth(clamp(event.clientX - left));
    };
    const onUp = (event: PointerEvent) => {
      const left = containerRef.current?.getBoundingClientRect().left ?? 0;
      commit(clamp(event.clientX - left));
      setDragging(false);
      globalThis.removeEventListener("pointermove", onMove);
      globalThis.removeEventListener("pointerup", onUp);
      globalThis.removeEventListener("pointercancel", onUp);
    };
    globalThis.addEventListener("pointermove", onMove);
    globalThis.addEventListener("pointerup", onUp);
    globalThis.addEventListener("pointercancel", onUp);
  }, [clamp, commit, containerRef]);

  return { width, dragging, startDrag, clamp, commit };
}

function PaneHandle({
  width,
  dragging,
  onStartDrag,
  onNudge,
  onReset,
}: {
  width: number;
  dragging: boolean;
  onStartDrag: () => void;
  onNudge: (delta: number) => void;
  onReset: () => void;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the list"
      aria-valuenow={width}
      aria-valuemin={LIST_WIDTH_MIN}
      tabIndex={0}
      onPointerDown={(event) => {
        event.preventDefault();
        onStartDrag();
      }}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        // A separator you can only drag is one a keyboard user cannot move.
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          onNudge(event.shiftKey ? -64 : -16);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          onNudge(event.shiftKey ? 64 : 16);
        } else if (event.key === "Home") {
          event.preventDefault();
          onReset();
        }
      }}
      className={cn(
        "group relative w-px shrink-0 cursor-col-resize bg-border outline-none",
        "before:absolute before:inset-y-0 before:-left-1 before:-right-1 before:content-['']",
        dragging
          ? "bg-foreground/40"
          : "hover:bg-foreground/30 focus-visible:bg-foreground/40",
      )}
      title="Drag to resize, double-click to reset"
    />
  );
}

/**
 * The plugin's own settings page, under bb's declarative form. The declarative
 * field is a single line-per-project text blob: fine as storage, useless as a
 * UI, because it cannot show which projects exist, which already have a mark,
 * or where that mark was found.
 */
function SettingsSection() {
  const rpc = useRpc<typeof rpcContract>();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [views, setViews] = useState<View[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(() => {
    rpc.call("inbox_get").then(
      (next) => {
        setProjects(next.projects);
        setViews(next.views);
      },
      () => setProjects([]),
    );
  }, [rpc]);
  useEffect(load, [load]);
  useRealtime("inbox-changed", load);

  const save = (project: Project) => {
    const path = drafts[project.id] ?? project.iconOverride ?? "";
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

  return (
    <div className="space-y-6">
      <section>
        <h4 className="text-sm font-medium">Project icons</h4>
        <p className="mt-1 text-sm text-muted-foreground">
          Each project shows its own mark, found automatically in conventional
          places in its checkout, like{" "}
          <code className="text-xs">public/icon.svg</code> or{" "}
          <code className="text-xs">.github/logo.png</code>. Point one somewhere
          else with a path relative to the project root. Leave it empty to go
          back to auto-detect.
        </p>
        <ul className="mt-3 divide-y divide-border rounded-lg border border-border">
          {projects.map((project) => (
            <li key={project.id} className="flex items-center gap-3 p-3">
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
                      : project.iconOverride === null
                        ? `Found at ${project.iconSource}`
                        : `Set to ${project.iconSource}`}
                </p>
              </div>
              {project.hasCheckout ? (
                <>
                  <Input
                    value={drafts[project.id] ?? project.iconOverride ?? ""}
                    placeholder="public/icon.svg"
                    aria-label={`Icon path for ${project.name}`}
                    className="h-8 w-56 font-mono text-xs"
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [project.id]: event.target.value,
                      }))
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter") save(project);
                    }}
                  />
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={saving === project.id}
                    onClick={() => save(project)}
                  >
                    {saving === project.id ? "Saving…" : "Save"}
                  </Button>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h4 className="text-sm font-medium">Saved views</h4>
        <p className="mt-1 text-sm text-muted-foreground">
          Save one from the Inbox with <kbd className="font-mono text-xs">v</kbd>.
          Number keys jump to them, in this order.
        </p>
        {views.length === 0 ? (
          <p className="mt-3 rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            None yet.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-border rounded-lg border border-border">
            {views.map((view, index) => (
              <li key={view.id} className="flex items-center gap-3 p-3">
                <span className="w-4 shrink-0 font-mono text-xs text-muted-foreground">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{view.name}</p>
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {view.query || "(everything)"} · {GROUP_BY_LABEL[view.display.groupBy]} ·{" "}
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
      </section>

      <section>
        <h4 className="text-sm font-medium">Keyboard</h4>
        <dl className="mt-3 grid grid-cols-1 gap-x-8 gap-y-1.5 sm:grid-cols-2">
          {SHORTCUTS.map((shortcut) => (
            <div key={shortcut.keys} className="flex items-baseline gap-3 text-sm">
              <dt className="w-28 shrink-0 font-mono text-xs text-muted-foreground">
                {shortcut.keys}
              </dt>
              <dd className="min-w-0 flex-1">{shortcut.does}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}

function ShortcutSheet({ onClose }: { onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-label="Keyboard shortcuts"
      onClick={onClose}
      className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 p-6 backdrop-blur-sm"
    >
      <div className="max-h-full w-full max-w-md overflow-y-auto rounded-lg border border-border bg-card p-4 shadow-lg">
        <p className="mb-3 text-sm font-medium">Keyboard</p>
        <dl className="space-y-1.5">
          {SHORTCUTS.map((shortcut) => (
            <div key={shortcut.keys} className="flex items-baseline gap-3 text-sm">
              <dt className="w-32 shrink-0 font-mono text-xs text-muted-foreground">
                {shortcut.keys}
              </dt>
              <dd className="min-w-0 flex-1">{shortcut.does}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs text-muted-foreground">
          Any key closes this.
        </p>
      </div>
    </div>
  );
}

/** True when the keystroke belongs to something the user is typing into. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "settings",
    title: "Inbox",
    description:
      "Project marks, saved views, and every key the Inbox binds.",
    component: SettingsSection,
  });
  app.slots.navPanel({
    id: "inbox",
    title: "Inbox",
    icon: "ListTodo",
    path: "inbox",
    component: InboxPage,
  });
});
