// How the list is organized and ordered.
//
// The vocabulary deliberately matches bb's own sidebar menu ("Organize" /
// "Sort by", "Updated at" / "Created at" / "Alphabetical") so the two surfaces
// do not teach two different words for the same idea. What the inbox adds is
// the default: grouping by STATE, which the sidebar cannot do, because the
// sidebar organizes browsing and the inbox organizes triage.

export type GroupBy = "state" | "project" | "day" | "none";
export type SortBy = "updated" | "created" | "alphabetical";

export interface Display {
  groupBy: GroupBy;
  sortBy: SortBy;
  /** Float threads you have not read to the top of every group. */
  unreadFirst: boolean;
}

export const DEFAULT_DISPLAY: Display = {
  groupBy: "state",
  sortBy: "updated",
  unreadFirst: false,
};

export const GROUP_BY_LABEL: Record<GroupBy, string> = {
  state: "By state",
  project: "By project",
  day: "By day",
  none: "Flat",
};

export const SORT_BY_LABEL: Record<SortBy, string> = {
  updated: "Updated at",
  created: "Created at",
  alphabetical: "Alphabetical",
};

const GROUP_BY_CYCLE: GroupBy[] = ["state", "project", "day", "none"];
const SORT_BY_CYCLE: SortBy[] = ["updated", "created", "alphabetical"];

/** Step to the next option, wrapping. Cycling beats a menu for a keystroke. */
export function cycleGroupBy(current: GroupBy): GroupBy {
  const at = GROUP_BY_CYCLE.indexOf(current);
  return GROUP_BY_CYCLE[(at + 1) % GROUP_BY_CYCLE.length]!;
}

export function cycleSortBy(current: SortBy): SortBy {
  const at = SORT_BY_CYCLE.indexOf(current);
  return SORT_BY_CYCLE[(at + 1) % SORT_BY_CYCLE.length]!;
}

/** Parse anything persisted or typed, falling back rather than throwing. */
export function parseDisplay(value: unknown): Display {
  if (typeof value !== "object" || value === null) return DEFAULT_DISPLAY;
  const raw = value as Record<string, unknown>;
  return {
    groupBy:
      raw.groupBy === "project" ||
      raw.groupBy === "day" ||
      raw.groupBy === "none"
        ? raw.groupBy
        : "state",
    sortBy:
      raw.sortBy === "created" || raw.sortBy === "alphabetical"
        ? raw.sortBy
        : "updated",
    unreadFirst: raw.unreadFirst === true,
  };
}

/** What grouping and sorting need from a row. */
export interface Groupable {
  threadId: string;
  title: string;
  projectName: string;
  state: "needs-me" | "working" | "idle" | "done";
  createdAt: number;
  updatedAt: number;
  isUnread: boolean;
  isPinned: boolean;
}

export interface Group<T> {
  key: string;
  label: string;
  rows: T[];
}

const STATE_ORDER: Groupable["state"][] = [
  "needs-me",
  "working",
  "idle",
  "done",
];
const STATE_LABEL: Record<Groupable["state"], string> = {
  "needs-me": "Needs you",
  working: "Working",
  idle: "Idle",
  done: "Done",
};

const DAY = 86_400_000;

/** Which bucket a timestamp falls in, coarsening as it recedes. */
export function dayBucket(at: number, now: number): { key: string; label: string } {
  const startOfToday = new Date(new Date(now).toDateString()).getTime();
  if (at >= startOfToday) return { key: "0-today", label: "Today" };
  if (at >= startOfToday - DAY) return { key: "1-yesterday", label: "Yesterday" };
  if (at >= startOfToday - 7 * DAY) return { key: "2-week", label: "This week" };
  if (at >= startOfToday - 30 * DAY) return { key: "3-month", label: "This month" };
  return { key: "4-older", label: "Older" };
}

function compare(a: Groupable, b: Groupable, display: Display): number {
  if (display.unreadFirst && a.isUnread !== b.isUnread) return a.isUnread ? -1 : 1;
  switch (display.sortBy) {
    case "created":
      return b.createdAt - a.createdAt;
    case "alphabetical":
      return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
    case "updated":
      return b.updatedAt - a.updatedAt;
  }
}

/**
 * Split rows into ordered groups. Pinned rows always lead, in their own group:
 * pinning is a deliberate act, and scattering pins through a project or day
 * grouping would make the act pointless.
 */
export function groupRows<T extends Groupable>(
  rows: readonly T[],
  display: Display,
  now = Date.now(),
): Group<T>[] {
  const sorted = [...rows].sort((a, b) => compare(a, b, display));
  const pinned = sorted.filter((row) => row.isPinned);
  const rest = sorted.filter((row) => !row.isPinned);

  const groups: Group<T>[] = [];
  if (pinned.length > 0) {
    groups.push({ key: "pinned", label: "Pinned", rows: pinned });
  }

  if (display.groupBy === "none") {
    if (rest.length > 0) groups.push({ key: "all", label: "All", rows: rest });
    return groups;
  }

  const buckets = new Map<string, Group<T>>();
  for (const row of rest) {
    const { key, label } = bucketFor(row, display.groupBy, now);
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, { key, label, rows: [row] });
    else bucket.rows.push(row);
  }

  const ordered = [...buckets.values()].sort((a, b) => {
    // State and day buckets carry their order in the key; projects read
    // alphabetically, which is how the sidebar lists them too.
    if (display.groupBy === "project") return a.label.localeCompare(b.label);
    return a.key.localeCompare(b.key);
  });
  return [...groups, ...ordered];
}

function bucketFor(
  row: Groupable,
  groupBy: Exclude<GroupBy, "none">,
  now: number,
): { key: string; label: string } {
  if (groupBy === "project") {
    return { key: `p:${row.projectName}`, label: row.projectName };
  }
  if (groupBy === "day") {
    return dayBucket(row.updatedAt, now);
  }
  return {
    key: `${STATE_ORDER.indexOf(row.state)}-${row.state}`,
    label: STATE_LABEL[row.state],
  };
}

/**
 * True when a branch name is bb's own generated worktree branch, which is the
 * thread title slugified with the thread id stuck on the end. Showing one
 * under the title restates the title in kebab-case and buries the branches
 * that were actually named by a person.
 */
export function isGeneratedBranch(
  branch: string | null,
  threadId: string,
): boolean {
  if (branch === null) return true;
  return branch.endsWith(`-${threadId}`) || branch.endsWith(`_${threadId}`);
}

/** The branch worth putting under a title, or null when there is none. */
export function displayBranch(
  branch: string | null,
  threadId: string,
): string | null {
  return isGeneratedBranch(branch, threadId) ? null : branch;
}
