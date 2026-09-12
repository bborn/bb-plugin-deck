import assert from "node:assert/strict";
import { test } from "node:test";
import { colorForHue, hueForSlot, projectInitials } from "./project-visuals.ts";

test("a slot always gives the same hue", () => {
  assert.equal(hueForSlot(3), hueForSlot(3));
});

test("hues stay in range", () => {
  for (const slot of [0, 1, 7, 42, 359, 1000]) {
    const hue = hueForSlot(slot);
    assert.ok(hue >= 0 && hue < 360, `${slot} → ${hue}`);
  }
});

test("consecutive slots are far apart — the failure hashing had", () => {
  const separation = (a: number, b: number) => {
    const raw = Math.abs(a - b) % 360;
    return Math.min(raw, 360 - raw);
  };
  for (let slot = 0; slot < 12; slot += 1) {
    assert.ok(
      separation(hueForSlot(slot), hueForSlot(slot + 1)) > 80,
      `slots ${slot} and ${slot + 1} are too close`,
    );
  }
});

test("the first several slots are all visibly distinct", () => {
  const separation = (a: number, b: number) => {
    const raw = Math.abs(a - b) % 360;
    return Math.min(raw, 360 - raw);
  };
  const hues = Array.from({ length: 8 }, (_, slot) => hueForSlot(slot));
  for (let a = 0; a < hues.length; a += 1) {
    for (let b = a + 1; b < hues.length; b += 1) {
      assert.ok(
        separation(hues[a]!, hues[b]!) > 20,
        `slots ${a} and ${b} collide at ${hues[a]} / ${hues[b]}`,
      );
    }
  }
});

test("the colour is a usable oklch string", () => {
  assert.match(colorForHue(200), /^oklch\(0\.55 0\.15 200\)$/);
  assert.match(colorForHue(-40), /^oklch\(0\.55 0\.15 320\)$/);
});

test("initials prefer word boundaries", () => {
  assert.equal(projectInitials("checkout"), "CH");
  assert.equal(projectInitials("influence kit"), "IK");
  assert.equal(projectInitials("my-side-project"), "MS");
  assert.equal(projectInitials("Personal"), "PE");
});

test("initials survive names with no letters", () => {
  assert.equal(projectInitials(""), "?");
  assert.equal(projectInitials("   "), "?");
  assert.equal(projectInitials("🙂"), "?");
});
