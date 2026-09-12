import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_DISPLAY,
  displayBranch,
  isGeneratedBranch,
  cycleGroupBy,
  cycleSortBy,
  dayBucket,
  groupRows,
  parseDisplay,
  type Display,
  type Groupable,
} from "./display.ts";

const NOW = Date.parse("2026-09-12T12:00:00Z");
const HOURS = 3_600_000;
/** Local midnight for NOW. "Today" means the local day, so tests must too. */
const MIDNIGHT = new Date(new Date(NOW).toDateString()).getTime();

const row = (over: Partial<Groupable> & { threadId: string }): Groupable => ({
  title: "A thread",
  projectName: "checkout",
  state: "idle",
  createdAt: NOW - 100 * HOURS,
  updatedAt: NOW - HOURS,
  isUnread: false,
  isPinned: false,
  ...over,
});

const display = (over: Partial<Display> = {}): Display => ({
  ...DEFAULT_DISPLAY,
  ...over,
});

test("defaults group by state, newest first", () => {
  assert.equal(DEFAULT_DISPLAY.groupBy, "state");
  assert.equal(DEFAULT_DISPLAY.sortBy, "updated");
});

test("state groups come out in triage order", () => {
  const groups = groupRows(
    [
      row({ threadId: "a", state: "idle" }),
      row({ threadId: "b", state: "needs-me" }),
      row({ threadId: "c", state: "working" }),
    ],
    display(),
    NOW,
  );
  assert.deepEqual(groups.map((g) => g.label), ["Needs you", "Working", "Idle"]);
});

test("project groups read alphabetically", () => {
  const groups = groupRows(
    [
      row({ threadId: "a", projectName: "tooling" }),
      row({ threadId: "b", projectName: "analytics" }),
      row({ threadId: "c", projectName: "checkout" }),
    ],
    display({ groupBy: "project" }),
    NOW,
  );
  assert.deepEqual(groups.map((g) => g.label), [
    "analytics",
    "checkout",
    "tooling",
  ]);
});

test("day groups coarsen as they recede", () => {
  const groups = groupRows(
    [
      row({ threadId: "a", updatedAt: MIDNIGHT + HOURS }),
      row({ threadId: "b", updatedAt: MIDNIGHT - 2 * HOURS }),
      row({ threadId: "c", updatedAt: MIDNIGHT - 4 * 24 * HOURS }),
      row({ threadId: "d", updatedAt: MIDNIGHT - 90 * 24 * HOURS }),
    ],
    display({ groupBy: "day" }),
    NOW,
  );
  assert.deepEqual(groups.map((g) => g.label), [
    "Today",
    "Yesterday",
    "This week",
    "Older",
  ]);
});

test("dayBucket splits on the local midnight, not on 24-hour windows", () => {
  // Just after local midnight is Today even though it is barely minutes old,
  // and just before it is Yesterday even though it is minutes away.
  assert.equal(dayBucket(MIDNIGHT + 60_000, NOW).label, "Today");
  assert.equal(dayBucket(MIDNIGHT - 60_000, NOW).label, "Yesterday");
});

test("flat grouping returns one group", () => {
  const groups = groupRows(
    [row({ threadId: "a" }), row({ threadId: "b", projectName: "tooling" })],
    display({ groupBy: "none" }),
    NOW,
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.rows.length, 2);
});

test("pinned rows lead, in their own group, whatever the grouping", () => {
  for (const groupBy of ["state", "project", "day", "none"] as const) {
    const groups = groupRows(
      [
        row({ threadId: "a", state: "needs-me" }),
        row({ threadId: "p", isPinned: true, state: "idle", projectName: "zzz" }),
      ],
      display({ groupBy }),
      NOW,
    );
    assert.equal(groups[0]!.label, "Pinned", groupBy);
    assert.deepEqual(groups[0]!.rows.map((r) => r.threadId), ["p"], groupBy);
  }
});

test("sort by updated is newest first", () => {
  const groups = groupRows(
    [
      row({ threadId: "old", updatedAt: NOW - 10 * HOURS }),
      row({ threadId: "new", updatedAt: NOW - HOURS }),
    ],
    display({ groupBy: "none" }),
    NOW,
  );
  assert.deepEqual(groups[0]!.rows.map((r) => r.threadId), ["new", "old"]);
});

test("sort by created ignores update time", () => {
  const groups = groupRows(
    [
      row({ threadId: "a", createdAt: NOW - 5 * HOURS, updatedAt: NOW - 99 * HOURS }),
      row({ threadId: "b", createdAt: NOW - 50 * HOURS, updatedAt: NOW }),
    ],
    display({ groupBy: "none", sortBy: "created" }),
    NOW,
  );
  assert.deepEqual(groups[0]!.rows.map((r) => r.threadId), ["a", "b"]);
});

test("alphabetical ignores case", () => {
  const groups = groupRows(
    [
      row({ threadId: "b", title: "banana" }),
      row({ threadId: "a", title: "Apple" }),
      row({ threadId: "c", title: "cherry" }),
    ],
    display({ groupBy: "none", sortBy: "alphabetical" }),
    NOW,
  );
  assert.deepEqual(groups[0]!.rows.map((r) => r.threadId), ["a", "b", "c"]);
});

test("unread first overrides the sort, inside each group", () => {
  const groups = groupRows(
    [
      row({ threadId: "recent", updatedAt: NOW }),
      row({ threadId: "unread", updatedAt: NOW - 99 * HOURS, isUnread: true }),
    ],
    display({ groupBy: "none", unreadFirst: true }),
    NOW,
  );
  assert.deepEqual(groups[0]!.rows.map((r) => r.threadId), ["unread", "recent"]);
});

test("unread first is off by default", () => {
  const groups = groupRows(
    [
      row({ threadId: "recent", updatedAt: NOW }),
      row({ threadId: "unread", updatedAt: NOW - 99 * HOURS, isUnread: true }),
    ],
    display({ groupBy: "none" }),
    NOW,
  );
  assert.deepEqual(groups[0]!.rows.map((r) => r.threadId), ["recent", "unread"]);
});

test("parseDisplay falls back rather than throwing", () => {
  assert.deepEqual(parseDisplay(null), DEFAULT_DISPLAY);
  assert.deepEqual(parseDisplay("nonsense"), DEFAULT_DISPLAY);
  assert.deepEqual(parseDisplay({ groupBy: "banana" }), DEFAULT_DISPLAY);
  assert.deepEqual(parseDisplay({ groupBy: "day", sortBy: "created", unreadFirst: true }), {
    groupBy: "day",
    sortBy: "created",
    unreadFirst: true,
  });
});

test("grouping never drops or duplicates a row", () => {
  const rows = [
    row({ threadId: "a", state: "needs-me" }),
    row({ threadId: "b", isPinned: true }),
    row({ threadId: "c", projectName: "tooling", updatedAt: NOW - 500 * HOURS }),
    row({ threadId: "d", state: "working" }),
  ];
  for (const groupBy of ["state", "project", "day", "none"] as const) {
    const seen = groupRows(rows, display({ groupBy }), NOW)
      .flatMap((group) => group.rows.map((r) => r.threadId))
      .sort();
    assert.deepEqual(seen, ["a", "b", "c", "d"], groupBy);
  }
});

test("cycling grouping visits every option and wraps", () => {
  const seen = [];
  let at = DEFAULT_DISPLAY.groupBy;
  for (let step = 0; step < 4; step += 1) {
    at = cycleGroupBy(at);
    seen.push(at);
  }
  assert.deepEqual(seen, ["project", "day", "none", "state"]);
});

test("cycling sort visits every option and wraps", () => {
  const seen = [];
  let at = DEFAULT_DISPLAY.sortBy;
  for (let step = 0; step < 3; step += 1) {
    at = cycleSortBy(at);
    seen.push(at);
  }
  assert.deepEqual(seen, ["created", "alphabetical", "updated"]);
});

test("bb's generated worktree branches are not worth showing", () => {
  // Real shapes: the title slugified, with the thread id on the end.
  assert.equal(
    isGeneratedBranch("bb/daily-sdr-scan-thr_duri4gwtm3", "thr_duri4gwtm3"),
    true,
  );
  assert.equal(
    isGeneratedBranch("bb/checkout-3555-skip-the-turn-it-thr_jj6qgcfcqk", "thr_jj6qgcfcqk"),
    true,
  );
  assert.equal(isGeneratedBranch(null, "thr_x"), true);
});

test("a branch a person named survives", () => {
  assert.equal(
    isGeneratedBranch("docs/deploy-watch-prod-logging-notes", "thr_duri4gwtm3"),
    false,
  );
  assert.equal(isGeneratedBranch("main", "thr_x"), false);
  assert.equal(isGeneratedBranch("dana/eng-482-webhook-retry", "thr_x"), false);
});

test("displayBranch keeps only the informative ones", () => {
  assert.equal(displayBranch("bb/thing-thr_abc", "thr_abc"), null);
  assert.equal(displayBranch("main", "thr_abc"), "main");
  assert.equal(displayBranch(null, "thr_abc"), null);
});
