import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACTIONS,
  DEFAULT_BINDINGS,
  chordScope,
  conflicts,
  encodeChord,
  formatChord,
  isReserved,
  lookup,
  resolveBindings,
} from "./bindings.ts";

test("every action has at least one default binding", () => {
  for (const action of ACTIONS) {
    assert.ok(
      DEFAULT_BINDINGS[action.id].length > 0,
      `${action.id} has no default`,
    );
  }
});

test("no two actions share a default chord", () => {
  const seen = new Map<string, string>();
  for (const action of ACTIONS) {
    for (const chord of DEFAULT_BINDINGS[action.id]) {
      const owner = seen.get(chord);
      assert.equal(owner, undefined, `${chord} claimed by ${owner} and ${action.id}`);
      seen.set(chord, action.id);
    }
  }
});

test("a bare chord is list-only and a modified one is global", () => {
  // A bare key types a character, so it must never fire mid-sentence.
  assert.equal(chordScope("e"), "list");
  assert.equal(chordScope("arrowdown"), "list");
  assert.equal(chordScope("mod+shift+g"), "global");
  assert.equal(chordScope("shift+arrowdown"), "global");
});

test("every global default is a chord that types nothing", () => {
  for (const action of ACTIONS.filter((a) => a.scope === "global")) {
    assert.ok(
      DEFAULT_BINDINGS[action.id].some((chord) => chordScope(chord) === "global"),
      `${action.id} has no chord that works while typing`,
    );
  }
});

test("encodeChord normalises modifiers and case", () => {
  assert.equal(encodeChord({ key: "J" }), "j");
  assert.equal(encodeChord({ key: "g", metaKey: true, shiftKey: true }), "mod+shift+g");
  assert.equal(encodeChord({ key: "g", ctrlKey: true, shiftKey: true }), "mod+shift+g");
  assert.equal(encodeChord({ key: "ArrowDown" }), "arrowdown");
  assert.equal(encodeChord({ key: "ArrowDown", shiftKey: true }), "shift+arrowdown");
});

test("shift is not recorded for keys it reshapes", () => {
  // "?" already IS shift+/, so "shift+?" would never match a real event.
  assert.equal(encodeChord({ key: "?", shiftKey: true }), "?");
});

test("formatChord reads like a key cap", () => {
  assert.equal(formatChord("mod+shift+g"), "⌘⇧g");
  assert.equal(formatChord("arrowdown"), "↓");
  assert.equal(formatChord("escape"), "Esc");
  assert.equal(formatChord("j"), "j");
});

test("lookup honours scope", () => {
  assert.equal(lookup(DEFAULT_BINDINGS, "e", "list"), "archive");
  assert.equal(lookup(DEFAULT_BINDINGS, "e", "global"), null);
  assert.equal(lookup(DEFAULT_BINDINGS, "shift+arrowdown", "global"), "move-down");
  assert.equal(lookup(DEFAULT_BINDINGS, "mod+shift+g", "global"), "group-cycle");
  assert.equal(lookup(DEFAULT_BINDINGS, "nothing"), null);
});

test("resolveBindings merges over defaults and ignores rubbish", () => {
  const merged = resolveBindings({ archive: ["d"], nonsense: ["q"], pin: "nope" });
  assert.deepEqual(merged.archive, ["d"]);
  assert.deepEqual(merged.pin, DEFAULT_BINDINGS.pin);
  assert.equal("nonsense" in merged, false);
  assert.deepEqual(resolveBindings(null), DEFAULT_BINDINGS);
  assert.deepEqual(resolveBindings("x"), DEFAULT_BINDINGS);
});

test("resolveBindings lets an action be unbound", () => {
  assert.deepEqual(resolveBindings({ undo: [] }).undo, []);
});

test("conflicts names the other claimant, not the action being edited", () => {
  assert.deepEqual(conflicts(DEFAULT_BINDINGS, "e", "archive"), []);
  assert.deepEqual(conflicts(DEFAULT_BINDINGS, "e", "pin"), ["archive"]);
});

test("chords the host or the OS owns are refused", () => {
  for (const chord of ["mod+c", "mod+v", "mod+shift+p", "mod+q"]) {
    assert.equal(isReserved(chord), true, chord);
  }
  assert.equal(isReserved("mod+shift+g"), false);
  assert.equal(isReserved("e"), false);
});
