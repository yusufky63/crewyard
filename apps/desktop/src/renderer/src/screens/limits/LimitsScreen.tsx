import { useMemo, useState, type ChangeEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { BrandIcon, Button, Dot, Label, Panel, TickMeter } from "@crewyard/ui";
import type { CatalogProvider, CredentialSummary, IdleRefreshView, PlanQuotaView, ProfileSummary, Provenance, SignInSession, SignInStatus, Thresholds, UsageWindowView } from "@crewyard/core";
import { call } from "../../ipc.ts";
import { useProvidersQuery as useDaemon } from "../providers/data.ts";
import { providerColor, ProvBadge, RUNNER_COLOR, useMoney, useProvidersLive, useWhen } from "../providers/shared.tsx";
import { SignInBadge, SignInControl, useSignIn } from "../providers/SignIn.tsx";
import "../providers/providers.css";
import { FIXTURE } from "./fixture.ts";
import { UsagePanel } from "./Usage.tsx";
import "./limits.css";

const RANGES = [1, 7, 30] as const;
// Limits first (what needs you), the usage ledger one click away (DESIGN.md §6, second level).
const VIEWS = ["limits", "usage"] as const;
/** Screenshot mode only (`fixture&view=usage`). */
const SHOT_VIEW = FIXTURE ? new URLSearchParams(location.search).get("view") : null;
// Plan windows, shortest first; context and budget windows belong to runs and tasks.
const WINDOW_ORDER: string[] = ["5h", "daily", "weekly", "monthly"];

function levelColor(pct: number | null, t: Thresholds): string | undefined {
  if (pct === null) return undefined;
  if (pct >= t.critical) return "var(--bad)";
  if (pct >= t.warn) return "var(--warn)";
  return undefined;
}

function PlanAccount({
  profile,
  provider,
  windows,
  thresholds,
  signIn,
  session,
}: {
  profile: ProfileSummary;
  provider: CatalogProvider | undefined;
  windows: UsageWindowView[];
  thresholds: Thresholds;
  signIn: SignInStatus | undefined;
  session: SignInSession | undefined;
}) {
  const { t } = useTranslation("limits");
  const when = useWhen();
  const color = RUNNER_COLOR[profile.runner];
  const mine = windows.filter((w) => w.profileId === profile.id);
  const name = `${t(`providers:runner.${profile.runner}`)} · ${profile.alias}`;
  return (
    <div className="lim">
      <div className="lim-top">
        <BrandIcon id={profile.runner} />
        <span className="name">{name}</span>
        <Label>{provider?.name ?? profile.providerId}</Label>
        <div className="end">
          <ProvBadge value={bestProvenance(mine)} />
        </div>
      </div>
      {signIn?.state === "signed_in" && (
        <div className="lim-meta lim-signin">
          <SignInBadge status={signIn} />
          {signIn.probedAt && <span className="muted">{t("plans.signInChecked", { time: when.ago(signIn.probedAt) })}</span>}
        </div>
      )}
      {signIn && signIn.state !== "signed_in" && <SignInControl profile={profile} status={signIn} session={session} compact />}
      <WindowLines windows={mine} name={name} color={color} thresholds={thresholds} />
    </div>
  );
}

const bestProvenance = (ws: UsageWindowView[]): Provenance => (ws.some((w) => w.provenance === "reported") ? "reported" : ws.some((w) => w.provenance === "estimated") ? "estimated" : "unknown");

/** Latest reading per bucket and window over the profiles that share one key. */
function newestPerWindow(ws: UsageWindowView[]): UsageWindowView[] {
  const by = new Map<string, UsageWindowView>();
  for (const w of ws) {
    const k = `${w.bucket ?? ""}|${w.window}`;
    const prev = by.get(k);
    if (!prev || w.observedAt > prev.observedAt) by.set(k, w);
  }
  return [...by.values()];
}

/** One meter per window of every bucket: the account's main limit first, each other bucket under its own name. */
function WindowLines({ windows, name, color, thresholds }: { windows: UsageWindowView[]; name: string; color: string; thresholds: Thresholds }) {
  const { t } = useTranslation("limits");
  const when = useWhen();
  const plan = windows.filter((w) => WINDOW_ORDER.includes(w.window));
  if (plan.length === 0)
    return (
      <div className="mline">
        <span className="sec">{t("plans.quota")}</span>
        <TickMeter value={null} label={t("plans.unknownMeter", { name })} />
        <span className="v muted">
          —<small>{t("plans.noData")}</small>
        </span>
      </div>
    );
  const buckets = [...new Set(plan.map((w) => w.bucket ?? ""))].sort((a, b) => Number(a !== "") - Number(b !== "") || a.localeCompare(b));
  return (
    <>
      {buckets.map((b) => {
        const lines = plan.filter((w) => (w.bucket ?? "") === b).sort((x, y) => WINDOW_ORDER.indexOf(x.window) - WINDOW_ORDER.indexOf(y.window));
        const bucketName = b ? t(`plans.bucket.${b}`, { defaultValue: lines[0]?.bucketLabel ?? b }) : null;
        return (
          <div className="lim-bucket" key={b || "main"}>
            {bucketName && <div className="lbl lim-bucket-name">{bucketName}</div>}
            {lines.map((w) => {
              const window = t(`plans.window.${w.window}`);
              const label =
                w.usedPct === null
                  ? t("plans.unknownMeter", { name })
                  : bucketName
                    ? t("plans.meterBucket", { name, bucket: bucketName, window, pct: Math.round(w.usedPct) })
                    : t("plans.meter", { name, window, pct: Math.round(w.usedPct) });
              return (
                <div className="mline" key={w.window}>
                  <span className="sec">{window}</span>
                  <TickMeter value={w.usedPct} color={color} label={label} />
                  <span className="v" style={{ color: levelColor(w.usedPct, thresholds) }}>
                    {w.usedPct === null ? "—" : `${Math.round(w.usedPct)}%`}
                    {w.resetsAt && w.usedPct !== null && <small>{t("plans.resets", { time: when.at(w.resetsAt) })}</small>}
                    <small>{t("plans.lineMeta", { provenance: t(`provenance.${w.provenance}`), time: when.ago(w.observedAt) })}</small>
                  </span>
                </div>
              );
            })}
          </div>
        );
      })}
    </>
  );
}

/** A coding-plan key (Kimi Code, Z.ai, MiniMax, OpenCode Go): its quota read with the key, as Reported. */
function PlanKeyAccount({ quota, credential, provider, profiles, windows, thresholds }: { quota: PlanQuotaView; credential: CredentialSummary | undefined; provider: CatalogProvider | undefined; profiles: ProfileSummary[]; windows: UsageWindowView[]; thresholds: Thresholds }) {
  const { t } = useTranslation("limits");
  const when = useWhen();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const ids = new Set(profiles.filter((p) => p.credentialId === quota.credentialId).map((p) => p.id));
  const mine = quota.state === "no_plan" ? [] : newestPerWindow(windows.filter((w) => ids.has(w.profileId)));
  const name = `${provider?.name ?? quota.providerId} · ${credential?.alias ?? ""}`;
  const check = async () => {
    setBusy(true);
    try {
      await call("providers.planQuotaRefresh", { credentialId: quota.credentialId });
      await qc.invalidateQueries({ predicate: (q) => ["providers.limits", "providers.accounts"].includes(String(q.queryKey[0])) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="lim">
      <div className="lim-top">
        <BrandIcon id={quota.providerId} />
        <span className="name">{name}</span>
        <Label>{t("plans.codingPlan")}</Label>
        <div className="end">
          <ProvBadge value={quota.state === "ok" ? bestProvenance(mine) : "unknown"} />
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void check()} aria-label={t("plans.checkNamed", { name })}>
            <RefreshCw size={14} strokeWidth={1.75} />
            {t("plans.check")}
          </Button>
        </div>
      </div>
      <div className={`lim-meta${quota.state === "error" ? " pv-error" : quota.state === "ok" ? " st-ok" : " muted"}`}>
        {quota.state === "ok" && quota.checkedAt
          ? t("plans.state.ok", { time: when.ago(quota.checkedAt) })
          : quota.state === "error"
            ? t("plans.state.error", { problem: quota.problem ?? "" })
            : quota.state === "no_plan"
              ? t("plans.state.no_plan")
              : t("plans.state.unchecked")}
      </div>
      {quota.state !== "no_plan" && (ids.size === 0 ? <p className="lim-meta muted">{t("plans.noProfile")}</p> : <WindowLines windows={mine} name={name} color={providerColor(quota.providerId)} thresholds={thresholds} />)}
    </div>
  );
}

function PlanWindows({ profiles, providers }: { profiles: ProfileSummary[]; providers: CatalogProvider[] }) {
  const { t } = useTranslation("limits");
  const limits = useDaemon("providers.limits", undefined);
  const creds = useDaemon("providers.credentials", undefined);
  const signIn = useSignIn();
  const plan = profiles.filter((p) => p.credentialId === null && providers.find((x) => x.id === p.providerId)?.group !== "local");
  const keys = limits.data?.plans ?? [];
  const thresholds = limits.data?.thresholds;
  return (
    <Panel>
      <div className="ph">
        <h2>{t("plans.title")}</h2>
        {thresholds && <span className="end lbl">{t("plans.notify", { warn: thresholds.warn, critical: thresholds.critical })}</span>}
      </div>
      {plan.length === 0 && keys.length === 0 && limits.isSuccess && <p className="lim-empty muted">{t("plans.none")}</p>}
      {/* Coding-plan keys first: their quota is read with the key, so it is there without a run. */}
      {thresholds &&
        keys.map((q) => (
          <PlanKeyAccount
            key={q.credentialId}
            quota={q}
            credential={creds.data?.find((c) => c.id === q.credentialId)}
            provider={providers.find((x) => x.id === q.providerId)}
            profiles={profiles}
            windows={limits.data?.windows ?? []}
            thresholds={thresholds}
          />
        ))}
      {thresholds &&
        plan.map((p) => (
          <PlanAccount
            key={p.id}
            profile={p}
            provider={providers.find((x) => x.id === p.providerId)}
            windows={limits.data?.windows ?? []}
            thresholds={thresholds}
            signIn={signIn.status.find((s) => s.profileId === p.id)}
            session={signIn.sessions.find((s) => s.profileId === p.id)}
          />
        ))}
      {limits.data && !limits.data.samplesAvailable && plan.length > 0 && <p className="unk-note lim-note">{t("plans.noSamples")}</p>}
      <p className="unk-note lim-note">{t("plans.claudeNote")}</p>
    </Panel>
  );
}

function SpendPanel({ days, providers }: { days: number; providers: CatalogProvider[] }) {
  const { t } = useTranslation("limits");
  const money = useMoney();
  const spend = useDaemon("providers.spend", { days });
  const data = spend.data;
  // Four slices at most; past that the tail is summed so the legend stays readable.
  const slices = useMemo(() => {
    const all = data?.byProvider ?? [];
    const slice = (key: string, usd: number) => ({ key, usd, label: providers.find((p) => p.id === key)?.name ?? key, color: providerColor(key) });
    if (all.length <= 4) return all.map((s) => slice(s.key, s.usd));
    const rest = all.slice(3).reduce((n, s) => n + s.usd, 0);
    return [...all.slice(0, 3).map((s) => slice(s.key, s.usd)), { key: "other", usd: rest, label: t("spend.other"), color: "var(--series-other)" }];
  }, [data, providers, t]);
  const total = data?.totalUsd ?? 0;
  const pct = (usd: number) => (total > 0 ? Math.round((usd / total) * 100) : 0);
  return (
    <Panel className="pbody">
      <div className="lim-top">
        <Label>{t("spend.title", { range: t(`range.${days}`) })}</Label>
        <div className="end">{data && <ProvBadge value={data.byProvider.length ? data.provenance : "estimated"} />}</div>
      </div>
      <div className="metric num">{money(total)}</div>
      <div className="lbl lim-sub">{t("spend.note")}</div>
      {slices.length > 0 ? (
        <>
          <div className="segbar" role="img" aria-label={t("spend.aria", { parts: slices.map((s) => `${s.label} ${pct(s.usd)}%`).join(", ") })}>
            {slices.map((s) => (
              <span key={s.key} style={{ flex: Math.max(1, s.usd), ["--c" as string]: s.color }} />
            ))}
          </div>
          <div className="legend4">
            {slices.map((s) => (
              <div key={s.key}>
                <div className="k">
                  <Dot color={s.color} />
                  {s.label}
                </div>
                <div className="v num">
                  {money(s.usd)} <small>{pct(s.usd)}%</small>
                </div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <p className="muted lim-empty-inline">{spend.isSuccess ? t("spend.empty") : " "}</p>
      )}
    </Panel>
  );
}

function parseCap(v: string): number | null | "bad" {
  if (v.trim() === "") return null;
  const n = Number(v.replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? n : "bad";
}

function CapRow({ credential, provider, todayUsd, todayProvenance }: { credential: CredentialSummary; provider: CatalogProvider | undefined; todayUsd: number; todayProvenance: "reported" | "estimated" | "unknown" }) {
  const { t } = useTranslation("limits");
  const money = useMoney();
  const when = useWhen();
  const qc = useQueryClient();
  const balances = useDaemon("providers.balances", undefined);
  const bal = balances.data?.find((b) => b.credentialId === credential.id);
  const [editing, setEditing] = useState(false);
  const [daily, setDaily] = useState("");
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cap = credential.caps.dailyUsd;
  const pct = cap === null ? null : cap === 0 ? 100 : Math.min(100, (todayUsd / cap) * 100);
  const color = providerColor(credential.providerId);
  const name = `${provider?.name ?? credential.providerId} · ${credential.alias}`;

  const open = () => {
    setDaily(credential.caps.dailyUsd?.toString() ?? "");
    setTask(credential.caps.taskUsd?.toString() ?? "");
    setError(null);
    setEditing(true);
  };
  const save = async () => {
    const d = parseCap(daily);
    const tk = parseCap(task);
    if (d === "bad" || tk === "bad") return setError(t("caps.invalid"));
    setBusy(true);
    try {
      await call("providers.capsSet", { credentialId: credential.id, dailyUsd: d, taskUsd: tk });
      await qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("providers.") });
      setEditing(false);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };
  const check = async () => {
    setBusy(true);
    try {
      await call("providers.balancesRefresh", { credentialId: credential.id });
      await qc.invalidateQueries({ queryKey: ["providers.balances"] });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lim">
      <div className="lim-top">
        <BrandIcon id={credential.providerId} />
        <span className="name">{name}</span>
        <div className="end">
          {provider?.balance ? (
            <>
              {bal?.wallets.length ? <span className="num mono lim-bal">{bal.wallets.map((w) => money(w)).join(" · ")}</span> : <span className="muted lim-bal">{t("caps.notChecked")}</span>}
              <ProvBadge value={bal?.wallets.length ? "reported" : "unknown"} />
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void check()} aria-label={t("caps.checkNamed", { name })}>
                <RefreshCw size={14} strokeWidth={1.75} />
                {t("caps.check")}
              </Button>
            </>
          ) : (
            <span className="muted lim-bal">{t("caps.noEndpoint")}</span>
          )}
        </div>
      </div>
      {bal?.fetchedAt && <div className="lim-meta muted">{t("caps.checkedAt", { time: when.ago(bal.fetchedAt) })}</div>}
      {bal?.error && <div className="lim-meta pv-error">{t("caps.error", { error: bal.error })}</div>}
      <div className="mline">
        <span className="sec">{cap === null ? t("caps.noDailyCap") : t("caps.dailyCap", { cap: money(cap) })}</span>
        <TickMeter value={pct} color={color} label={pct === null ? t("caps.meterNoCap", { name }) : t("caps.meter", { name, pct: Math.round(pct) })} />
        <span className="v" style={{ color: pct !== null && pct >= 100 ? "var(--bad)" : undefined }}>
          {money(todayUsd)}
          <small>{t("caps.usedToday")}</small>
        </span>
      </div>
      <div className="lim-foot">
        <ProvBadge value={todayProvenance} />
        <span className="muted">{credential.caps.taskUsd === null ? t("caps.noTaskCap") : t("caps.taskCap", { cap: money(credential.caps.taskUsd) })}</span>
        {!editing && (
          <Button size="sm" variant="ghost" className="lim-edit" onClick={open} aria-label={t("caps.editNamed", { name })}>
            {t("caps.edit")}
          </Button>
        )}
      </div>
      {editing && (
        <form
          className="lim-caps"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label>
            <span className="lbl">{t("caps.daily")}</span>
            <input className="pv-input mono" inputMode="decimal" value={daily} onChange={(e) => setDaily(e.target.value)} placeholder={t("caps.none")} />
          </label>
          <label>
            <span className="lbl">{t("caps.task")}</span>
            <input className="pv-input mono" inputMode="decimal" value={task} onChange={(e) => setTask(e.target.value)} placeholder={t("caps.none")} />
          </label>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            {t("caps.cancel")}
          </Button>
          <Button size="sm" type="submit" disabled={busy}>
            {t("caps.save")}
          </Button>
          {error && <p className="pv-error">{error}</p>}
        </form>
      )}
    </div>
  );
}

function CapsPanel({ providers }: { providers: CatalogProvider[] }) {
  const { t } = useTranslation("limits");
  const creds = useDaemon("providers.credentials", undefined);
  const today = useDaemon("providers.spend", { days: 1 });
  const keys = (creds.data ?? []).filter((c) => c.kind === "api_key");
  return (
    <Panel>
      <div className="ph">
        <h2>{t("caps.title")}</h2>
      </div>
      {creds.isSuccess && keys.length === 0 && <p className="lim-empty muted">{t("caps.empty")}</p>}
      {keys.map((c) => {
        const s = today.data?.todayByCredential.find((x) => x.key === c.id);
        return <CapRow key={c.id} credential={c} provider={providers.find((p) => p.id === c.providerId)} todayUsd={s?.usd ?? 0} todayProvenance={s?.provenance ?? "estimated"} />;
      })}
    </Panel>
  );
}

function AlertsPanel() {
  const { t } = useTranslation("limits");
  const limits = useDaemon("providers.limits", undefined);
  const current = limits.data?.thresholds;
  return (
    <Panel>
      <div className="ph">
        <h2>{t("alerts.title")}</h2>
      </div>
      {/* Keyed by the saved values so the inputs start from them again after a save. */}
      {current && <AlertsForm key={`${current.warn}-${current.critical}`} current={current} />}
      {limits.data && <IdleRefreshRow view={limits.data.idleRefresh} />}
    </Panel>
  );
}

/** The background plan-window reads, switchable and with what they call spelled out (cc-switch #3519). */
function IdleRefreshRow({ view }: { view: IdleRefreshView }) {
  const { t } = useTranslation("limits");
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const toggle = async (params: { enabled?: boolean; planQuota?: boolean }) => {
    setBusy(true);
    try {
      await call("providers.idleRefreshSet", params);
      await qc.invalidateQueries({ queryKey: ["providers.limits"] });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="lim-idle">
      <label className="lim-idle-head">
        <input type="checkbox" checked={view.enabled} disabled={busy} onChange={(e) => void toggle({ enabled: e.target.checked })} />
        <span>{t("alerts.idle")}</span>
      </label>
      <p className="muted">{t("alerts.idleHint", { minutes: view.everyMinutes })}</p>
      <p className="muted">
        {t("alerts.idleCalls")} <code className="mono">{view.endpoint}</code>
      </p>
      <label className="lim-idle-head lim-idle-next">
        <input type="checkbox" checked={view.planQuota.enabled} disabled={busy} onChange={(e) => void toggle({ planQuota: e.target.checked })} />
        <span>{t("alerts.planQuota")}</span>
      </label>
      <p className="muted">{t("alerts.planQuotaHint")}</p>
      <p className="muted">{t("alerts.planQuotaCalls")}</p>
      <ul className="lim-endpoints">
        {view.planQuota.endpoints.map((e) => (
          <li key={e.providerId}>
            <code className="mono">GET {e.url}</code> <span className="muted">· {t(`alerts.auth.${e.auth}`)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AlertsForm({ current }: { current: Thresholds }) {
  const { t } = useTranslation("limits");
  const qc = useQueryClient();
  const [warn, setWarn] = useState(String(current.warn));
  const [critical, setCritical] = useState(String(current.critical));
  const [invalid, setInvalid] = useState(false);
  const save = async () => {
    const w = Number(warn);
    const c = Number(critical);
    if (!Number.isInteger(w) || !Number.isInteger(c) || w < 10 || c > 100 || w >= c) return setInvalid(true);
    await call("providers.thresholdsSet", { warn: w, critical: c });
    await qc.invalidateQueries({ queryKey: ["providers.limits"] });
  };
  const edit = (set: (v: string) => void) => (e: ChangeEvent<HTMLInputElement>) => {
    set(e.target.value);
    setInvalid(false);
  };
  const dirty = String(current.warn) !== warn || String(current.critical) !== critical;
  return (
    <form
      className="lim-alerts"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label className="setrow">
        {t("alerts.warn")}
        <span className="end lim-pct">
          <input className="pv-input mono" inputMode="numeric" value={warn} onChange={edit(setWarn)} />%
        </span>
      </label>
      <label className="setrow">
        {t("alerts.critical")}
        <span className="end lim-pct">
          <input className="pv-input mono" inputMode="numeric" value={critical} onChange={edit(setCritical)} />%
        </span>
      </label>
      <div className="setrow">
        <span className={invalid ? "pv-error" : "muted"}>{invalid ? t("alerts.invalid") : t("alerts.hint")}</span>
        <Button size="sm" type="submit" className="end" disabled={!dirty}>
          {t("alerts.save")}
        </Button>
      </div>
    </form>
  );
}

export function LimitsScreen() {
  const { t } = useTranslation("limits");
  useProvidersLive();
  const [days, setDays] = useState<(typeof RANGES)[number]>(7);
  const [view, setView] = useState<(typeof VIEWS)[number]>(SHOT_VIEW === "usage" ? "usage" : "limits");
  const catalog = useDaemon("providers.catalog", undefined, { staleTime: Infinity });
  const profiles = useDaemon("providers.profiles", undefined);
  const providers = catalog.data?.providers ?? [];
  return (
    <section className="screen limits" aria-label={t("title")}>
      <div className="page-head">
        <div>
          <h1>{t("title")}</h1>
          <div className="sub lbl">{t("sub")}</div>
        </div>
        <div className="right">
          <div className="seg" role="group" aria-label={t("range.label")}>
            {RANGES.map((r) => (
              <button key={r} aria-pressed={days === r} onClick={() => setDays(r)}>
                {t(`range.${r}`)}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="tabs lim-view" role="tablist" aria-label={t("view.label")}>
        {VIEWS.map((v) => (
          <button key={v} type="button" role="tab" id={`lim-tab-${v}`} aria-selected={view === v} aria-controls="lim-view-panel" onClick={() => setView(v)}>
            {t(`view.${v}`)}
          </button>
        ))}
      </div>
      <div id="lim-view-panel" role="tabpanel" aria-labelledby={`lim-tab-${view}`}>
        {view === "limits" ? (
          <div className="grid2">
            <PlanWindows profiles={profiles.data ?? []} providers={providers} />
            <div className="stack">
              <SpendPanel days={days} providers={providers} />
              <CapsPanel providers={providers} />
              <AlertsPanel />
            </div>
          </div>
        ) : (
          <UsagePanel days={days} providers={providers} />
        )}
      </div>
    </section>
  );
}
