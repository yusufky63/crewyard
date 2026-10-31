// Every keyboard shortcut of the app in one place (DESIGN.md §7). Handlers ask `matches(e, id)`,
// keycap hints come from `keycaps(id)`, and the help overlay (`?`, F1) lists this table, so the
// three cannot drift apart. keys.test.ts fails when an id is registered but no handler uses it, or
// a handler asks for an id that is not registered.

export interface Chord {
  /** KeyboardEvent.key; letters match either case. */
  key: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}

export type ShortcutGroup = "global" | "navigate" | "lists" | "tasks" | "panel" | "graph" | "review";

export interface Shortcut {
  id: string;
  group: ShortcutGroup;
  chords: Chord[];
  /** A key pressed just before, for two-key sequences such as G then T. */
  after?: string;
  /** How the overlay shows it when listing every chord would be noise (the four arrows). */
  display?: string[][];
}

const arrows = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];

export const SHORTCUTS = [
  { id: "palette", group: "global", chords: [{ key: "k", ctrl: true }] },
  { id: "sidebar", group: "global", chords: [{ key: "b", ctrl: true }] },
  { id: "drawer", group: "global", chords: [{ key: "j", ctrl: true }] },
  { id: "help", group: "global", chords: [{ key: "?" }, { key: "F1" }] },
  { id: "close", group: "global", chords: [{ key: "Escape" }] },
  { id: "go.tasks", group: "navigate", after: "g", chords: [{ key: "t" }] },
  { id: "go.inbox", group: "navigate", after: "g", chords: [{ key: "i" }] },
  { id: "go.crew", group: "navigate", after: "g", chords: [{ key: "g" }] },
  { id: "go.limits", group: "navigate", after: "g", chords: [{ key: "l" }] },
  { id: "go.providers", group: "navigate", after: "g", chords: [{ key: "p" }] },
  { id: "go.github", group: "navigate", after: "g", chords: [{ key: "h" }] },
  { id: "go.guide", group: "navigate", after: "g", chords: [{ key: "w" }] },
  { id: "list.next", group: "lists", chords: [{ key: "j" }] },
  { id: "list.prev", group: "lists", chords: [{ key: "k" }] },
  { id: "submit", group: "tasks", chords: [{ key: "Enter", ctrl: true }] },
  { id: "assistant", group: "panel", chords: [{ key: "a", ctrl: true, shift: true }] },
  { id: "assistant.send", group: "panel", chords: [{ key: "Enter" }] },
  // Ctrl ` as in most editors; Ctrl Shift T for layouts (Turkish Q) where ` is hard to reach.
  { id: "panel.terminal", group: "panel", chords: [{ key: "`", ctrl: true }, { key: "t", ctrl: true, shift: true }] },
  { id: "panel.problems", group: "panel", chords: [{ key: "m", ctrl: true, shift: true }] },
  { id: "terminal.close", group: "panel", chords: [{ key: "Delete" }] },
  { id: "terminal.leave", group: "panel", chords: [{ key: "F6" }] },
  { id: "graph.full", group: "graph", chords: [{ key: "f" }] },
  { id: "graph.menu", group: "graph", chords: [{ key: "F10", shift: true }, { key: "ContextMenu" }] },
  { id: "graph.move", group: "graph", chords: arrows.map((key) => ({ key, alt: true })), display: [["Alt", "←", "↑", "→", "↓"]] },
  { id: "graph.select", group: "graph", chords: [{ key: "Enter" }, { key: " " }] },
  { id: "graph.zoomIn", group: "graph", chords: [{ key: "+" }, { key: "=" }] },
  { id: "graph.zoomOut", group: "graph", chords: [{ key: "-" }] },
  { id: "review.next", group: "review", chords: [{ key: "j" }, { key: "ArrowDown" }] },
  { id: "review.prev", group: "review", chords: [{ key: "k" }, { key: "ArrowUp" }] },
  { id: "review.pageDown", group: "review", chords: [{ key: "PageDown" }] },
  { id: "review.pageUp", group: "review", chords: [{ key: "PageUp" }] },
  { id: "review.first", group: "review", chords: [{ key: "Home" }] },
  { id: "review.last", group: "review", chords: [{ key: "End" }] },
  { id: "review.nextFile", group: "review", chords: [{ key: "n" }, { key: "]" }] },
  { id: "review.prevFile", group: "review", chords: [{ key: "p" }, { key: "[" }] },
  { id: "review.comment", group: "review", chords: [{ key: "Enter" }, { key: "c" }] },
  { id: "review.remove", group: "review", chords: [{ key: "Delete" }, { key: "Backspace" }] },
] as const satisfies readonly Shortcut[];

export type ShortcutId = (typeof SHORTCUTS)[number]["id"];

export const GROUPS: ShortcutGroup[] = ["global", "navigate", "lists", "tasks", "panel", "graph", "review"];

const byId = new Map<string, Shortcut>(SHORTCUTS.map((s) => [s.id, s]));

export function shortcut(id: ShortcutId): Shortcut {
  return byId.get(id)!;
}

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const isLetter = (k: string) => k.length === 1 && k.toLowerCase() !== k.toUpperCase();

function chordMatches(c: Chord, e: KeyLike): boolean {
  const key = isLetter(c.key) ? e.key.toLowerCase() === c.key.toLowerCase() : e.key === c.key;
  if (!key) return false;
  if (Boolean(c.ctrl) !== (e.ctrlKey || e.metaKey)) return false;
  if (Boolean(c.alt) !== e.altKey) return false;
  // `?` and `+` need Shift on most layouts, so Shift is only checked for letters and named keys.
  const printable = c.key.length === 1 && !isLetter(c.key);
  return printable || Boolean(c.shift) === e.shiftKey;
}

export function matches(e: KeyLike, id: ShortcutId): boolean {
  const s = shortcut(id);
  // A sequence's second key alone is not the shortcut; sequenceStep() tracks the first.
  return !s.after && s.chords.some((c) => chordMatches(c, e));
}

export interface SequenceState {
  prefix: string | null;
  at: number;
}

/** How long the first key of a sequence waits for the second. */
export const SEQUENCE_MS = 1500;

/**
 * One key of a two-key sequence: returns the shortcut it completes, if any, and what to remember for
 * the next key. Any other key clears a waiting prefix.
 */
export function sequenceStep(state: SequenceState, e: KeyLike, now: number): { state: SequenceState; id: ShortcutId | null } {
  const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
  const pending = state.prefix && now - state.at <= SEQUENCE_MS ? state.prefix : null;
  if (pending && plain) {
    const hit = SHORTCUTS.find((s) => "after" in s && s.after === pending && s.chords.some((c) => chordMatches(c, e)));
    if (hit) return { state: { prefix: null, at: 0 }, id: hit.id };
  }
  const starts = plain && SHORTCUTS.some((s) => "after" in s && s.after === e.key.toLowerCase());
  return { state: starts ? { prefix: e.key.toLowerCase(), at: now } : { prefix: null, at: 0 }, id: null };
}

const NAMES: Record<string, string> = {
  Escape: "Esc",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  " ": "Space",
  ContextMenu: "Menu",
  PageDown: "PgDn",
  PageUp: "PgUp",
  Backspace: "Backspace",
};

/** Keycaps per chord, e.g. [["Ctrl", "K"]]; `space` names the space bar in the UI language. */
export function keycaps(id: ShortcutId, space = "Space"): string[][] {
  const s = shortcut(id);
  if (s.display) return s.display;
  return s.chords.map((c) => {
    const caps: string[] = s.after ? [s.after.toUpperCase()] : [];
    if (c.ctrl) caps.push("Ctrl");
    if (c.alt) caps.push("Alt");
    if (c.shift) caps.push("Shift");
    const name = c.key === " " ? space : (NAMES[c.key] ?? (c.key.length === 1 ? c.key.toUpperCase() : c.key));
    caps.push(name);
    return caps;
  });
}

/** The first chord as text for a tooltip, e.g. "Ctrl B". */
export const keyText = (id: ShortcutId) => keycaps(id)[0]!.join(" ");

/** For aria-keyshortcuts, e.g. "Control+B". */
export function ariaKeys(id: ShortcutId): string {
  return shortcut(id)
    .chords.map((c) => [c.ctrl ? "Control" : null, c.alt ? "Alt" : null, c.shift ? "Shift" : null, c.key === " " ? "Space" : c.key.length === 1 ? c.key.toUpperCase() : c.key].filter(Boolean).join("+"))
    .join(" ");
}
