// The search language. One box, and it has to hit anything you might
// remember about a task: a Linear ticket buried in a title, a PR number, a
// branch, a project, a tag, roughly when it happened, or a phrase the agent
// said. The shapes come from his real board: titles like
// "ENG-482: retry the webhook", "Review: .../pull/1284", and
// branches like "dana/eng-517-skip-the-setup-step".
//
// Pure and testable: the page filters on every keystroke without a round trip.

export type State = "needs-me" | "working" | "idle" | "done";

const STATES: Record<string, State> = {
  "needs-me": "needs-me",
  needsme: "needs-me",
  blocked: "needs-me",
  waiting: "needs-me",
  mine: "needs-me",
  working: "working",
  running: "working",
  active: "working",
  idle: "idle",
  done: "done",
  archived: "done",
  finished: "done",
};

export interface Query {
  /** `[project]` tags, lowercased and OR'd. */
  projects: string[];
  /** A trailing unclosed `[project`, lowercased, or null. */
  partialProject: string | null;
  /** `is:` tokens, OR'd. "show me blocked or working" is the useful reading. */
  states: State[];
  /** `tag:` tokens, AND'd: narrowing by two tags should narrow. */
  tags: string[];
  /** `pr:123` or a bare `#123`. */
  prNumbers: number[];
  /** `since:` as an epoch-ms floor on when the thread was last touched. */
  since: number | null;
  /** `before:` as an epoch-ms ceiling. */
  before: number | null;
  /** Whatever is left, lowercased. Matched against every text field. */
  text: string;
  /** True when nothing at all was asked for. */
  isEmpty: boolean;
}

/** What a row has to expose to be matched locally. */
export interface Matchable {
  title: string;
  projectName: string;
  branchName: string | null;
  prNumber: number | null;
  prTitle: string | null;
  tags: readonly string[];
  note: string | null;
  state: State;
  updatedAt: number;
}

const DURATION = /^(\d+)\s*([hdwmy])$/;

/** `since:3d`, `since:today`, `since:2026-09-01`. Epoch ms, or null. */
export function parseWhen(raw: string, now: number): number | null {
  const value = raw.trim().toLowerCase();
  if (value === "") return null;
  if (value === "today") return new Date(new Date(now).toDateString()).getTime();
  if (value === "yesterday") {
    return new Date(new Date(now).toDateString()).getTime() - 86_400_000;
  }
  const duration = DURATION.exec(value);
  if (duration !== null) {
    const amount = Number(duration[1]);
    const unit = duration[2]!;
    const ms =
      unit === "h"
        ? 3_600_000
        : unit === "d"
          ? 86_400_000
          : unit === "w"
            ? 604_800_000
            : unit === "m"
              ? 2_592_000_000
              : 31_536_000_000;
    return now - amount * ms;
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : date;
}

export function parseQuery(raw: string, now = Date.now()): Query {
  const { projects, partialProject, rest } = extractProjects(raw.toLowerCase());
  const states: State[] = [];
  const tags: string[] = [];
  const prNumbers: number[] = [];
  let since: number | null = null;
  let before: number | null = null;
  const words: string[] = [];

  for (const word of rest.split(/\s+/)) {
    if (word === "") continue;
    const colon = word.indexOf(":");
    const field = colon === -1 ? "" : word.slice(0, colon);
    const value = colon === -1 ? "" : word.slice(colon + 1);

    if (field === "is") {
      const state = STATES[value];
      // An unknown or half-typed token narrows nothing rather than matching
      // nothing, so the list never blanks out mid-word.
      if (state !== undefined && !states.includes(state)) states.push(state);
      continue;
    }
    if (field === "tag" && value !== "") {
      if (!tags.includes(value)) tags.push(value);
      continue;
    }
    if (field === "pr") {
      const number = Number.parseInt(value, 10);
      if (Number.isFinite(number)) prNumbers.push(number);
      continue;
    }
    if (field === "since") {
      since = parseWhen(value, now) ?? since;
      continue;
    }
    if (field === "before") {
      before = parseWhen(value, now) ?? before;
      continue;
    }
    // A bare #1234 is how he writes a PR in a title, so it filters on the PR
    // number AND stays as text, since "#1284" appears inside titles too.
    if (/^#\d+$/.test(word)) {
      prNumbers.push(Number.parseInt(word.slice(1), 10));
      words.push(word.slice(1));
      continue;
    }
    words.push(word);
  }

  const text = words.join(" ");
  return {
    projects,
    partialProject,
    states,
    tags,
    prNumbers,
    since,
    before,
    text,
    isEmpty:
      projects.length === 0 &&
      partialProject === null &&
      states.length === 0 &&
      tags.length === 0 &&
      prNumbers.length === 0 &&
      since === null &&
      before === null &&
      text === "",
  };
}

function extractProjects(query: string): {
  projects: string[];
  partialProject: string | null;
  rest: string;
} {
  const projects: string[] = [];
  let partialProject: string | null = null;
  let rest = query;
  for (;;) {
    const open = rest.indexOf("[");
    if (open === -1) break;
    const close = rest.indexOf("]", open);
    if (close === -1) {
      partialProject = rest.slice(open + 1).trim();
      rest = rest.slice(0, open);
      break;
    }
    const name = rest.slice(open + 1, close).trim();
    if (name !== "") projects.push(name);
    rest = rest.slice(0, open) + rest.slice(close + 1);
  }
  return { projects, partialProject, rest };
}

/**
 * Every text a row can be found by. Kept in one place so search and highlight
 * agree, and so adding a field means adding it once.
 */
export function searchableText(row: Matchable): string {
  return [
    row.title,
    row.projectName,
    row.branchName ?? "",
    row.prTitle ?? "",
    row.prNumber === null ? "" : `#${row.prNumber}`,
    row.note ?? "",
    row.tags.join(" "),
  ]
    .join("   ")
    .toLowerCase();
}

export function matches(row: Matchable, query: Query): boolean {
  if (query.isEmpty) return true;

  if (query.projects.length > 0 || query.partialProject !== null) {
    const project = row.projectName.toLowerCase();
    const exact = query.projects.some((wanted) => project === wanted);
    const partial =
      query.partialProject !== null &&
      query.partialProject !== "" &&
      fuzzyMatch(project, query.partialProject);
    const openingTag =
      query.projects.length === 0 && query.partialProject === "";
    if (!exact && !partial && !openingTag) return false;
  }

  if (query.states.length > 0 && !query.states.includes(row.state)) return false;

  const rowTags = row.tags.map((tag) => tag.toLowerCase());
  if (query.tags.some((wanted) => !rowTags.some((tag) => tag.includes(wanted)))) {
    return false;
  }

  if (query.prNumbers.length > 0) {
    const haystack = searchableText(row);
    const hit = query.prNumbers.some(
      (number) => row.prNumber === number || haystack.includes(String(number)),
    );
    if (!hit) return false;
  }

  if (query.since !== null && row.updatedAt < query.since) return false;
  if (query.before !== null && row.updatedAt > query.before) return false;

  if (query.text === "") return true;
  return fuzzyMatch(searchableText(row), query.text);
}

/**
 * Every whitespace-separated term must appear. Each term matches as a
 * substring, or as a subsequence so "chk" still finds "checkout". Requiring
 * every term is what makes "eng-482 cart" narrow the way you expect.
 */
export function fuzzyMatch(text: string, query: string): boolean {
  const terms = query.split(/\s+/).filter((term) => term !== "");
  if (terms.length === 0) return true;
  return terms.every((term) => text.includes(term) || isSubsequence(text, term));
}

function isSubsequence(text: string, term: string): boolean {
  let at = 0;
  for (const character of term) {
    const found = text.indexOf(character, at);
    if (found === -1) return false;
    at = found + 1;
  }
  return true;
}

/** Project names worth offering while a `[project` tag is being typed. */
export function projectSuggestions(
  names: readonly string[],
  partial: string | null,
  limit = 6,
): string[] {
  if (partial === null) return [];
  const wanted = partial.toLowerCase();
  return names
    .filter((name) => fuzzyMatch(name.toLowerCase(), wanted))
    .slice(0, limit);
}
