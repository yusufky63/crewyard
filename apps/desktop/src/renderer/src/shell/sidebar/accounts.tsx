import { useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import { BrandIcon, Dot, TickMeter } from "@crewyard/ui";
import { DEFAULT_THRESHOLDS, type AccountRow, type Provenance, type Thresholds } from "@crewyard/core";
import { useProvidersQuery as useDaemon } from "../../screens/providers/data.ts";
import { useNav } from "../../nav.ts";
import { usePrefs } from "../../prefs.ts";
import type { SidebarBlockDef } from "../../registry.ts";
import { allMeters, lineValue, meterLines, needsAction, newestReading, showAccounts, splitAccounts, type LineValue, type ShortLabel } from "./accounts-model.ts";
import { providerColor, RUNNER_COLOR, useMoney, useProvidersLive, useWhen } from "../../screens/providers/shared.tsx";
import "./accounts.css";

// Pinned under the sidebar nav (DESIGN.md §4). The owner, 2026-10-31: the panel is narrow and holds
// too much, so accounts in use come first with one compact row per window, the rest fold into one
// line, and everything else (sources, reset times, ages, caps, sign-in) is in the hover and focus
// detail. accounts-model.ts decides what is drawn.

// Screenshot runs open the first account's detail (`accounts=detail`) or the folded line (`accounts=open`).
const SHOT = typeof location !== "undefined" ? new URLSearchParams(location.search).get("accounts") : null;

const levelTone = (pct: number, t: Thresholds) => (pct >= t.critical ? " bad" : pct >= t.warn ? " warn" : "");

/** A one-letter, token-coloured source mark; the full word is for screen readers. */
function Mark({ provenance }: { provenance: Provenance }) {
  const { t } = useTranslation("limits");
  return (
    <>
      <span className={`pm pm-${provenance}`} aria-hidden="true">
        {t(`accounts.mark.${provenance}`)}
      </span>
      <span className="sr">{t(`provenance.${provenance}`)}</span>
    </>
  );
}

function useLabels() {
  const { t } = useTranslation("limits");
  const short = (l: ShortLabel) =>
    l.kind === "cap" ? t("accounts.short.cap") : l.kind === "quota" ? t("accounts.short.quota") : l.kind === "bucket" ? t(`accounts.bucketShort.${l.bucket}`, { defaultValue: l.bucketLabel ?? l.bucket }) : t(`accounts.short.${l.window}`);
  const name = (row: AccountRow) => {
    // A coding-plan key is a plan of its provider, not of the runner that happens to use it.
    const codingPlan = row.plan !== undefined && row.plan !== null && row.kind === "plan";
    const runnerPlan = row.kind === "plan" && row.runner !== null && !codingPlan;
    return {
      label: runnerPlan ? `${t(`providers:runner.${row.runner}`)} · ${row.label}` : row.label,
      icon: runnerPlan && row.runner ? row.runner : row.providerId,
      color: row.runner && !codingPlan ? RUNNER_COLOR[row.runner] : providerColor(row.providerId),
    };
  };
  return { short, name };
}

function Value({ value, thresholds }: { value: LineValue; thresholds: Thresholds }) {
  const { t } = useTranslation("limits");
  const money = useMoney();
  switch (value.kind) {
    case "pct":
      return (
        <span className={`v${value.pct > 0 ? levelTone(value.pct, thresholds) : " muted"}`}>
          {t("accounts.pct", { pct: Math.round(value.pct) })}
          <Mark provenance={value.provenance} />
        </span>
      );
    case "usd":
      return (
        <span className={`v${value.usd > 0 ? "" : " muted"}`}>
          {money(value.usd)}
          <Mark provenance={value.provenance} />
        </span>
      );
    case "signIn":
      return <span className="v warn">{t("accounts.signIn")}</span>;
    case "update":
      return <span className="v bad">{t("accounts.update")}</span>;
    case "local":
      return <span className="v muted">{t("accounts.local")}</span>;
    default:
      return (
        <span className="v muted">
          <span aria-hidden="true">—</span>
          <span className="sr">{t("provenance.unknown")}</span>
        </span>
      );
  }
}

/** Every window and bucket with %, source, reset time and the reading's age; caps and today's spend; sign-in. */
function Detail({ row, label }: { row: AccountRow; label: string }) {
  const { t } = useTranslation("limits");
  const money = useMoney();
  const when = useWhen();
  const meters = allMeters(row);
  const seen = newestReading(row);
  const action = needsAction(row);
  const runs = row.activeRuns ?? 0;
  const signIn = row.signIn;
  const signInText = signIn
    ? [
        t(`accounts.detail.signIn.${signIn.state}`),
        signIn.state === "signed_in" && signIn.plan ? t(`providers:signIn.plan.${signIn.plan}`, { defaultValue: signIn.plan }) : null,
        signIn.probedAt ? t("accounts.tipChecked", { time: when.ago(signIn.probedAt) }) : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;
  return (
    <>
      <span className="acct-tip-name">{label}</span>
      {signInText && <span className={`acct-tip-meta${action === "update" ? " bad" : action === "signIn" ? " warn" : ""}`}>{signInText}</span>}
      {runs > 0 && (
        <span className="acct-tip-meta run">
          <Dot color="var(--accent)" />
          {t("accounts.running", { count: runs })}
        </span>
      )}
      {row.kind === "local" ? (
        <span className="acct-tip-meta">{t("accounts.detail.local")}</span>
      ) : row.value.kind === "usd" ? (
        <span className="acct-tip-grid">
          <span>{t("accounts.detail.today")}</span>
          <span className="n">{money(row.value.usd)}</span>
          <span className={`pv pm-${row.provenance}`}>{t(`provenance.${row.provenance}`)}</span>
          <span className="rs">{row.value.capUsd === null ? t("accounts.detail.noCap") : t("accounts.detail.cap", { cap: money(row.value.capUsd) })}</span>
        </span>
      ) : action ? null : meters.length === 0 ? (
        <span className="acct-tip-meta">{t("accounts.detail.noData")}</span>
      ) : (
        <span className="acct-tip-grid">
          {meters.map((m) => (
            <span className="acct-tip-row" key={`${m.bucket ?? ""}|${m.window}`}>
              <span>
                {m.bucket ? `${t(`plans.bucket.${m.bucket}`, { defaultValue: m.bucketLabel ?? m.bucket })} · ` : ""}
                {t(`plans.window.${m.window}`)}
              </span>
              <span className="n">{m.pct === null || m.provenance === "unknown" ? "—" : t("accounts.pct", { pct: Math.round(m.pct) })}</span>
              <span className={`pv pm-${m.provenance}`}>{t(`provenance.${m.provenance}`)}</span>
              {m.resetsAt && m.pct !== null && <span className="rs">{t("accounts.detail.resets", { time: when.at(m.resetsAt) })}</span>}
            </span>
          ))}
        </span>
      )}
      {seen && !action && <span className="acct-tip-meta">{t("accounts.detail.seen", { time: when.ago(seen) })}</span>}
    </>
  );
}

/** One detail at a time: hovering a row closes the one a focused row opened. */
interface Opener {
  open: boolean;
  setOpen(open: boolean): void;
}

function Row({ row, thresholds, used, open, setOpen }: { row: AccountRow; thresholds: Thresholds; used: boolean } & Opener) {
  const { t } = useTranslation("limits");
  const go = useNav((s) => s.go);
  const { short, name } = useLabels();
  const tipId = useId();
  const [pos, setPos] = useState<CSSProperties>({});
  const anchor = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const { label, icon, color } = name(row);
  const lines = used ? meterLines(row) : [];
  const value = lineValue(row);
  const runs = row.activeRuns ?? 0;

  // Beside the sidebar's right edge, level with the row, kept inside the window.
  useLayoutEffect(() => {
    if (!open || !anchor.current || !tip.current) return;
    const r = anchor.current.getBoundingClientRect();
    const edge = anchor.current.closest(".accts")?.getBoundingClientRect().right ?? r.right;
    const h = tip.current.offsetHeight;
    setPos({ left: edge + 8, top: Math.max(8, Math.min(r.top, window.innerHeight - h - 8)) });
  }, [open]);

  return (
    <div className="acct" ref={anchor} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        className="acct-b"
        aria-describedby={tipId}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && open) {
            e.stopPropagation();
            setOpen(false);
          }
        }}
        onClick={() => go(row.kind === "local" || needsAction(row) === "update" ? "providers" : "limits")}
      >
        <span className="acct-top">
          <BrandIcon id={icon} size={14} />
          <span className="n">{label}</span>
          {runs > 0 && (
            <span className="run">
              <Dot color="var(--accent)" />
              <span className="sr">{t("accounts.running", { count: runs })}</span>
            </span>
          )}
          {(lines.length === 0 || value.kind === "usd") && <Value value={value} thresholds={thresholds} />}
        </span>
        {lines.map((l) => (
          <span className="acct-m" key={l.key}>
            <span className="k">{short(l.label)}</span>
            <TickMeter value={l.pct} ticks={24} size="xs" color={color} label={`${label} · ${l.pct === null ? t("accounts.tipMeterUnknown", { window: short(l.label) }) : t("accounts.tipMeter", { window: short(l.label), pct: Math.round(l.pct) })}`} />
            <span className={`mv${l.pct === null ? " muted" : levelTone(l.pct, thresholds)}`}>
              {l.pct === null ? <span aria-hidden="true">—</span> : t("accounts.pct", { pct: Math.round(l.pct) })}
              <Mark provenance={l.provenance} />
            </span>
          </span>
        ))}
      </button>
      <div className="acct-tip" role="tooltip" id={tipId} ref={tip} hidden={!open} style={pos}>
        <Detail row={row} label={label} />
      </div>
    </div>
  );
}

function AccountsBlock() {
  const { t } = useTranslation("limits");
  const go = useNav((s) => s.go);
  const openPref = usePrefs((s) => s.accountsUnusedOpen);
  const setOpen = usePrefs((s) => s.setAccountsUnusedOpen);
  const foldId = useId();
  const [openKey, setOpenKey] = useState<string | null>(null);
  useProvidersLive();
  const accounts = useDaemon("providers.accounts", undefined, { refetchInterval: 60_000 });
  const limits = useDaemon("providers.limits", undefined);
  // Nothing added yet: no block at all; the Start screen's checklist already points to Providers.
  if (!showAccounts(accounts.data)) return null;
  const rows = accounts.data;
  const thresholds = limits.data?.thresholds ?? DEFAULT_THRESHOLDS;
  const { inUse, unused } = splitAccounts(rows, new Date());
  const unfolded = openPref || SHOT === "open";
  // Screenshot runs (`accounts=detail`) open the first account's detail.
  const shown = openKey ?? (SHOT === "detail" ? (inUse[0] ?? unused[0])?.key : null);
  const opener = (key: string): Opener => ({ open: shown === key, setOpen: (o) => setOpenKey((k) => (o ? key : k === key ? null : k)) });
  return (
    <section className="accts" aria-label={t("accounts.label")}>
      <div className="accts-head">
        <span className="lbl">{t("accounts.title", { count: rows.length })}</span>
        <button onClick={() => go("limits")}>{t("accounts.all")}</button>
      </div>
      <div className="accts-list" tabIndex={0} aria-label={t("accounts.list")}>
        {inUse.map((r) => (
          <Row key={r.key} row={r} thresholds={thresholds} used {...opener(r.key)} />
        ))}
        {unused.length > 0 && (
          <button className="accts-more" aria-expanded={unfolded} aria-controls={foldId} onClick={() => setOpen(!unfolded)}>
            <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" className={unfolded ? "up" : undefined} />
            {t(inUse.length > 0 ? "accounts.more" : "accounts.moreAll", { count: unused.length })}
          </button>
        )}
        <div id={foldId} className="accts-fold" hidden={!unfolded}>
          {unused.map((r) => (
            <Row key={r.key} row={r} thresholds={thresholds} used={false} {...opener(r.key)} />
          ))}
        </div>
      </div>
    </section>
  );
}

export const block: SidebarBlockDef = { id: "accounts", order: 10, component: AccountsBlock };
