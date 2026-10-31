import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Info } from "lucide-react";

// An info button whose tooltip holds text that would otherwise take its own lines (owner,
// 2026-10-31: the assistant's two hint lines took too much room). It opens on hover, on focus and
// on click; the pointer can move onto it to read it (WCAG 1.4.13), and Escape closes it wherever
// focus is, without reaching the panel around it, whose Escape stops the session.

/** Time to cross the gap between the button and the tip before a hover-open tip closes. */
const LEAVE_MS = 200;

export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<CSSProperties>({});
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const leave = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hovered = useRef(false);

  const cancelLeave = () => {
    if (leave.current) clearTimeout(leave.current);
    leave.current = null;
  };
  const show = () => {
    cancelLeave();
    setOpen(true);
  };
  const hideSoon = () => {
    cancelLeave();
    // Focus keeps it open: a keyboard user who opened it reads it until they move on.
    leave.current = setTimeout(() => {
      if (document.activeElement !== button.current) setOpen(false);
    }, LEAVE_MS);
  };
  useEffect(
    () => () => {
      if (leave.current) clearTimeout(leave.current);
    },
    [],
  );

  // Above the button when there is room (the box sits at the bottom of the panel), kept inside the window.
  useLayoutEffect(() => {
    if (!open || !button.current || !tip.current) return;
    const r = button.current.getBoundingClientRect();
    const w = tip.current.offsetWidth;
    const h = tip.current.offsetHeight;
    const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
    const top = r.top - h - 6 >= 8 ? r.top - h - 6 : Math.min(r.bottom + 6, window.innerHeight - h - 8);
    setPos({ left, top });
  }, [open]);

  // Capture on the window runs before the panel's and the inspector's own Escape handlers.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      if (leave.current) clearTimeout(leave.current);
      setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  return (
    <span
      className="as-info"
      onMouseEnter={() => {
        hovered.current = true;
        show();
      }}
      onMouseLeave={() => {
        hovered.current = false;
        hideSoon();
      }}
    >
      <button
        type="button"
        ref={button}
        className="as-icon-btn"
        aria-label={label}
        aria-describedby={id}
        onFocus={show}
        // Clicking into the tip to select its text moves focus away; the pointer still holds it open.
        onBlur={() => {
          if (!hovered.current) setOpen(false);
        }}
        // A click opens it, never toggles: hover and the focus from the mouse press opened it already.
        onClick={show}
      >
        <Info aria-hidden="true" />
      </button>
      <div className="as-tip" role="tooltip" id={id} ref={tip} hidden={!open} style={pos}>
        {children}
      </div>
    </span>
  );
}
