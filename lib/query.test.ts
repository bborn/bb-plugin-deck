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
// titles, kind markers in brackets, sean/ol-... branches.
const row = (over: Partial<Matchable> = {}): Matchable => ({
  title: "OL-3857: Don't take over the cart when the merchant's Stripe is disconnected",
  projectName: "offerlab",
  branchName: "sean/ol-3857-cart-takeover",
  prNumber: 3553,
  prTitle: "Skip the turn-it-on step",
  tags: ["slop"],
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
  assert.equal(matches(row(), parseQuery("ol-3857")), true);
  assert.equal(matches(row(), parseQuery("OL-3857")), true);
  assert.equal(matches(row(), parseQuery("ol-9999")), false);
});

test("a branch name is findable", () => {
  assert.equal(matches(row(), parseQuery("sean/ol-3857")), true);
  assert.equal(matches(row(), parseQuery("cart-takeover")), true);
});

test("a PR number is findable bare, with #, and with pr:", () => {
  for (const text of ["3553", "#3553", "pr:3553"]) {
    assert.equal(matches(row(), parseQuery(text)), true, text);
  }
  assert.equal(matches(row(), parseQuery("pr:9999")), false);
});

test("pr: matches the PR even when the number is nowhere in the text", () => {
  const bare = row({ title: "Fix the cart", prTitle: null, branchName: null });
  assert.equal(matches(bare, parseQuery("pr:3553")), true);
});

test("every term must hit, so more words narrow", () => {
  assert.equal(matches(row(), parseQuery("cart stripe")), true);
  assert.equal(matches(row(), parseQuery("cart aardvark")), false);
});

test("[project] scopes, the way he already writes it", () => {
  assert.equal(matches(row(), parseQuery("[offerlab]")), true);
  assert.equal(matches(row({ projectName: "taskyou" }), parseQuery("[offerlab]")), false);
  assert.equal(
    matches(row({ projectName: "influencekit" }), parseQuery("[offerlab] [influencekit]")),
    true,
  );
});

test("an unclosed [project still filters, fuzzily", () => {
  const query = parseQuery("[offer");
  assert.equal(query.partialProject, "offer");
  assert.equal(matches(row(), query), true);
  assert.equal(matches(row({ projectName: "taskyou" }), query), false);
});

test("a bare open bracket narrows nothing yet", () => {
  assert.equal(matches(row({ projectName: "taskyou" }), parseQuery("[")), true);
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
  const tagged = row({ tags: ["slop", "review"] });
  assert.equal(matches(tagged, parseQuery("tag:slop")), true);
  assert.equal(matches(tagged, parseQuery("tag:slop tag:review")), true);
  assert.equal(matches(tagged, parseQuery("tag:slop tag:security")), false);
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
  const query = parseQuery("[offerlab] is:blocked tag:slop cart");
  assert.equal(matches(row(), query), true);
  assert.equal(matches(row({ state: "done" }), query), false);
  assert.equal(matches(row({ tags: [] }), query), false);
  assert.equal(matches(row({ projectName: "taskyou" }), query), false);
});

test("the agent's standing note is searchable", () => {
  const noted = row({ title: "Untitled", note: "waiting on the Stripe key" });
  assert.equal(matches(noted, parseQuery("stripe key")), true);
});

test("searchableText covers every field a row is found by", () => {
  const text = searchableText(row());
  for (const fragment of ["ol-3857", "offerlab", "sean/ol-3857", "#3553", "slop"]) {
    assert.ok(text.includes(fragment), fragment);
  }
});

test("fuzzyMatch takes substrings and subsequences", () => {
  assert.equal(fuzzyMatch("offerlab", "ofl"), true);
  assert.equal(fuzzyMatch("offerlab", "lab"), true);
  assert.equal(fuzzyMatch("offerlab", "xyz"), false);
});

test("project suggestions only appear for an open tag", () => {
  const names = ["offerlab", "influencekit", "taskyou"];
  assert.deepEqual(projectSuggestions(names, null), []);
  assert.deepEqual(projectSuggestions(names, ""), names);
  assert.deepEqual(projectSuggestions(names, "off"), ["offerlab"]);
});
