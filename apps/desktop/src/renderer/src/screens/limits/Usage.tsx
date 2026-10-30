import { useMemo, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useTranslation } from "react-i18next";
import { BrandIcon, Button, Dot, Label, Panel } from "@crewyard/ui";
import {
  dailySeries,
  groupUsage,
  NO_KEY,
  sharePct,
  totalTokens,
  usageCsv,
  usageJson,
  usageTotals,
  type CatalogProvider,
  type Provenance,
  type ProviderGroup,
  type UsageDimension,
  type UsageGroup,
} from "@crewyard/core";
import { call } from "../../ipc.ts";
import { providerColor, ProvBadge, RUNNER_COLOR, useMoney } from "../providers/shared.tsx";
import { FIXTURE, usageFixture } from "./fixture.ts";
import { compact, LEDGER_ROWS, metricOf, OTHER, slices, type UsageMetric } from "./usageView.ts";

// The usage view (A17, PLAN.md M5): tokens by day, model, provider and task, cache reads apart,
// dollars only for keys billed per token, every number with its provenance, and CSV / JSON export
// through a save dialog. Bars follow DESIGN.md: segmented bars and tick meters, each with a legend
// and a sentence for screen readers.

const DIMENSIONS: UsageDimension[] = ["day", "model", "provider", "task"];

function useUsage(days: number) {
  // Runs add spend as they go; a minute is fresh enough for a ledger and costs one small query.
  return useQuery({ queryKey: ["usage.report", { days }], queryFn: () => (FIXTURE ? Promise.resolve(usageFixture({ days })) : call("usage.report", { days })), refetchInterval: 60_000 });
}

/** A share of the largest row as filled ticks, without the quota thresholds TickMeter draws. */
function ShareTicks({ pct, color, label }: { pct: number; color: string; label: string }) {
  const n = 24;
  const on = Math.round((Math.min(100, Math.max(0, pct)) / 100) * n);
  return (
    <div className="meter sm us-share" style={{ "--n": n, "--c": color } as CSSProperties} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
      {Array.from({ length: n }, (_, i) => (
        <i key={i} className={i < on || (i === 0 && pct > 0) ? "on" : ""} />
      ))}
    </div>
  );
}

function Tile({ label, value, provenance, note }: { label: string; value: string; provenance: Provenance | null; note?: string }) {
  return (
    <div className="spec us-tile">
      <Label>{label}</Label>
      <div className="us-val num">{value}</div>
      <div className="us-tile-foot">
        {provenance && <ProvBadge value={provenance} />}
        {note && <span className="muted">{note}</span>}
      </div>
    </div>
  );
}

export function UsagePanel({ days, providers }: { days: number; providers: CatalogProvider[] }) {
  const { t, i18n } = useTranslation("limits");
  const money = useMoney();
  const usage = useUsage(days);
  const [by, setBy] = useState<UsageDimension>("day");
  const [metric, setMetric] = useState<UsageMetric>("tokens");
  const [all, setAll] = useState(false);
  const [saved, setSaved] = useState<{ ok: boolean; text: string } | null>(null);
  const lang = i18n.language;
  const groupOf = useMemo(() => {
    const m = new Map(providers.map((p) => [p.id, p.group as ProviderGroup]));
    return (id: string) => m.get(id);
  }, [providers]);
  const report = usage.data;
  const records = useMemo(() => report?.records ?? [], [report]);
  const totals = useMemo(() => usageTotals(records, groupOf), [records, groupOf]);
  const groups = useMemo(() => (report ? (by === "day" ? dailySeries(report, groupOf) : groupUsage(records, by, groupOf)) : []), [report, records, by, groupOf]);
  const useMetric: UsageMetric = metric === "usd" && totals.hasDollars ? "usd" : "tokens";
  const parts = useMemo(() => (by === "day" ? [] : slices(groups, useMetric)), [groups, by, useMetric]);
  const max = Math.max(0, ...groups.map((g) => metricOf(g, useMetric)));
  const sum = groups.reduce((n, g) => n + metricOf(g, useMetric), 0);

  const dayFmt = new Intl.DateTimeFormat(lang, { weekday: "short", day: "numeric", month: "short" });
  const nameOf = (key: string, dim: UsageDimension): string => {
    if (key === OTHER) return t("usage.other");
    if (dim === "day") {
      const [y, m, d] = key.split("-").map(Number);
      return y && m && d ? dayFmt.format(new Date(y, m - 1, d)) : key;
    }
    if (dim === "provider") return providers.find((p) => p.id === key)?.name ?? key;
    if (dim === "model") return key === NO_KEY ? t("usage.noModel") : key;
    return key === NO_KEY ? t("usage.noTask") : (records.find((r) => r.taskId === key)?.taskTitle ?? key);
  };
  // A runner hue only where a group is one runner's; mixed groups use the neutral series.
  const colorOf = (key: string): string => {
    if (by === "provider") return providerColor(key);
    if (by === "day" || key === OTHER) return "var(--series-other)";
    const runners = new Set(records.filter((r) => (by === "model" ? (r.model ?? NO_KEY) : (r.taskId ?? NO_KEY)) === key).map((r) => r.runner));
    const only = runners.size === 1 ? [...runners][0] : null;
    return only && only in RUNNER_COLOR ? RUNNER_COLOR[only as keyof typeof RUNNER_COLOR] : "var(--series-other)";
  };
  const fmt = (g: UsageGroup) => (useMetric === "usd" ? money(g.usd ?? 0) : compact(metricOf(g, "tokens"), lang));
  const fmtValue = (v: number) => (useMetric === "usd" ? money(v) : compact(v, lang));

  const save = async (kind: "csv" | "json") => {
    if (!report) return;
    const text = kind === "csv" ? usageCsv(report, groupOf) : usageJson(report, groupOf);
    try {
      const path = await window.crewyard.saveExport(kind, `crewyard-usage-${report.from}-${report.to}`, text);
      if (path) setSaved({ ok: true, text: t("usage.saved", { path }) });
    } catch (err) {
      setSaved({ ok: false, text: t("usage.saveFailed", { error: err instanceof Error ? err.message : String(err) }) });
    }
  };

  const shown = by === "day" || all ? groups : groups.slice(0, LEDGER_ROWS);
  const empty = usage.isSuccess && records.length === 0;
  const range = t(`range.${days}`);
  const tokensTotal = totals.tokensIn + totals.tokensOut;

  return (
    <Panel className="us">
      <div className="ph us-head">
        <h2>{t("usage.title")}</h2>
        <span className="lbl us-sub">{t("usage.sub", { range })}</span>
        <div className="end us-export">
          <Button size="sm" disabled={!report || empty} onClick={() => void save("csv")}>
            <Download size={14} strokeWidth={1.75} aria-hidden="true" />
            {t("usage.exportCsv")}
          </Button>
          <Button size="sm" disabled={!report || empty} onClick={() => void save("json")}>
            <Download size={14} strokeWidth={1.75} aria-hidden="true" />
            {t("usage.exportJson")}
          </Button>
        </div>
      </div>
      {saved && (
        <p className={`us-saved ${saved.ok ? "muted" : "pv-error"}`} role="status">
          {saved.text}
        </p>
      )}
      {usage.isError && <p className="pv-error us-pad">{t("usage.loadFailed")}</p>}
      {empty && <p className="muted us-pad">{t("usage.empty")}</p>}
      {report && !empty && (
        <>
          <div className="us-tiles">
            <Tile
              label={t("usage.spend")}
              value={totals.hasDollars ? money(totals.usd) : "—"}
              provenance={totals.hasDollars ? totals.usdProvenance : "unknown"}
              note={totals.hasDollars ? t("usage.spendNote") : t("usage.noKeySpend")}
            />
            <Tile label={t("usage.tokensIn")} value={compact(totals.tokensIn, lang)} provenance={totals.tokensProvenance} />
            <Tile label={t("usage.tokensOut")} value={compact(totals.tokensOut, lang)} provenance={totals.tokensProvenance} />
            <Tile
              label={t("usage.cacheRead")}
              value={totals.cacheRead === 0 && totals.cacheUnknown ? "—" : compact(totals.cacheRead, lang)}
              provenance={totals.cacheRead === 0 && totals.cacheUnknown ? "unknown" : totals.tokensProvenance}
              note={totals.cacheUnknown ? t("usage.cachePartial") : undefined}
            />
            <Tile label={t("usage.unbilled")} value={compact(totals.unbilledTokens, lang)} provenance={totals.unbilledTokens > 0 ? totals.tokensProvenance : null} note={t("usage.unbilledNote")} />
          </div>
          <div className="us-controls">
            <div className="seg" role="group" aria-label={t("usage.byLabel")}>
              {DIMENSIONS.map((d) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={by === d}
                  onClick={() => {
                    setBy(d);
                    setAll(false);
                  }}
                >
                  {t(`usage.by.${d}`)}
                </button>
              ))}
            </div>
            <div className="seg" role="group" aria-label={t("usage.metricLabel")}>
              <button type="button" aria-pressed={useMetric === "tokens"} onClick={() => setMetric("tokens")}>
                {t("usage.metric.tokens")}
              </button>
              <button type="button" aria-pressed={useMetric === "usd"} disabled={!totals.hasDollars} title={totals.hasDollars ? undefined : t("usage.noKeySpend")} onClick={() => setMetric("usd")}>
                {t("usage.metric.usd")}
              </button>
            </div>
          </div>
          {parts.length > 0 && (
            <div className="us-bar">
              <div
                className="segbar"
                role="img"
                aria-label={t("usage.barAria", {
                  metric: t(`usage.metric.${useMetric}`),
                  by: t(`usage.by.${by}`),
                  parts: parts.map((s) => `${nameOf(s.key, by)} ${sharePct(s.value, sum)}%`).join(", "),
                })}
              >
                {parts.map((s) => (
                  <span key={s.key} style={{ flex: Math.max(1, s.value), ["--c" as string]: colorOf(s.key) }} />
                ))}
              </div>
              <div className="legend4 us-legend">
                {parts.map((s) => (
                  <div key={s.key}>
                    <div className="k">
                      <Dot color={colorOf(s.key)} />
                      <span className={by === "task" || by === "model" ? "as-typed us-ellipsis" : "us-ellipsis"} title={nameOf(s.key, by)}>
                        {nameOf(s.key, by)}
                      </span>
                    </div>
                    <div className="v num">
                      {fmtValue(s.value)} <small>{sharePct(s.value, sum)}%</small>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="us-table-wrap">
            <table className="us-table">
              <caption className="sr-only">{t("usage.caption", { by: t(`usage.by.${by}`), range })}</caption>
              <thead>
                <tr>
                  <th scope="col">{t(`usage.col.${by}`)}</th>
                  <th scope="col" className="us-c-share">
                    <span className="sr-only">{t("usage.col.share")}</span>
                  </th>
                  <th scope="col" className="num">
                    {t("usage.col.in")}
                  </th>
                  <th scope="col" className="num">
                    {t("usage.col.out")}
                  </th>
                  <th scope="col" className="num us-c-cache">
                    {t("usage.col.cache")}
                  </th>
                  <th scope="col" className="us-c-src">
                    {t("usage.col.source")}
                  </th>
                  <th scope="col" className="num">
                    {t("usage.col.usd")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((g) => {
                  const name = nameOf(g.key, by);
                  const pct = max > 0 ? (100 * metricOf(g, useMetric)) / max : 0;
                  const quiet = totalTokens(g) === 0;
                  return (
                    <tr key={g.key} className={quiet ? "quiet" : undefined}>
                      <th scope="row">
                        <span className="us-name">
                          {by === "provider" && <BrandIcon id={g.key} size={14} />}
                          <span className={by === "task" || by === "model" ? "as-typed us-ellipsis" : "us-ellipsis"} title={name}>
                            {name}
                          </span>
                        </span>
                      </th>
                      <td className="us-c-share">
                        <ShareTicks pct={pct} color={colorOf(g.key)} label={t("usage.shareAria", { name, value: fmt(g), pct: sharePct(metricOf(g, useMetric), sum) })} />
                      </td>
                      <td className="num">{quiet ? "—" : compact(g.tokensIn, lang)}</td>
                      <td className="num">{quiet ? "—" : compact(g.tokensOut, lang)}</td>
                      <td className="num us-c-cache">{quiet ? "—" : g.cacheUnknown && g.cacheRead === 0 ? <span className="muted">{t("usage.unknown")}</span> : `${compact(g.cacheRead, lang)}${g.cacheUnknown ? "+" : ""}`}</td>
                      <td className="us-c-src">{!quiet && <ProvBadge value={g.tokensProvenance} />}</td>
                      <td className="num">
                        {g.usd === null ? (
                          <span className="muted" title={quiet ? undefined : t("usage.noDollarsHint")}>
                            {quiet ? "—" : t("usage.noDollars")}
                          </span>
                        ) : (
                          <span className="us-usd">
                            {money(g.usd)}
                            <ProvBadge value={g.usdProvenance} />
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {by !== "day" && groups.length > LEDGER_ROWS && (
            <div className="us-pad">
              <Button size="sm" variant="ghost" onClick={() => setAll((a) => !a)}>
                {all ? t("usage.showFewer") : t("usage.showAll", { count: groups.length })}
              </Button>
            </div>
          )}
          <p className="unk-note us-note">{t("usage.note", { tokens: compact(tokensTotal, lang) })}</p>
        </>
      )}
    </Panel>
  );
}
