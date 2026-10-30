import { useEffect, useEffectEvent } from "react";
import { matches } from "./keys.ts";

// J and K move the selection in a screen's main list (DESIGN.md §7): Tasks and the Inbox. They are
// single keys, so they do nothing while you type in a field, while a dialog or a menu has the
// keyboard (the diff review uses J and K for its own lines), or with a modifier held.

const typing = (el: EventTarget | null) => el instanceof HTMLElement && Boolean(el.closest("input, textarea, select, [contenteditable]"));

/** The id one step away from `current`; from no selection, J starts at the top and K at the bottom. */
export function listStep(ids: readonly string[], current: string | null, step: 1 | -1): string | null {
  if (ids.length === 0) return null;
  const at = current === null ? -1 : ids.indexOf(current);
  if (at === -1) return step > 0 ? ids[0]! : ids[ids.length - 1]!;
  return ids[Math.min(ids.length - 1, Math.max(0, at + step))]!;
}

/** Scrolls the row marked `data-list-id` into view and focuses it, so Enter and Tab act on it next. */
function reveal(id: string, retry = true): void {
  const el = document.querySelector<HTMLElement>(`[data-list-id="${CSS.escape(id)}"]`);
  if (el) {
    el.scrollIntoView({ block: "nearest" });
    el.focus({ preventScroll: true });
  } else if (retry) {
    // A Tasks row far down mounts only once it nears the view (LazyRow).
    setTimeout(() => reveal(id, false), 150);
  }
}

export function useListKeys(ids: readonly string[], current: string | null, select: (id: string) => void, enabled = true): void {
  // The listener is added once; the event reads the list as it is at the key press.
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (e.defaultPrevented || typing(e.target) || document.querySelector("dialog[open], [role=menu]")) return;
    const step = matches(e, "list.next") ? 1 : matches(e, "list.prev") ? -1 : 0;
    if (step === 0) return;
    const next = listStep(ids, current, step);
    if (next === null) return;
    e.preventDefault();
    if (next !== current) select(next);
    // After React has applied the selection. Not requestAnimationFrame: a window in the background
    // runs no frames, and focus would stay behind.
    setTimeout(() => reveal(next), 0);
  });
  useEffect(() => {
    if (!enabled) return;
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
