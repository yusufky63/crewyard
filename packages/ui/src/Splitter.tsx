import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { clampSize, dragSize, growKeys, resolveCollapsibleDrag, splitKey, type SplitEdge, type SplitOrientation } from "./split.ts";

export interface SplitterCollapse {
  collapsed: boolean;
  /** Width of the collapsed pane (the 56 px rail), reported as the lowest position. */
  size: number;
  /** A drag that ends under this width collapses the pane. */
  below: number;
  setCollapsed(collapsed: boolean): void;
}

/**
 * The handle on a resizable pane's edge (DESIGN.md §5 `Splitter`), after the WAI-ARIA window
 * splitter pattern: a focusable `role="separator"` that reports its position in pixels. Drag or
 * use Left/Right (Up/Down when horizontal, 16 px), Home/End (min/max) and, when the pane can
 * collapse, Enter. Double-click returns to the default size. The caller owns the size and where it
 * is stored.
 */
export function Splitter({
  value,
  min,
  max,
  defaultValue,
  edge,
  label,
  title,
  controls,
  inline = false,
  orientation = "vertical",
  collapse,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  edge: SplitEdge;
  /** Accessible name, e.g. "Resize sidebar". */
  label: string;
  /** Tooltip; say how to reset. */
  title?: string;
  /** id of the pane this handle sizes. */
  controls?: string;
  /** Sits in the layout flow (between two grid columns) instead of over the pane's edge. */
  inline?: boolean;
  /** "horizontal" sits between rows and sizes a height (the Activity drawer). */
  orientation?: SplitOrientation;
  collapse?: SplitterCollapse;
  onChange(size: number): void;
}) {
  const drag = useRef<{ x: number; size: number; width: number } | null>(null);
  const horizontal = orientation === "horizontal";
  const pos = (e: PointerEvent<HTMLDivElement>) => (horizontal ? e.clientY : e.clientX);
  const [dragging, setDragging] = useState(false);
  const bounds = { min, max };
  const collapsed = collapse?.collapsed ?? false;
  const size = clampSize(value, bounds);

  const end = () => {
    drag.current = null;
    setDragging(false);
    document.documentElement.classList.remove("is-resizing", "is-resizing-rows");
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus({ preventScroll: true });
    drag.current = { x: pos(e), size: collapsed && collapse ? collapse.size : size, width: size };
    setDragging(true);
    // The cursor and text selection stay right while the pointer is over other elements.
    document.documentElement.classList.add("is-resizing");
    if (horizontal) document.documentElement.classList.add("is-resizing-rows");
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const raw = dragSize(d.size, d.x, pos(e), edge);
    if (!collapse) {
      onChange(clampSize(raw, bounds));
      return;
    }
    const next = resolveCollapsibleDrag(raw, d.width, { ...bounds, collapseBelow: collapse.below });
    if (next.collapsed !== collapse.collapsed) collapse.setCollapsed(next.collapsed);
    if (!next.collapsed) onChange(next.width);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const r = splitKey(e.key, size, bounds, edge, { canToggle: Boolean(collapse), orientation });
    if (!r) return;
    e.preventDefault();
    if (r.kind === "toggle") {
      collapse?.setCollapsed(!collapsed);
      return;
    }
    if (collapsed && collapse) {
      // From the rail only a step toward a bigger pane does anything: it restores the last width.
      const grows = e.key === growKeys(edge, orientation).grow || e.key === "End";
      if (!grows) return;
      collapse.setCollapsed(false);
      if (e.key === "End") onChange(r.size);
      return;
    }
    onChange(r.size);
  };

  const now = collapsed && collapse ? collapse.size : size;
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-controls={controls}
      aria-valuenow={now}
      aria-valuemin={collapse ? collapse.size : min}
      aria-valuemax={Math.max(min, max)}
      tabIndex={0}
      title={title}
      className={inline ? "splitter splitter-inline" : "splitter"}
      data-edge={edge}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onKeyDown={onKeyDown}
      onDoubleClick={() => {
        collapse?.setCollapsed(false);
        onChange(clampSize(defaultValue, bounds));
      }}
    />
  );
}
