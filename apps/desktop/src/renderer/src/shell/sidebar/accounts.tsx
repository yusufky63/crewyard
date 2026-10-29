import { useTranslation } from "react-i18next";
import { TickMeter } from "@crewyard/ui";
import { DEFAULT_THRESHOLDS, type AccountRow, type Thresholds } from "@crewyard/core";
import { useDaemon } from "../../ipc.ts";
import { useNav } from "../../nav.ts";
import type { SidebarBlockDef } from "../../registry.ts";
import { providerColor, RUNNER_COLOR, useMoney, useProvidersLive } from "../../screens/providers/shared.tsx";
import "./accounts.css";

// Pinned under the sidebar nav (DESIGN.md §4): one 28 px line per account, most urgent first,
// scrolling on its own so many accounts never push the nav away.

function Row({ row, thresholds }: { row: AccountRow; thresholds: Thresholds }) {
  const { t } = useTranslation("limits");
  const go = useNav((s) => s.go);
  const money = useMoney();
  const color = row.runner ? RUNNER_COLOR[row.runner] : providerColor(row.providerId);
  const prov = t(`provenance.${row.provenance}`);
  const pct = row.pct;
  const label = row.kind === "plan" && row.runner ? `${t(`providers:runner.${row.runner}`)} · ${row.label}` : row.label;
  let value: string;
  let title: string;
  if (row.kind === "local") {
    value = t("accounts.local");
    title = t("accounts.tipLocal", { name: label });
  } else if (row.value.kind === "usd") {
    value = money(row.value.usd);
    title = row.value.capUsd === null ? t("accounts.tipKeyNoCap", { name: label, spent: value, provenance: prov }) : t("accounts.tipKey", { name: label, spent: value, cap: money(row.value.capUsd), provenance: prov });
  } else if (row.value.kind === "pct") {
    value = `${Math.round(row.value.pct)}%`;
    title = t("accounts.tipPlan", { name: label, window: t(`plans.window.${row.window ?? "5h"}`), pct: Math.round(row.value.pct), provenance: prov });
  } else {
    value = "—";
    title = t("accounts.tipUnknown", { name: label, provenance: prov });
  }
  const tone = pct === null ? "" : pct >= thresholds.critical ? " bad" : pct >= thresholds.warn ? " warn" : "";
  return (
    <button className="acct" title={title} onClick={() => go(row.kind === "local" ? "providers" : "limits")}>
      <i className="dot" style={{ ["--c" as string]: color }} aria-hidden="true" />
      <span className="n">{label}</span>
      {row.kind === "local" ? <span /> : <TickMeter value={pct} ticks={8} size="xs" color={color} label={title} />}
      <span className={`v${value === "—" || row.kind === "local" ? " muted" : ""}${tone}`}>{value}</span>
    </button>
  );
}

function AccountsBlock() {
  const { t } = useTranslation("limits");
  const go = useNav((s) => s.go);
  useProvidersLive();
  const accounts = useDaemon("providers.accounts", undefined, { refetchInterval: 60_000 });
  const limits = useDaemon("providers.limits", undefined);
  const rows = accounts.data ?? [];
  return (
    <section className="accts" aria-label={t("accounts.label")}>
      <div className="accts-head">
        <span className="lbl">{t("accounts.title", { count: rows.length })}</span>
        <button onClick={() => go("limits")}>{t("accounts.all")}</button>
      </div>
      {rows.length > 0 ? (
        <div className="accts-list" tabIndex={0} aria-label={t("accounts.list")}>
          {rows.map((r) => (
            <Row key={r.key} row={r} thresholds={limits.data?.thresholds ?? DEFAULT_THRESHOLDS} />
          ))}
        </div>
      ) : (
        <button className="accts-empty" onClick={() => go("providers")}>
          {accounts.isSuccess ? t("accounts.empty") : " "}
        </button>
      )}
    </section>
  );
}

export const block: SidebarBlockDef = { id: "accounts", order: 10, component: AccountsBlock };
