// Size rules for resizable panes (DESIGN.md §5 `Splitter`). Pure, so the clamp, keyboard and
// collapse behaviour is tested without a DOM.

/** Arrow keys move a splitter by this many pixels (DESIGN.md §5). */
export const SPLIT_STEP = 16;

export interface SplitBounds {
  min: number;
  max: number;
}

/**
 * Which edge of its pane the handle sits on. "end" is the right edge (sidebar, list column), so
 * moving the handle right grows the pane; "start" is the left edge (inspector), so moving it left
 * grows the pane.
 */
export type SplitEdge = "start" | "end";

/** A max below the min (a narrow window) collapses the range to the min, never inverts it. */
export function clampSize(size: number, { min, max }: SplitBounds): number {
  const hi = Math.max(min, max);
  if (!Number.isFinite(size)) return min;
  return Math.round(Math.min(hi, Math.max(min, size)));
}

/**
 * The pane size after a pointer moved from `startX` to `x`, before clamping, so the caller can
 * tell a drag past the minimum (collapse) from one that stops at it.
 */
export function dragSize(startSize: number, startX: number, x: number, edge: SplitEdge): number {
  const dx = x - startX;
  return startSize + (edge === "end" ? dx : -dx);
}

export type SplitKeyResult = { kind: "size"; size: number } | { kind: "toggle" } | null;

/**
 * Keyboard on a vertical splitter, after the WAI-ARIA window splitter pattern: Left and Right move
 * the handle, Home and End give the pane its smallest and largest size, Enter collapses or
 * restores when the pane can collapse. Anything else is not ours (null).
 */
export function splitKey(key: string, size: number, bounds: SplitBounds, edge: SplitEdge, opts: { step?: number; canToggle?: boolean } = {}): SplitKeyResult {
  const step = opts.step ?? SPLIT_STEP;
  const grow = edge === "end" ? "ArrowRight" : "ArrowLeft";
  const shrink = edge === "end" ? "ArrowLeft" : "ArrowRight";
  if (key === grow) return { kind: "size", size: clampSize(size + step, bounds) };
  if (key === shrink) return { kind: "size", size: clampSize(size - step, bounds) };
  if (key === "Home") return { kind: "size", size: clampSize(bounds.min, bounds) };
  if (key === "End") return { kind: "size", size: clampSize(bounds.max, bounds) };
  if (key === "Enter" && opts.canToggle) return { kind: "toggle" };
  return null;
}

export interface CollapsibleBounds extends SplitBounds {
  /** A drag that ends this far under `min` collapses the pane to its rail. */
  collapseBelow: number;
}

/**
 * A drag on a pane that can collapse (the sidebar): past `collapseBelow` it collapses and keeps the
 * width it had, so expanding again returns to it; otherwise it expands and clamps.
 */
export function resolveCollapsibleDrag(raw: number, width: number, bounds: CollapsibleBounds): { width: number; collapsed: boolean } {
  if (raw < bounds.collapseBelow) return { width: clampSize(width, bounds), collapsed: true };
  return { width: clampSize(raw, bounds), collapsed: false };
}
