import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { Info } from "lucide-react";
import { useTranslation } from "react-i18next";
import { BrandIcon, hasBrandIcon } from "@crewyard/ui";
import { PROFILE_RUNNERS, runnerSupport, usableWith, type CatalogProvider, type ProfileRunner, type RunnerSupport } from "@crewyard/core";
import { FIXTURE } from "./fixture.ts";

/** Screenshot runs open one tooltip: `tip=legend`, or `tip=<provider id>:<runner>`. */
const SHOT_TIP = FIXTURE ? new URLSearchParams(location.search).get("tip") : null;

/** Frame per state: filled, outline, dashed. The shape carries the state, the color only repeats it. */
const frame = (s: RunnerSupport) => (s === "config" ? "cfg" : s === "conversion" ? "off" : "on");

/**
 * A tooltip that opens on hover and on focus, closes on Escape, and sits under its anchor in a
 * fixed layer so the table's scroll box never clips it.
 */
function useTip(shot = false) {
  const id = useId();
  const [open, setOpen] = useState(shot);
  const [pos, setPos] = useState<CSSProperties>({});
  const anchor = useRef<HTMLElement | null>(null);
  const tip = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !anchor.current || !tip.current) return;
    const r = anchor.current.getBoundingClientRect();
    const { offsetWidth: w, offsetHeight: h } = tip.current;
    const below = r.bottom + 6;
    setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - w - 8)), top: below + h > window.innerHeight - 8 ? r.top - h - 6 : below });
  }, [open]);

  // A fixed tooltip would drift away from its anchor when the screen scrolls.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("scroll", close, true);
    return () => window.removeEventListener("scroll", close, true);
  }, [open]);

  return {
    anchor: {
      ref: (el: HTMLElement | null) => {
        anchor.current = el;
      },
      "aria-describedby": id,
      onMouseEnter: () => setOpen(true),
      onMouseLeave: () => setOpen(false),
      onFocus: () => setOpen(true),
      onBlur: () => setOpen(false),
      onKeyDown: (e: KeyboardEvent) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
        }
      },
    },
    tip: { id, role: "tooltip", ref: tip, hidden: !open, style: pos, className: "pv-tip" },
  };
}

function Chip({ runner, support, provider, tabIndex, chipRef }: { runner: ProfileRunner; support: RunnerSupport; provider: CatalogProvider; tabIndex: number; chipRef(el: HTMLElement | null): void }) {
  const { t } = useTranslation("providers");
  const { anchor, tip } = useTip(SHOT_TIP === `${provider.id}:${runner}`);
  const name = t(`runner.${runner}`);
  const mark = hasBrandIcon(runner);
  return (
    <>
      <span
        {...anchor}
        ref={(el) => {
          anchor.ref(el);
          chipRef(el);
        }}
        className={`rchip ${frame(support)}${mark ? " ico" : ""}`}
        role="img"
        tabIndex={tabIndex}
        aria-label={t("chip.label", { runner: name, state: t(`chip.state.${support}`) })}
      >
        {mark ? <BrandIcon id={runner} size={14} /> : name}
      </span>
      <div {...tip}>
        <span className="pv-tip-name">
          <BrandIcon id={runner} size={14} />
          {name}
          <span className={`rchip ${frame(support)}`}>{t(`chip.state.${support}`)}</span>
        </span>
        <span>{t([`chip.via.${support}_${runner}`, `chip.via.${support}`], { provider: provider.name })}</span>
        <span className="pv-tip-meta">{t(usableWith(support) ? "chip.usable" : "chip.unusable", { provider: provider.name })}</span>
      </div>
    </>
  );
}

/** One tab stop per row; arrow keys, Home and End move between the runners in it. */
export function RunnerChips({ provider }: { provider: CatalogProvider }) {
  const { t } = useTranslation("providers");
  const chips = PROFILE_RUNNERS.flatMap((runner) => {
    const support = runnerSupport(provider, runner);
    return support === "none" ? [] : [{ runner, support }];
  });
  const [current, setCurrent] = useState(0);
  const els = useRef<(HTMLElement | null)[]>([]);

  const move = (e: KeyboardEvent) => {
    const last = chips.length - 1;
    const next = e.key === "ArrowRight" ? Math.min(last, current + 1) : e.key === "ArrowLeft" ? Math.max(0, current - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : null;
    if (next === null) return;
    e.preventDefault();
    setCurrent(next);
    els.current[next]?.focus();
  };

  if (chips.length === 0) return null;
  return (
    <div className="rchips" role="group" aria-label={t("chip.group", { provider: provider.name })} onKeyDown={move}>
      {chips.map((c, i) => (
        <Chip
          key={c.runner}
          {...c}
          provider={provider}
          tabIndex={i === current ? 0 : -1}
          chipRef={(el) => {
            els.current[i] = el;
          }}
        />
      ))}
    </div>
  );
}

function Swatch({ cls, shape, children }: { cls: string; shape: string; children: ReactNode }) {
  return (
    <span className="pv-tip-row">
      <span className={`rchip ico ${cls}`} aria-hidden="true" />
      <span>
        <b>{shape}</b> {children}
      </span>
    </span>
  );
}

/** The column header, with the legend for the frames one focus or hover away. */
export function RunnersHeader() {
  const { t } = useTranslation("providers");
  const { anchor, tip } = useTip(SHOT_TIP === "legend");
  return (
    <div className="pv-th-tip">
      {t("cols.runners")}
      <button {...anchor} type="button" className="pv-th-info" aria-label={t("chip.legendLabel")}>
        <Info size={12} aria-hidden="true" />
      </button>
      <div {...tip}>
        <span>{t("chip.legendTitle")}</span>
        <Swatch cls="on" shape={t("chip.shape.filled")}>
          {t("legend.direct")}
        </Swatch>
        <Swatch cls="cfg" shape={t("chip.shape.outline")}>
          {t("legend.config")}
        </Swatch>
        <Swatch cls="off" shape={t("chip.shape.dashed")}>
          {t("legend.conversion")}
        </Swatch>
      </div>
    </div>
  );
}
