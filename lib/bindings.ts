// Key bindings as data, not as literals scattered through a handler.
//
// A chord is a normalised string: modifiers in a fixed order, then the key,
// all lowercase — "j", "arrowdown", "mod+shift+g". "mod" is Command on a Mac
// and Control elsewhere, which is the same thing bb's own keyboard settings
// mean by it. Storing chords this way means comparing an event to a binding is
// a string lookup, and that the settings page can record one by listening.

export type ActionId =
  | "move-down"
  | "move-up"
  | "search"
  | "write"
  | "list"
  | "open"
  | "open-split"
  | "archive"
  | "undo"
  | "pin"
  | "read"
  | "pull-request"
  | "group-cycle"
  | "sort-cycle"
  | "unread-first"
  | "view-save"
  | "view-delete"
  | "fold"
  | "unfold"
  | "fold-toggle"
  | "width-narrow"
  | "width-wide"
  | "width-reset"
  | "help";

/**
 * Where an action is allowed to fire. `global` actions work even while you are
 * typing, so they must carry a modifier; `list` actions fire only when the list
 * itself holds the caret, which is what lets them be bare letters.
 */
export type Scope = "global" | "list";

export interface ActionSpec {
  id: ActionId;
  label: string;
  scope: Scope;
  group: "Moving" | "Acting" | "Organising" | "Layout";
}

export const ACTIONS: readonly ActionSpec[] = [
  { id: "move-down", label: "Next thread", scope: "global", group: "Moving" },
  { id: "move-up", label: "Previous thread", scope: "global", group: "Moving" },
  { id: "write", label: "Write: focus the message box", scope: "list", group: "Moving" },
  { id: "list", label: "Back to the list", scope: "global", group: "Moving" },
  { id: "search", label: "Search", scope: "list", group: "Moving" },
  { id: "open", label: "Open the thread", scope: "list", group: "Moving" },
  { id: "open-split", label: "Open in a split", scope: "list", group: "Moving" },
  { id: "archive", label: "Archive", scope: "list", group: "Acting" },
  { id: "undo", label: "Undo the last archive", scope: "list", group: "Acting" },
  { id: "pin", label: "Pin or unpin", scope: "list", group: "Acting" },
  { id: "read", label: "Mark read or unread", scope: "list", group: "Acting" },
  { id: "pull-request", label: "Open the pull request", scope: "list", group: "Acting" },
  { id: "group-cycle", label: "Cycle grouping", scope: "global", group: "Organising" },
  { id: "sort-cycle", label: "Cycle sorting", scope: "global", group: "Organising" },
  { id: "unread-first", label: "Toggle unread first", scope: "list", group: "Organising" },
  { id: "view-save", label: "Save this search as a view", scope: "list", group: "Organising" },
  { id: "view-delete", label: "Delete the view you are in", scope: "list", group: "Organising" },
  { id: "fold", label: "Up to the group header, then fold", scope: "list", group: "Organising" },
  { id: "unfold", label: "Unfold the group header", scope: "list", group: "Organising" },
  { id: "fold-toggle", label: "Toggle the group you are in", scope: "list", group: "Organising" },
  { id: "width-narrow", label: "Narrow the list", scope: "list", group: "Layout" },
  { id: "width-wide", label: "Widen the list", scope: "list", group: "Layout" },
  { id: "width-reset", label: "Reset the width", scope: "list", group: "Layout" },
  { id: "help", label: "Show the keyboard sheet", scope: "list", group: "Layout" },
];

export type Bindings = Record<ActionId, string[]>;

export const DEFAULT_BINDINGS: Bindings = {
  "move-down": ["arrowdown", "j", "shift+arrowdown"],
  "move-up": ["arrowup", "k", "shift+arrowup"],
  search: ["/"],
  write: ["tab"],
  list: ["escape"],
  open: ["enter"],
  "open-split": ["o"],
  archive: ["e"],
  undo: ["u"],
  pin: ["p"],
  read: ["m"],
  "pull-request": ["."],
  "group-cycle": ["g", "mod+shift+g"],
  "sort-cycle": ["s", "mod+shift+s"],
  "unread-first": ["f"],
  "view-save": ["v"],
  "view-delete": ["x"],
  fold: ["arrowleft"],
  unfold: ["arrowright"],
  "fold-toggle": ["c"],
  "width-narrow": ["["],
  "width-wide": ["]"],
  "width-reset": ["\\"],
  help: ["?"],
};

interface ChordEvent {
  key: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}

/** The chord a keyboard event represents, in the stored form. */
export function encodeChord(event: ChordEvent): string {
  const mod = event.metaKey === true || event.ctrlKey === true;
  const parts: string[] = [];
  if (mod) parts.push("mod");
  // Shift is a modifier except on a bare character key, where it has already
  // been spent reshaping the character: "?" IS shift+/, so recording it as
  // "shift+?" would never match a real event. Under mod or alt no character is
  // produced, so shift is meaningful again (⌘⇧G is not ⌘G).
  const character = event.key.length === 1;
  const shiftMatters = !character || mod || event.altKey === true;
  if (event.shiftKey === true && shiftMatters) parts.push("shift");
  if (event.altKey === true) parts.push("alt");
  parts.push(event.key.toLowerCase());
  return parts.join("+");
}

const SYMBOLS: Record<string, string> = {
  mod: "⌘",
  shift: "⇧",
  alt: "⌥",
  arrowdown: "↓",
  arrowup: "↑",
  arrowleft: "←",
  arrowright: "→",
  enter: "⏎",
  escape: "Esc",
  tab: "Tab",
  " ": "Space",
  backspace: "⌫",
};

/** A chord as a person reads it. */
export function formatChord(chord: string): string {
  const parts = chord.split("+");
  const key = parts.pop() ?? "";
  const mods = parts.map((part) => SYMBOLS[part] ?? part).join("");
  const shown = SYMBOLS[key] ?? (key.length === 1 ? key : key);
  return `${mods}${shown}`;
}

/** Merge stored bindings over the defaults, dropping anything unrecognised. */
export function resolveBindings(stored: unknown): Bindings {
  const merged: Bindings = { ...DEFAULT_BINDINGS };
  if (typeof stored !== "object" || stored === null) return merged;
  for (const [id, chords] of Object.entries(stored as Record<string, unknown>)) {
    if (!(id in DEFAULT_BINDINGS)) continue;
    if (!Array.isArray(chords)) continue;
    const clean = chords
      .filter((chord): chord is string => typeof chord === "string")
      .map((chord) => chord.trim().toLowerCase())
      .filter((chord) => chord !== "")
      .slice(0, 4);
    merged[id as ActionId] = clean;
  }
  return merged;
}

/**
 * Where a chord may fire, decided by the chord rather than the action: a bare
 * key types a character, so it can only belong to the list. Anything carrying
 * mod, alt, or shift produces no character (encodeChord only records shift for
 * keys that do not reshape under it) and is safe while you are typing.
 */
export function chordScope(chord: string): Scope {
  // Escape is the exception: it types nothing and a text field does nothing
  // with it, so "get me out of here" has to work from inside one.
  return chord.includes("+") || chord === "escape" ? "global" : "list";
}

/** Which action a chord fires, honouring scope. Null when nothing matches. */
export function lookup(
  bindings: Bindings,
  chord: string,
  scope: Scope | "any" = "any",
): ActionId | null {
  if (scope !== "any" && chordScope(chord) !== scope && scope === "global") {
    return null;
  }
  for (const action of ACTIONS) {
    if (bindings[action.id].includes(chord)) return action.id;
  }
  return null;
}

/**
 * Actions already using a chord, other than the one being edited. Two actions
 * on one chord means the first in ACTIONS order silently wins, so the settings
 * page has to say so rather than let it happen.
 */
export function conflicts(
  bindings: Bindings,
  chord: string,
  exclude: ActionId,
): ActionId[] {
  return ACTIONS.filter(
    (action) => action.id !== exclude && bindings[action.id].includes(chord),
  ).map((action) => action.id);
}

/**
 * Chords the plugin must not take. Everything here either belongs to the host
 * or would make text entry impossible.
 */
export function isReserved(chord: string): boolean {
  return (
    chord === "mod+c" ||
    chord === "mod+v" ||
    chord === "mod+x" ||
    chord === "mod+a" ||
    chord === "mod+z" ||
    chord === "mod+shift+p" ||
    chord === "mod+n" ||
    chord === "mod+w" ||
    chord === "mod+q"
  );
}
