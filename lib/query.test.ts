import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fuzzyMatch,
  matches,
  parseQuery,
  parseWhen,
  projectSuggestions,
  searchableText,
  type Matchable,
} from "./query.ts";

// Rows shaped like the real board: Linear tickets in titles, PR links in
// titles, kind markers in brackets, dana/ol-... branches.
const row = (over: Partial<Matchable> = {}): Matchable => ({
  title: "ENG-482: retry the webhook when the signature check arrives late",
  projectName: "checkout",
  branchName: "dana/eng-482-cart-takeover",
  prNumber: 1284,
  prTitle: "Skip the turn-it-on step",
  tags: ["review"],
  note: null,
  state: "needs-me",
  updatedAt: Date.parse("2026-09-10T12:00:00Z"),
  ...over,
});

test("an empty query matches everything", () => {
  const query = parseQuery("");
  assert.equal(query.isEmpty, true);
  assert.equal(matches(row(), query), true);
});

test("a Linear ticket in the title is findable", () => {
  assert.equal(matches(row(), parseQuery("eng-482")), true);
  assert.equal(matches(row(), parseQuery("ENG-482")), true);
  assert.equal(matches(row(), parseQuery("ol-9999")), false);
});

test("a branch name is findable", () => {
  assert.equal(matches(row(), parseQuery("dana/eng-482")), true);
  assert.equal(matches(row(), parseQuery("cart-takeover")), true);
});

test("a PR number is findable bare, with #, and with pr:", () => {
  for (const text of ["1284", "#1284", "pr:1284"]) {
    assert.equal(matches(row(), parseQuery(text)), true, text);
  }
  assert.equal(matches(row(), parseQuery("pr:9999")), false);
});

test("pr: matches the PR even when the number is nowhere in the text", () => {
  const bare = row({ title: "Fix the cart", prTitle: null, branchName: null });
  assert.equal(matches(bare, parseQuery("pr:1284")), true);
});

test("every term must hit, so more words narrow", () => {
  assert.equal(matches(row(), parseQuery("cart stripe")), true);
  assert.equal(matches(row(), parseQuery("cart aardvark")), false);
});

test("[project] scopes, the way he already writes it", () => {
  assert.equal(matches(row(), parseQuery("[checkout]")), true);
  assert.equal(matches(row({ projectName: "tooling" }), parseQuery("[checkout]")), false);
  assert.equal(
    matches(row({ projectName: "analytics" }), parseQuery("[checkout] [analytics]")),
    true,
  );
});

test("an unclosed [project still filters, fuzzily", () => {
  const query = parseQuery("[check");
  assert.equal(query.partialProject, "check");
  assert.equal(matches(row(), query), true);
  assert.equal(matches(row({ projectName: "tooling" }), query), false);
});

test("a bare open bracket narrows nothing yet", () => {
  assert.equal(matches(row({ projectName: "tooling" }), parseQuery("[")), true);
});

test("is: tokens are OR'd, because 'blocked or working' is the useful read", () => {
  const query = parseQuery("is:blocked is:working");
  assert.deepEqual(query.states, ["needs-me", "working"]);
  assert.equal(matches(row({ state: "needs-me" }), query), true);
  assert.equal(matches(row({ state: "working" }), query), true);
  assert.equal(matches(row({ state: "idle" }), query), false);
});

test("is: aliases cover the words he uses", () => {
  assert.deepEqual(parseQuery("is:waiting").states, ["needs-me"]);
  assert.deepEqual(parseQuery("is:running").states, ["working"]);
  assert.deepEqual(parseQuery("is:archived").states, ["done"]);
});

test("a half-typed is: token narrows nothing instead of matching nothing", () => {
  const query = parseQuery("is:blo");
  assert.deepEqual(query.states, []);
  assert.equal(matches(row(), query), true);
});

test("tag: tokens are AND'd, because two tags should narrow", () => {
  const tagged = row({ tags: ["review", "review"] });
  assert.equal(matches(tagged, parseQuery("tag:review")), true);
  assert.equal(matches(tagged, parseQuery("tag:review tag:review")), true);
  assert.equal(matches(tagged, parseQuery("tag:review tag:security")), false);
});

test("since: and before: bound by when the thread was last touched", () => {
  const now = Date.parse("2026-09-11T12:00:00Z");
  const recent = row({ updatedAt: Date.parse("2026-09-11T09:00:00Z") });
  const old = row({ updatedAt: Date.parse("2026-08-01T09:00:00Z") });
  const since = parseQuery("since:3d", now);
  assert.equal(matches(recent, since), true);
  assert.equal(matches(old, since), false);
  const before = parseQuery("before:2026-09-01", now);
  assert.equal(matches(old, before), true);
  assert.equal(matches(recent, before), false);
});

test("when: accepts durations, dates, and today", () => {
  const now = Date.parse("2026-09-11T12:00:00Z");
  assert.equal(parseWhen("3d", now), now - 3 * 86_400_000);
  assert.equal(parseWhen("2h", now), now - 2 * 3_600_000);
  assert.equal(parseWhen("1w", now), now - 604_800_000);
  assert.equal(parseWhen("2026-09-01", now), Date.parse("2026-09-01"));
  assert.equal(parseWhen("nonsense", now), null);
  assert.notEqual(parseWhen("today", now), null);
});

test("tokens of different kinds combine", () => {
  const query = parseQuery("[checkout] is:blocked tag:review cart");
  assert.equal(matches(row(), query), true);
  assert.equal(matches(row({ state: "done" }), query), false);
  assert.equal(matches(row({ tags: [] }), query), false);
  assert.equal(matches(row({ projectName: "tooling" }), query), false);
});

test("the agent's standing note is searchable", () => {
  const noted = row({ title: "Untitled", note: "waiting on the Stripe key" });
  assert.equal(matches(noted, parseQuery("stripe key")), true);
});

test("searchableText covers every field a row is found by", () => {
  const text = searchableText(row());
  for (const fragment of ["eng-482", "checkout", "dana/eng-482", "#1284", "review"]) {
    assert.ok(text.includes(fragment), fragment);
  }
});

test("fuzzyMatch takes substrings and subsequences", () => {
  assert.equal(fuzzyMatch("checkout", "chk"), true);
  assert.equal(fuzzyMatch("checkout", "out"), true);
  assert.equal(fuzzyMatch("checkout", "xyz"), false);
});

test("project suggestions only appear for an open tag", () => {
  const names = ["checkout", "analytics", "tooling"];
  assert.deepEqual(projectSuggestions(names, null), []);
  assert.deepEqual(projectSuggestions(names, ""), names);
  assert.deepEqual(projectSuggestions(names, "che"), ["checkout"]);
});
