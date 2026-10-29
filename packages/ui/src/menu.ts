// Pure rules behind ContextMenu, kept apart from React so they can be tested without a DOM.
// Keyboard model follows the WAI-ARIA menu pattern: disabled items stay focusable so their reason
// can be read, separators are skipped, focus wraps at both ends.

export const SEPARATOR = "separator" as const;

export interface MenuItemSpec {
  id: string;
  /** When set, the item is disabled and this text says why. */
  disabledReason?: string | null;
}

export type MenuEntry<T extends MenuItemSpec = MenuItemSpec> = T | typeof SEPARATOR;

export const isItem = <T extends MenuItemSpec>(e: MenuEntry<T>): e is T => e !== SEPARATOR;

/** Index of the item focused when the menu opens: the first enabled one, else the first item. */
export function initialIndex(entries: MenuEntry[]): number {
  const enabled = entries.findIndex((e) => isItem(e) && !e.disabledReason);
  return enabled >= 0 ? enabled : entries.findIndex(isItem);
}

/** Next focusable index from `from` in direction `dir` ("first"/"last" jump to the ends). */
export function moveIndex(entries: MenuEntry[], from: number, dir: 1 | -1 | "first" | "last"): number {
  const items = entries.map((e, i) => (isItem(e) ? i : -1)).filter((i) => i >= 0);
  if (items.length === 0) return -1;
  if (dir === "first") return items[0]!;
  if (dir === "last") return items[items.length - 1]!;
  const pos = items.indexOf(from);
  if (pos < 0) return dir === 1 ? items[0]! : items[items.length - 1]!;
  return items[(pos + dir + items.length) % items.length]!;
}

/** Collapses leading, trailing and doubled separators left behind when items are filtered out. */
export function tidySeparators<T extends MenuItemSpec>(entries: MenuEntry<T>[]): MenuEntry<T>[] {
  const out: MenuEntry<T>[] = [];
  for (const e of entries) {
    if (e === SEPARATOR && (out.length === 0 || out[out.length - 1] === SEPARATOR)) continue;
    out.push(e);
  }
  while (out[out.length - 1] === SEPARATOR) out.pop();
  return out;
}

/** Keeps a menu of size w × h fully inside the viewport, at least `margin` px from each edge. */
export function clampMenu(x: number, y: number, w: number, h: number, vw: number, vh: number, margin = 8): { left: number; top: number } {
  const left = Math.max(margin, Math.min(x, vw - w - margin));
  // A menu taller than the room below the pointer opens upwards instead of being pushed off-screen.
  const below = y + h + margin <= vh;
  const top = below ? y : Math.max(margin, Math.min(y - h, vh - h - margin));
  return { left, top };
}
