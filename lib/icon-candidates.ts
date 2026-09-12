// Where a project's OWN icon lives, in preference order.
//
// This is a fixed list of conventional paths, not a search. That is deliberate.
// A recursive scan of a real repo's asset roots finds `public/test-assets/`
// full of customer logos and `app/assets/images/logos/` full of integration
// partners — showing another company’s mark as a project’s icon is worse than showing
// no icon at all. Only paths that conventionally mean "this application's own
// mark" are trusted.

export const ICON_CANDIDATES: readonly string[] = [
  // Web app conventions, best quality first.
  "public/apple-touch-icon.png",
  "public/icon.svg",
  "public/icon.png",
  "public/logo.svg",
  "public/logo.png",
  "public/favicon.svg",
  "public/favicon-96x96.png",
  "public/favicon-32x32.png",
  "public/favicon.ico",
  // Static-site generators.
  "static/apple-touch-icon.png",
  "static/icon.svg",
  "static/icon.png",
  "static/logo.svg",
  "static/logo.png",
  "static/favicon.svg",
  "static/favicon.ico",
  // Rails and similar, where the app's own mark is kept apart from vendor art.
  "app/assets/images/logo/apple-touch-icon.png",
  "app/assets/images/logo/logomark.svg",
  "app/assets/images/logo/logo.svg",
  "app/assets/images/logo/logo.png",
  "app/assets/images/logo/favicon-96x96.png",
  "app/assets/images/logo.svg",
  "app/assets/images/logo.png",
  "app/assets/images/icon.svg",
  "app/assets/images/icon.png",
  // Repo-level marks.
  ".github/logo.svg",
  ".github/logo.png",
  "docs/images/logo.svg",
  "docs/images/logo.png",
  "docs/images/logo.webp",
  "assets/logo.svg",
  "assets/logo.png",
  "assets/icon.png",
  "logo.svg",
  "logo.png",
  "icon.svg",
  "icon.png",
  "favicon.svg",
  "favicon.ico",
];

const MIME_BY_EXTENSION: Record<string, string> = {
  svg: "image/svg+xml",
  png: "image/png",
  webp: "image/webp",
  ico: "image/x-icon",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
};

/** The image type a path promises, or null when it is not an image we serve. */
export function mimeForPath(path: string): string | null {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXTENSION[extension] ?? null;
}

/**
 * Whether a candidate the user named is safe to read: relative, inside the
 * project, and an image. An override arrives from a settings field, so it is
 * untrusted input like any other.
 */
export function isSafeRelativePath(path: string): boolean {
  if (path === "" || path.length > 256) return false;
  if (path.startsWith("/") || path.startsWith("~")) return false;
  if (/^[a-zA-Z]:/.test(path)) return false;
  if (path.includes("\\")) return false;
  if (path.split("/").includes("..")) return false;
  return mimeForPath(path) !== null;
}

/** Parse the per-project override setting: one `project = path` per line. */
export function parseIconOverrides(raw: string): Map<string, string> {
  const overrides = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const split = trimmed.indexOf("=");
    if (split === -1) continue;
    const name = trimmed.slice(0, split).trim().toLowerCase();
    const path = trimmed.slice(split + 1).trim();
    if (name === "" || !isSafeRelativePath(path)) continue;
    overrides.set(name, path);
  }
  return overrides;
}
