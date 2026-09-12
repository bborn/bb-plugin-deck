# bb-plugin-inbox

**Inbox** for BB: one searchable list of every thread, with bb's own thread
view beside it, so a context switch costs a keystroke instead of a navigation.

- `server.ts` — tags, the agent's standing note, saved views, deep search, and
  project icons.
- `app.tsx` — the Inbox page: the list, and bb's `ThreadChat` in the pane.
- `lib/query.ts`, `lib/display.ts`, `lib/project-visuals.ts`,
  `lib/icon-candidates.ts` — the search language, grouping and sorting, project
  marks, and the icon candidate list. All pure and unit-tested (`npm test`,
  Node's own runner, no framework).
- `skills/inbox/SKILL.md` — the skill that tells agents to keep their note
  current and to say what they are blocked on.

## Why it is not a board

It was a kanban board first. Columns turned out to be the wrong primitive: the
states that matter are not assigned, they are facts about the thread, and
nobody wants to drag work between lanes to keep a picture honest.

So the inbox derives everything:

| State | Means |
| --- | --- |
| **Needs you** | The agent asked something, hit an error, or declared what it is waiting for. |
| **Working** | A turn, workflow, background agent, plan, or goal is running. |
| **Idle** | Nothing running, nothing asked. |
| **Done** | Archived. |

"Needs you" sorts first and is the only one drawn in red, because it is the
only one that costs you anything to miss. `e` archives, which is the one piece
of state you do set, and the host raises its own undo toast for it.

An agent declaring `blockedOn` through `task_note` counts as Needs you. bb only
knows about its own interaction prompts, so without that a thread that asked
for a decision in prose would sit under Idle looking finished.

## Search

One box. Tokens combine with AND, except `is:`, which is OR because "blocked or
working" is the useful reading.

| Type this | To find |
| --- | --- |
| `ol-3857` | A Linear ticket in a title or branch. |
| `#3553` or `pr:3553` | A pull request, by number. |
| `sean/ol-3850` | A branch. |
| `[offerlab]` | A project. Repeat to OR several; a picker opens on `[`. |
| `is:blocked` | Also `is:working`, `is:idle`, `is:done`. |
| `tag:slop` | A tag you or an agent set. |
| `since:3d`, `before:2026-09-01` | When it was last touched. |
| `stripe webhook` | Any text, across all of the above. |

Every term must hit, so more words narrow. Each term matches as a substring or
a subsequence, so `ofl` still finds `offerlab`.

When the live list comes up short, the plugin also searches bb's full index,
including **archived** threads and **message bodies**, and shows those under
"Also in the archive" with the matching snippet. That matters: a board of 200
tasks is typically 187 done, and the one you are looking for is usually one of
them.

## Organize and sort

A menu beside the search box, in bb's own sidebar wording so the two surfaces
do not teach different words for the same idea.

| Organize | Sort by | Toggle |
| --- | --- | --- |
| By state (default), By project, By day, Flat | Updated at (default), Created at, Alphabetical | Show unread first |

Pinned threads always lead, in their own group. Pinning is a deliberate act,
and scattering pins through a project or day grouping would make the act
pointless. The menu stays open while you click, so trying two groupings is one
gesture instead of four. The choice is stored server-side, so it follows you
between the inboxtop app and a browser, unlike the pane width, which is per
device on purpose.

### What this deliberately does not duplicate

bb's sidebar already organizes threads by project or machine and sorts by
updated, created, or alphabetical. The overlap is real, and it is not the
point. The sidebar organizes **browsing**: where is my offerlab work. The inbox
organizes **triage**: what needs me, across everything. That is why its default
grouping is by state, which the sidebar cannot do at all, and why a blocked
thread in offerlab and a blocked thread in influencekit land in the same group
here and in different sections there.

Project and day grouping exist as alternates because once you are looking at
one list of everything, you sometimes want it cut the other way. They are not
an attempt to become a second sidebar.

## Saved views

Name any search and it becomes a chip, reachable by its number key. Right-click
a chip to delete it. Nine of them, one per digit.

A view saves the **layout** with the query. A view that restored your search but
dropped you into someone else's grouping would be a bug waiting to happen.

## Keys

| Key | Does |
| --- | --- |
| `/` | Jump to search. Arrows still move the list from inside the box. |
| `j` `k` or arrows | Move. |
| `Enter` | Open the thread. `o` opens it in a split. |
| `r` | Jump to the reply box. `⌘↩` sends. |
| `e` | Archive. |
| `p` | Pin. |
| `1`-`9` | Saved views. |
| `Escape` | Clear the search, then leave the field. |

The split between the list and the context pane is draggable, and remembered.
Focus the divider and use the arrow keys (hold shift for a bigger step), or
double-click it, or press Home, to reset. The width clamps so the list never
drops under 280px and the context pane always keeps 360px, and it re-clamps
when the window shrinks. It lives in `localStorage`, not plugin storage, on
purpose: the right split depends on the screen you are at, so a laptop should
not inherit a monitor's layout.

Inbox-wide keys work with nothing selected, which is exactly when you need them:
a search that matches nothing still has to let you press Escape or a view key.

## Agent tools

| Tool | Effect |
| --- | --- |
| `task_note` | The standing one-line summary, plus `blockedOn` when the agent needs you. |
| `task_tag` | Add or remove tags. |

Tool sets apply at the next session start, so a thread already running when the
plugin was installed does not see them until it restarts.

## Project marks

Each row carries its project's own icon. Under a **project** grouping the mark
moves up to the group header and the rows stop repeating it, since the header
already says which project they are in.

There used to be a coloured bar down the left of every row, keyed to a
generated hue. It is gone. An invented colour sitting beside a real brand mark
reads as noise, not information, and it never matched the actual project. The
generated hue now survives only on the initials chip for a project we could not
find an icon for, where it is the only identity available. If you want project
colour to mean something, the honest fix is a per-project setting, not a hash.

**The icon** is the project's own mark, read out of its checkout and cached as
bytes, served from the plugin's own HTTP route keyed by digest. Detection walks
a fixed list of conventional paths (`lib/icon-candidates.ts`), best first, and
stops at the first non-empty file. It is deliberately not a search: scanning a
real repo's asset roots turns up `public/test-assets/` full of customers' logos
and `app/assets/images/logos/` full of integration partners, and showing
Heroku's mark as a project's icon is worse than showing none. Zero-byte files
are skipped too, because Rails ships empty placeholder favicons.

Point the inbox at a mark it did not find with the **Project icon overrides**
setting, one `project = repo/relative/path.svg` per line; editing it re-looks
immediately. GitHub is not used as a source: owner avatars are the only icon it
exposes, and one owner covers several repos, so they would all come out
identical.

## The mark

`assets/inbox.svg`, an inbox tray. Two earlier attempts did not survive the
sidebar:

- `ListTodo`, the scaffold default, is a checklist, and his sidebar already had
  two of those (Chief of staff and Tasks).
- A split-pane glyph, list lines beside an open pane, described the page
  exactly and failed anyway: at 16px the lines merged into a solid block and it
  read as the panel-toggle button in the app chrome.

The tray works because its silhouette is bold enough to survive the size, and
because nothing else in that sidebar is a container. BB serves the file hashed
and draws it as a `currentColor` mask, so it inherits the theme and needs no
colour of its own. It is also declared under `bb.branding.experimental_icons`
as `inbox`, so `task_note` and `task_tag` rows in a transcript carry the same
mark.

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| Project icon overrides | empty | `project = repo/relative/path.svg` per line, for a mark auto-detection misses. |

## UI components

`components/ui/` is vendored source you own (the shadcn model): edit the
files freely — they never update out from under you. Add more from the BB
component registry (the full shadcn set, version-matched to your BB install
via the pinned ref in `components.json`):

```
npx shadcn add @bb/select @bb/table
```

Run `npm install` once before `bb plugin build` — the vendored components'
npm deps bundle into your dist. React, and BB-shimmed packages like the
radix portal primitives and `sonner` (`import { toast } from "sonner"`
reaches BB's own toaster), are provided by the BB app at runtime and never
bundled. Every shimmed package is declared in `devDependencies` at the
host's version so those imports typecheck; keep them there (never in
`dependencies`, which would bundle a second copy), and `bb plugin types`
repins them alongside the SDK. Ship `dist/` (npm tarball or committed for
git installs) so people installing your plugin never need npm.

## Manifest

`package.json` is the plugin manifest. Notable fields:

- `bb.server` — backend entry (required).
- `bb.app` — frontend entry. Delete it, `app.tsx`, `components/`,
  `hooks/`, and `lib/` for a headless plugin.
- `bb.skills` — skill roots; omitted here, so BB reads `skills/`. Each
  directory with a `SKILL.md` is one skill, named after the directory.
- `bb.name` and `bb.description` — required human-facing identity.
- `bb.branding` — required; declare `icon` as a BB icon name or a
  plugin-relative compact SVG, or declare `logo.light` (with optional
  `logo.dark`). Logo assets must be relative `.svg`, `.png`, or
  `.webp` files.
- `engines.bb` — supported bb app version range.
- `engines.bbPluginSdk` — the lowest plugin SDK you need (scaffold:
  `>=0.4.47`). BB reads this as a floor, not a ceiling: a later
  SDK in the same major still loads your plugin.
- `dependencies` — every package your source imports that BB does not provide.
  `bb plugin build` inlines them into `dist/`, and git installs resolve this
  list alone, so a build-required package here rather than in
  `devDependencies` is what keeps your plugin installable. `devDependencies`
  is for types and tooling only (BB shims React, the portal primitives, and
  `@get-bb/plugin-sdk` at runtime — never bundle them).

Run `bb plugin build` before publishing git/npm installs. It writes
`dist/server.js` + `server.meta.json` and `app.js` / `app.css` /
`app.meta.json`. Each `*.meta.json` stamps SDK major/version,
`artifactFormatVersion`, `pluginId`, `pluginVersion`, and
`builtWith` so managed installs can verify the artifacts.

## Store listing

Two texts describe the plugin in the store. `bb.description` in package.json
is the one-sentence hook on every browse card and the lead paragraph on the
detail page; keep it under about 140 characters. `PLUGIN_OVERVIEW.md` is the
same claim at length, shown in an Overview section under that paragraph.
Rewrite the scaffold's copy for your plugin, and update it whenever
`bb.description` changes, so the two never disagree.

The submission to the public BB Community marketplace requires the file. Keep
it under 4000 characters (aim for 700 to 1800) and use headings, paragraphs,
emphasis, code, blockquotes, lists, thematic breaks, and absolute https links
only — raw HTML, images, tables, footnotes, and task lists are rejected. Do
not open with a `#` title or repeat `bb.description` verbatim; the page
shows both directly above.

## Install

From this directory (`bb plugin new` already ran the install; a fresh clone
needs it):

```
npm install
bb plugin install .
```

After editing sources, reload:

```
bb plugin reload kanban
```

Or let `bb plugin dev` rebuild and reload on every save.

## Configure

```
bb plugin config kanban
bb plugin config kanban set showDone false
bb plugin reload kanban
```

## Types & API reference

The plugin API ships as the npm package `@get-bb/plugin-sdk`, pinned to an
exact version in `devDependencies` (`0.4.47` — the SDK of the BB
that scaffolded this plugin). After `npm install`, the full surface is on disk
at:

```
node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts      # backend
node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk-app.d.ts  # frontend
```

Your editor and `tsc` resolve `@get-bb/plugin-sdk` there through ordinary node
resolution — no path mapping. These are readable declarations: open them for an
exact signature.

The SDK surface grows with every BB release, so the pin has to track the BB you
actually run:

```
bb plugin types          # sync this plugin's SDK surface to the running BB
bb plugin types --check  # CI: fail when it does not match
```

Ask BB to write plugins for you: the `bb-plugin-authoring` skill documents
the whole surface with examples.

Confused by the API, or need something the types don't explain? Clone the BB
repo and read the source: <https://github.com/get-bb/bb>.
