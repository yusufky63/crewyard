import { useTranslation } from "react-i18next";
import { BrandIcon, TickMeter } from "@crewyard/ui";
import { DEFAULT_THRESHOLDS, type AccountMeter, type AccountRow, type Thresholds } from "@crewyard/core";
import { useProvidersQuery as useDaemon } from "../../screens/providers/data.ts";
import { useNav } from "../../nav.ts";
import type { SidebarBlockDef } from "../../registry.ts";
import { meterLines, showAccounts } from "./accounts-model.ts";
import { providerColor, RUNNER_COLOR, useMoney, useProvidersLive, useWhen } from "../../screens/providers/shared.tsx";
import "./accounts.css";

// Pinned under the sidebar nav (DESIGN.md §4): per account a name line, then one meter row per
// window or bucket it has reported (or a cap), most urgent first, scrolling on its own so many
// accounts never push the nav away. accounts-model.ts decides what is drawn.

function Row({ row, thresholds }: { row: AccountRow; thresholds: Thresholds }) {
  const { t } = useTranslation("limits");
  const go = useNav((s) => s.go);
  const money = useMoney();
  const when = useWhen();
  // A coding-plan key is a plan of its provider, not of the runner that happens to use it.
  const codingPlan = row.plan !== undefined && row.plan !== null && row.kind === "plan";
  const color = row.runner && !codingPlan ? RUNNER_COLOR[row.runner] : providerColor(row.providerId);
  const prov = t(`provenance.${row.provenance}`);
  const pct = row.pct;
  const label = row.kind === "plan" && row.runner && !codingPlan ? `${t(`providers:runner.${row.runner}`)} · ${row.label}` : row.label;
  const meters = row.meters ?? [];
  const meterText = (m: AccountMeter) => {
    const window = `${m.bucket ? `${t(`plans.bucket.${m.bucket}`, { defaultValue: m.bucketLabel ?? m.bucket })} ` : ""}${t(`plans.window.${m.window}`)}`;
    return m.pct === null ? t("accounts.tipMeterUnknown", { window }) : t("accounts.tipMeter", { window, pct: Math.round(m.pct) });
  };
  let value: string;
  let title: string;
  if (row.kind === "local") {
    value = t("accounts.local");
    title = t("accounts.tipLocal", { name: label });
  } else if (row.value.kind === "usd") {
    value = money(row.value.usd);
    title = row.value.capUsd === null ? t("accounts.tipKeyNoCap", { name: label, spent: value, provenance: prov }) : t("accounts.tipKey", { name: label, spent: value, cap: money(row.value.capUsd), provenance: prov });
  } else if (row.signIn && (row.signIn.state === "signed_out" || row.signIn.state === "blocked")) {
    // Nothing to measure until the profile can sign in; say what is missing instead of a bare dash.
    value = t(`accounts.${row.signIn.state === "blocked" ? "update" : "signIn"}`);
    title = t(row.signIn.state === "blocked" ? "accounts.tipBlocked" : "accounts.tipSignedOut", { name: label });
  } else if (row.value.kind === "pct" && meters.length > 1) {
    // Every window of every bucket in the tooltip; the value is the fullest one.
    value = `${Math.round(row.value.pct)}%`;
    const parts = meters.map(meterText);
    const newest = meters.reduce((a, m) => (m.observedAt > a ? m.observedAt : a), meters[0]!.observedAt);
    title = t("accounts.tipMeters", { name: label, meters: parts.join(" · "), provenance: prov, time: when.ago(newest) });
  } else if (row.value.kind === "pct") {
    value = `${Math.round(row.value.pct)}%`;
    title = t("accounts.tipPlan", { name: label, window: t(`plans.window.${row.window ?? "5h"}`), pct: Math.round(row.value.pct), provenance: prov });
  } else {
    value = "—";
    title = t("accounts.tipUnknown", { name: label, provenance: prov });
  }
  const tone = pct === null ? (row.signIn?.state === "blocked" ? " bad" : row.signIn?.state === "signed_out" ? " warn" : "") : levelTone(pct, thresholds);
  if (row.signIn?.state === "signed_in" && row.signIn.plan) title = `${title} · ${t(`providers:signIn.plan.${row.signIn.plan}`, { defaultValue: row.signIn.plan })}`;
  if (row.signIn?.probedAt) title = `${title} · ${t("accounts.tipChecked", { time: when.ago(row.signIn.probedAt) })}`;
  return (
    <button className="acct" title={title} onClick={() => go(row.kind === "local" || row.signIn?.state === "blocked" ? "providers" : "limits")}>
      <span className="acct-top">
        <BrandIcon id={row.kind === "plan" && row.runner && !codingPlan ? row.runner : row.providerId} size={14} />
        <span className="n">{label}</span>
        <span className={`v${(value === "—" || row.kind === "local") && !tone ? " muted" : ""}${tone}`}>{value}</span>
      </span>
      {meterLines(row).map((l) => {
        const lineProv = t(`provenance.${l.provenance}`);
        if (l.kind === "cap") {
          return (
            <span className="acct-m" key={l.key}>
              <span className="k">{t("accounts.short.cap")}</span>
              <TickMeter value={l.pct} ticks={24} size="xs" color={color} label={t("caps.meter", { name: label, pct: Math.round(l.pct) })} />
              <span className={`mv${levelTone(l.pct, thresholds)}`}>{Math.round(l.pct)}%</span>
              <span className="meta">{t("accounts.capMeta", { provenance: lineProv, cap: money(l.capUsd) })}</span>
            </span>
          );
        }
        const bucket = l.bucket ? t(`accounts.bucketShort.${l.bucket}`, { defaultValue: l.bucketLabel ?? l.bucket }) : null;
        const short = l.pct === null && l.window === null ? t("accounts.short.quota") : t(`accounts.short.${l.window ?? "quota"}`);
        // A bucket's row is named by the bucket; its window goes to the line below.
        const k = bucket ?? short;
        const meta = l.resetsAt && l.pct !== null ? t("accounts.meta", { provenance: lineProv, time: when.at(l.resetsAt) }) : lineProv;
        const full = `${bucket ? `${bucket} ` : ""}${l.window ? t(`plans.window.${l.window}`) : t("plans.quota")}`;
        return (
          <span className="acct-m" key={l.key}>
            <span className="k" title={full}>
              {k}
            </span>
            <TickMeter value={l.pct} ticks={24} size="xs" color={color} label={`${label} · ${l.pct === null ? t("accounts.tipMeterUnknown", { window: full }) : t("accounts.tipMeter", { window: full, pct: Math.round(l.pct) })}`} />
            <span className={`mv${l.pct === null ? " muted" : levelTone(l.pct, thresholds)}`}>{l.pct === null ? "—" : `${Math.round(l.pct)}%`}</span>
            <span className="meta">{bucket ? `${short} · ${meta}` : meta}</span>
          </span>
        );
      })}
    </button>
  );
}

const levelTone = (pct: number, t: Thresholds) => (pct >= t.critical ? " bad" : pct >= t.warn ? " warn" : "");

function AccountsBlock() {
  const { t } = useTranslation("limits");
  const go = useNav((s) => s.go);
  useProvidersLive();
  const accounts = useDaemon("providers.accounts", undefined, { refetchInterval: 60_000 });
  const limits = useDaemon("providers.limits", undefined);
  // Nothing added yet: no block at all; the Start screen's checklist already points to Providers.
  if (!showAccounts(accounts.data)) return null;
  const rows = accounts.data;
  return (
    <section className="accts" aria-label={t("accounts.label")}>
      <div className="accts-head">
        <span className="lbl">{t("accounts.title", { count: rows.length })}</span>
        <button onClick={() => go("limits")}>{t("accounts.all")}</button>
      </div>
      <div className="accts-list" tabIndex={0} aria-label={t("accounts.list")}>
        {rows.map((r) => (
          <Row key={r.key} row={r} thresholds={limits.data?.thresholds ?? DEFAULT_THRESHOLDS} />
        ))}
      </div>
    </section>
  );
}

export const block: SidebarBlockDef = { id: "accounts", order: 10, component: AccountsBlock };
