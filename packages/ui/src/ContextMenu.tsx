import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { clampMenu, initialIndex, isItem, moveIndex, SEPARATOR, type MenuEntry, type MenuItemSpec } from "./menu.ts";

export { SEPARATOR as MENU_SEPARATOR };

export interface ContextMenuItem extends MenuItemSpec {
  label: string;
  icon?: ReactNode;
  /** Shown right-aligned as a hint; the menu does not bind it. */
  shortcut?: string;
  tone?: "danger";
}

export type ContextMenuEntry = MenuEntry<ContextMenuItem>;

/**
 * A menu at a viewport point, opened by right-click, Shift+F10 or the context-menu key
 * (DESIGN.md §5). Arrow keys, Home and End move; Enter or Space picks; Esc and Tab close. Esc and
 * picking an item return focus to the element that had it when the menu opened. Disabled items
 * stay focusable and show why they are disabled.
 */
export function ContextMenu({
  x,
  y,
  label,
  heading,
  title,
  items,
  onSelect,
  onClose,
}: {
  x: number;
  y: number;
  /** Accessible name of the menu. */
  label: string;
  /** Small mono heading above the title, e.g. "Actions". */
  heading?: string;
  /** What the menu acts on, e.g. "02 Implement · Codex". */
  title?: string;
  items: ContextMenuEntry[];
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [active, setActive] = useState(() => initialIndex(items));
  const uid = useId();

  // Remember who had focus before the menu took it, so Esc can give it back.
  useLayoutEffect(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pos = clampMenu(x, y, r.width, r.height, window.innerWidth, window.innerHeight);
    el.style.left = `${pos.left}px`;
    el.style.top = `${pos.top}px`;
    el.style.visibility = "visible";
  }, [x, y]);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.focus();
  }, [active]);

  // A press anywhere outside closes the menu without moving focus back; the press decides focus.
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const blur = () => onClose();
    document.addEventListener("pointerdown", down, true);
    window.addEventListener("blur", blur);
    window.addEventListener("resize", blur);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      window.removeEventListener("blur", blur);
      window.removeEventListener("resize", blur);
    };
  }, [onClose]);

  const closeAndRefocus = () => {
    const back = opener.current;
    onClose();
    back?.focus();
  };

  const pick = (i: number) => {
    const item = items[i];
    if (!item || !isItem(item) || item.disabledReason) return;
    closeAndRefocus();
    onSelect(item.id);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const move = (dir: 1 | -1 | "first" | "last") => {
      e.preventDefault();
      const next = moveIndex(items, active, dir);
      if (next >= 0) setActive(next);
    };
    switch (e.key) {
      case "ArrowDown":
        return move(1);
      case "ArrowUp":
        return move(-1);
      case "Home":
        return move("first");
      case "End":
        return move("last");
      case "Enter":
      case " ":
        e.preventDefault();
        return pick(active);
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        return closeAndRefocus();
      case "Tab":
        e.preventDefault();
        return closeAndRefocus();
      case "ContextMenu":
      case "F10":
        // Opening the menu again from inside it would only stack a second one.
        e.preventDefault();
        return;
    }
  };

  return (
    <div
      ref={ref}
      className="cmenu"
      role="menu"
      aria-label={label}
      tabIndex={-1}
      style={{ left: x, top: y, visibility: "hidden" }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {(heading || title) && (
        <div className="cmenu-head">
          {heading && <span className="lbl">{heading}</span>}
          {title && <b>{title}</b>}
        </div>
      )}
      {items.map((entry, i) => {
        if (!isItem(entry)) return <div key={`sep-${i}`} className="cmenu-sep" role="separator" />;
        const why = entry.disabledReason ?? null;
        const whyId = why ? `${uid}-why-${i}` : undefined;
        return (
          <button
            key={entry.id}
            type="button"
            role="menuitem"
            data-index={i}
            tabIndex={i === active ? 0 : -1}
            className={entry.tone === "danger" ? "danger" : undefined}
            aria-disabled={why ? true : undefined}
            aria-describedby={whyId}
            onMouseEnter={() => setActive(i)}
            onClick={() => pick(i)}
          >
            <span className="cmenu-icon" aria-hidden="true">
              {entry.icon}
            </span>
            <span className="cmenu-text">
              <span>{entry.label}</span>
              {why && (
                <span className="cmenu-why" id={whyId}>
                  {why}
                </span>
              )}
            </span>
            {entry.shortcut && <span className="cmenu-key">{entry.shortcut}</span>}
          </button>
        );
      })}
    </div>
  );
}
