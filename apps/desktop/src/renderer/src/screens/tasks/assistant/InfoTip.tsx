import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Info } from "lucide-react";

// An info button whose tooltip holds text that would otherwise take its own lines (owner,
// 2026-10-31: the assistant's two hint lines took too much room). It opens on hover and on focus,
// Escape closes it without closing the panel around it, and the button names it for screen readers.

export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<CSSProperties>({});
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const tip = useRef<HTMLDivElement>(null);

  // Above the button when there is room (the box sits at the bottom of the panel), kept inside the window.
  useLayoutEffect(() => {
    if (!open || !button.current || !tip.current) return;
    const r = button.current.getBoundingClientRect();
    const w = tip.current.offsetWidth;
    const h = tip.current.offsetHeight;
    const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
    const top = r.top - h - 8 >= 8 ? r.top - h - 8 : Math.min(r.bottom + 8, window.innerHeight - h - 8);
    setPos({ left, top });
  }, [open]);

  return (
    <span className="as-info" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        ref={button}
        className="as-icon-btn"
        aria-label={label}
        aria-describedby={id}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((x) => !x)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && open) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          }
        }}
      >
        <Info aria-hidden="true" />
      </button>
      <div className="as-tip" role="tooltip" id={id} ref={tip} hidden={!open} style={pos}>
        {children}
      </div>
    </span>
  );
}
