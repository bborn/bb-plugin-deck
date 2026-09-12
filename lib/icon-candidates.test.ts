import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ICON_CANDIDATES,
  isSafeRelativePath,
  mimeForPath,
  parseIconOverrides,
} from "./icon-candidates.ts";

test("every candidate is a relative image path", () => {
  for (const path of ICON_CANDIDATES) {
    assert.equal(isSafeRelativePath(path), true, path);
  }
});

test("candidates are unique and ordered best first", () => {
  assert.equal(new Set(ICON_CANDIDATES).size, ICON_CANDIDATES.length);
  assert.equal(ICON_CANDIDATES[0], "public/apple-touch-icon.png");
  assert.ok(
    ICON_CANDIDATES.indexOf("public/icon.svg") <
      ICON_CANDIDATES.indexOf("public/favicon.ico"),
  );
});

test("no candidate reaches into a vendor asset directory", () => {
  for (const path of ICON_CANDIDATES) {
    assert.ok(!path.includes("logos/"), path);
    assert.ok(!path.includes("test-assets"), path);
    assert.ok(!path.includes("integrations"), path);
  }
});

test("mime comes from the extension", () => {
  assert.equal(mimeForPath("public/icon.svg"), "image/svg+xml");
  assert.equal(mimeForPath("a/b/LOGO.PNG"), "image/png");
  assert.equal(mimeForPath("docs/images/logo.webp"), "image/webp");
  assert.equal(mimeForPath("readme.md"), null);
  assert.equal(mimeForPath("noextension"), null);
});

test("unsafe override paths are refused", () => {
  assert.equal(isSafeRelativePath("/etc/passwd.png"), false);
  assert.equal(isSafeRelativePath("~/secrets.png"), false);
  assert.equal(isSafeRelativePath("../../outside.png"), false);
  assert.equal(isSafeRelativePath("a/../../b.png"), false);
  assert.equal(isSafeRelativePath("C:\\windows\\icon.png"), false);
  assert.equal(isSafeRelativePath("config/database.yml"), false);
  assert.equal(isSafeRelativePath(""), false);
  assert.equal(isSafeRelativePath(`${"a".repeat(300)}.png`), false);
});

test("safe override paths are allowed, including dotted names", () => {
  assert.equal(isSafeRelativePath("app/assets/images/logo/Logomark.svg"), true);
  assert.equal(isSafeRelativePath("some.dir/my.logo.png"), true);
});

test("overrides parse as project = path, one per line", () => {
  const overrides = parseIconOverrides(
    [
      "# a comment",
      "checkout = app/assets/images/logo/Logomark.svg",
      "  Analytics=public/apple-touch-icon.png  ",
      "",
      "broken line with no equals",
      "escape = ../../etc/icon.png",
      "notimage = README.md",
    ].join("\n"),
  );
  assert.equal(overrides.get("checkout"), "app/assets/images/logo/Logomark.svg");
  assert.equal(overrides.get("analytics"), "public/apple-touch-icon.png");
  assert.equal(overrides.has("escape"), false);
  assert.equal(overrides.has("notimage"), false);
  assert.equal(overrides.size, 2);
});
