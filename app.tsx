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
  SORT_BY_LABEL,
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

const SEARCH_PLACEHOLDER = "Find anything: OL-3857, #3553, a branch, [project]";

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

function useInbox() {
  const rpc = useRpc<typeof rpcContract>();
  const [meta, setMeta] = useState<Meta[]>([]);
  const [views, setViews] = useState<View[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [display, setDisplay] = useState<Display>(DEFAULT_DISPLAY);
  // The server is authoritative until the first load lands; after that the
  // window owns its own display so a refetch cannot yank a setting back.
  const loaded = useRef(false);

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
        loading="lazy"
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
  showProject,
  onSelect,
  onOpen,
}: {
  row: Row;
  selected: boolean;
  /** False under a project group, where the header already says which one. */
  showProject: boolean;
  onSelect: () => void;
  onOpen: () => void;
}) {
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
          "cursor-pointer px-3 py-2 text-sm",
          selected ? "bg-muted" : "hover:bg-muted/50",
        )}
      >
        <div className="flex items-center gap-2">
          {row.state === "needs-me" ? (
            <span
              aria-label="Needs you"
              className="size-1.5 shrink-0 rounded-full bg-destructive"
            />
          ) : row.state === "working" ? (
            <span
              aria-label="Working"
              className="size-1.5 shrink-0 animate-pulse rounded-full bg-foreground"
            />
          ) : (
            <span aria-hidden className="size-1.5 shrink-0" />
          )}
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              row.isUnread && "font-medium",
              row.state === "done" && "text-muted-foreground",
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
        {showProject || row.branchName !== null || row.tags.length > 0 ? (
          <div className="mt-1 flex items-center gap-1.5 pl-3.5 text-xs text-muted-foreground">
            {showProject ? (
              <>
                <ProjectMark of={row} />
                <span className="shrink-0">{row.projectName}</span>
                {row.branchName === null ? null : <span aria-hidden>/</span>}
              </>
            ) : null}
            {row.branchName === null ? null : (
              <span className="truncate font-mono text-[11px]">
                {row.branchName}
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
          <p className="mt-1 pl-3.5 text-xs text-destructive">
            Waiting on you: {row.blockedOn}
          </p>
        ) : row.note !== null ? (
          <p className="mt-1 truncate pl-3.5 text-xs text-muted-foreground">
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
          <DropdownMenu.Label className="px-2 py-1 text-xs text-muted-foreground">
            Organize
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
          <DropdownMenu.Label className="px-2 py-1 text-xs text-muted-foreground">
            Sort by
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
}: {
  row: Row | null;
  focusRequest: number;
}) {
  const pullRequest = useSidebarThreadPullRequest(row?.threadId ?? "").pullRequest;
  const navigate = useBbNavigate();

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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deepHits, setDeepHits] = useState<Hit[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // Bumping this is how the host is asked to put the caret in the composer.
  const [focusRequest, setFocusRequest] = useState(0);
  const splitRef = useRef<HTMLDivElement>(null);
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
  // The flat order the keyboard walks, which has to be the order on screen.
  const visible = useMemo(
    () => groups.flatMap((group) => group.rows),
    [groups],
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

  const selected = useMemo(
    () => visible.find((row) => row.threadId === selectedId) ?? visible[0] ?? null,
    [visible, selectedId],
  );

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
      if (visible.length === 0) return;
      const at = visible.findIndex((row) => row.threadId === selected?.threadId);
      const next = Math.min(Math.max(at + step, 0), visible.length - 1);
      setSelectedId(visible[next]!.threadId);
      document
        .querySelector(`[data-thread="${visible[next]!.threadId}"]`)
        ?.scrollIntoView({ block: "nearest" });
    },
    [visible, selected],
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

  const focusList = useCallback(() => {
    listRef.current?.focus();
  }, []);
  // The panel opens with the list focused, so the first arrow key works
  // without touching the mouse.
  useEffect(focusList, [focusList]);
  const focusComposer = useCallback(() => {
    setFocusRequest((at) => at + 1);
  }, []);
  // True while the caret belongs in the composer. Switching threads swaps the
  // chat's contents underneath it, so the request to focus has to be re-sent
  // once the new thread has settled rather than during the switch.
  const keepComposer = useRef(false);
  const selectedId2 = selected?.threadId ?? null;
  useEffect(() => {
    if (!keepComposer.current || selectedId2 === null) return;
    const timer = setTimeout(focusComposer, 80);
    return () => clearTimeout(timer);
  }, [selectedId2, focusComposer]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      // Shift+arrows walk threads from ANYWHERE in the panel, including mid
      // sentence in the composer. That is the whole point: changing which
      // thread you are answering should not cost you the caret.
      const typing = isTypingTarget(event.target);
      const inSearch = event.target === searchRef.current;

      // Shift+arrows walk threads from ANYWHERE in the panel, including mid
      // sentence in the composer. That is the whole point: changing which
      // thread you are answering should not cost you the caret. Switching
      // threads remounts the chat, so the caret has to be asked back
      // explicitly once the new one is up.
      if (event.shiftKey && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault();
        keepComposer.current = typing && !inSearch;
        move(event.key === "ArrowDown" ? 1 : -1);
        return;
      }

      if (typing) {
        // Tab from the search box continues into the composer rather than
        // walking the browser's focus order through every control.
        if (inSearch && event.key === "Tab" && !event.shiftKey) {
          event.preventDefault();
          keepComposer.current = true;
          focusComposer();
          return;
        }
        // Escape anywhere you are typing comes back to the list, which is the
        // one key that always gets you home.
        if (event.key === "Escape" && !inSearch) {
          event.preventDefault();
          keepComposer.current = false;
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
      if (key === "Tab" && !event.shiftKey) {
        event.preventDefault();
        keepComposer.current = true;
        focusComposer();
        return;
      }
      if (key === "/") {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
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

      if (selected === null) return;
      if (key === "Enter") {
        event.preventDefault();
        actions.open(selected.threadId);
      } else if (key === "o") {
        event.preventDefault();
        actions.open(selected.threadId, { split: true });
      } else if (key === "e") {
        event.preventDefault();
        // The host archives and raises its own undo toast. Do not add a second
        // one: one keystroke should produce one notice, and the host's is the
        // affordance the rest of bb already taught.
        actions.archive(selected.threadId);
      } else if (key === "p") {
        event.preventDefault();
        void actions.setPinned(selected.threadId, !selected.isPinned);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [move, selected, actions, views, text, changeDisplay, focusList, focusComposer]);

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
      className={cn(
        "flex h-full min-h-0 flex-1",
        // Killing selection while dragging stops the pointer from painting the
        // list blue as it crosses rows.
        dragging && "select-none",
      )}
    >
      <div
        style={{ width }}
        className="flex min-h-0 shrink-0 flex-col"
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
            selected === null ? undefined : `row-${selected.threadId}`
          }
          className="min-h-0 flex-1 overflow-y-auto outline-none"
        >
          {groups.map((group) => (
            <div key={group.key}>
              <li className="sticky top-0 z-10 flex items-center gap-1.5 bg-card/95 px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground backdrop-blur">
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
              {group.rows.map((row) => (
                <div key={row.threadId} data-thread={row.threadId}>
                  <ThreadRow
                    row={row}
                    selected={selected?.threadId === row.threadId}
                    showProject={!byProject}
                    onSelect={() => setSelectedId(row.threadId)}
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
          <kbd className="font-mono">⇧↑↓</kbd> thread ·{" "}
          <kbd className="font-mono">tab</kbd> write ·{" "}
          <kbd className="font-mono">esc</kbd> list ·{" "}
          <kbd className="font-mono">/</kbd> find ·{" "}
          <kbd className="font-mono">⏎</kbd> open ·{" "}
          <kbd className="font-mono">e</kbd> done ·{" "}
          <kbd className="font-mono">p</kbd> pin
        </div>
      </div>

      <PaneHandle
        width={width}
        dragging={dragging}
        onStartDrag={startDrag}
        onNudge={(delta) => commit(clamp(width + delta))}
        onReset={() => commit(clamp(LIST_WIDTH_DEFAULT))}
      />

      <div className="min-h-0 flex-1">
        <ThreadPane row={selected} focusRequest={focusRequest} />
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

/** True when the keystroke belongs to something the user is typing into. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "inbox",
    title: "Inbox",
    icon: "ListTodo",
    path: "inbox",
    component: InboxPage,
  });
});
