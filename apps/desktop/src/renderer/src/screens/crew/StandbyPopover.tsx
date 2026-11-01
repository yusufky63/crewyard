import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { BrandIcon } from "@crewyard/ui";
import { matches } from "../../keys.ts";
import { runnerName } from "./labels.tsx";
import type { StandbyEntry } from "./model.ts";

// The standby chain of one step, opened from the badge on its tile (DESIGN.md §5 SpecTile). It
// replaces the dashed standby tiles the graph used to draw. Reordering sends the same set_standby
// edit as the step editor, so the rules (and the refusal once the step ran) are the daemon's.

const GAP = 6;
const EDGE = 12;

export interface StandbyPopoverProps {
  /** The badge's box in viewport pixels; the popover opens under it. */
  anchor: { left: number; bottom: number; top: number };
  /** "02 Implement". */
  target: string;
  entries: StandbyEntry[];
  /** What the task does on a limit, the fallback mode in a few words ("asks first"). */
  mode: string;
  /** Why the order cannot change here; null when it can. */
  locked: string | null;
  busy: boolean;
  onReorder(profileIds: string[]): void;
  onClose(): void;
}

export function StandbyPopover({ anchor, target, entries, mode, locked, busy, onReorder, onClose }: StandbyPopoverProps) {
  const { t } = useTranslation("crew");
  const ref = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const ids = entries.map((e) => e.profileId);

  // Under the badge, kept inside the window; above it when there is no room below.
  useLayoutEffect(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(EDGE, Math.min(anchor.left, window.innerWidth - r.width - EDGE));
    const below = anchor.bottom + GAP;
    const top = below + r.height > window.innerHeight - EDGE ? Math.max(EDGE, anchor.top - GAP - r.height) : below;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.visibility = "visible";
    (el.querySelector<HTMLElement>(".crew-pop-item") ?? el.querySelector<HTMLElement>(".crew-x"))?.focus();
  }, [anchor]);

  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("resize", onClose);
    document.addEventListener("pointerdown", down, true);
    return () => {
      window.removeEventListener("resize", onClose);
      document.removeEventListener("pointerdown", down, true);
    };
  }, [onClose]);

  const close = () => {
    onClose();
    opener.current?.focus();
  };
  const move = (from: number, to: number) => {
    if (locked || busy || to < 0 || to >= ids.length) return;
    const next = [...ids];
    const [id] = next.splice(from, 1);
    next.splice(to, 0, id!);
    onReorder(next);
  };
  const itemKey = (e: KeyboardEvent, i: number) => {
    if (matches(e, "graph.move") && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      move(i, e.key === "ArrowUp" ? i - 1 : i + 1);
    }
  };

  return (
    <div
      ref={ref}
      className="crew-pop"
      role="dialog"
      aria-label={t("standby.title", { target })}
      style={{ visibility: "hidden" }}
      onKeyDown={(e) => {
        if (matches(e, "close")) {
          e.preventDefault();
          e.stopPropagation();
          close();
        }
      }}
    >
      <div className="crew-pop-head">
        <span className="lbl">{t("standby.title", { target })}</span>
        <button type="button" className="crew-x" onClick={close} aria-label={t("standby.close")}>
          <X size={14} strokeWidth={1.75} />
        </button>
      </div>
      <p className="crew-pop-note">{t("standby.order", { mode })}</p>
      <ol className="crew-pop-list" aria-busy={busy}>
        {entries.map((e, i) => {
          const name = `${runnerName(t, e.runner)} · ${e.alias}`;
          return (
            <li key={e.profileId} className="crew-pop-item" tabIndex={0} aria-label={`${i + 1}. ${name} · ${e.model ?? t("node.defaultModel")}`} onKeyDown={(k) => itemKey(k, i)}>
              <span className="mono crew-chain-n">{i + 1}</span>
              <BrandIcon id={e.runner} size={14} />
              <span className="crew-cand-name">
                <span>{name}</span>
                <span className="mono muted">{e.model ?? t("node.defaultModel")}</span>
              </span>
              {!locked && (
                <span className="crew-chain-tools">
                  <button type="button" className="crew-icon" disabled={i === 0} aria-label={t("panel.moveUp", { alias: e.alias })} onClick={() => move(i, i - 1)}>
                    <ArrowUp size={14} strokeWidth={1.75} />
                  </button>
                  <button type="button" className="crew-icon" disabled={i === entries.length - 1} aria-label={t("panel.moveDown", { alias: e.alias })} onClick={() => move(i, i + 1)}>
                    <ArrowDown size={14} strokeWidth={1.75} />
                  </button>
                </span>
              )}
            </li>
          );
        })}
      </ol>
      <p className="crew-pop-note">{locked ?? t("standby.reorderHint")}</p>
    </div>
  );
}
