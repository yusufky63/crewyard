import { useMemo, useState, type ChangeEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { BrandIcon, Button, Dot, Label, Panel, TickMeter } from "@crewyard/ui";
import type { CatalogProvider, CredentialSummary, IdleRefreshView, ProfileSummary, SignInSession, SignInStatus, Thresholds, UsageWindowView } from "@crewyard/core";
import { call } from "../../ipc.ts";
import { useProvidersQuery as useDaemon } from "../providers/data.ts";
import { providerColor, ProvBadge, RUNNER_COLOR, useMoney, useProvidersLive, useWhen } from "../providers/shared.tsx";
import { SignInBadge, SignInControl, useSignIn } from "../providers/SignIn.tsx";
import "../providers/providers.css";
import "./limits.css";

const RANGES = [1, 7, 30] as const;
const WINDOW_ORDER = ["5h", "weekly", "daily", "context"];

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
  const mine = windows.filter((w) => w.profileId === profile.id).sort((a, b) => WINDOW_ORDER.indexOf(a.window) - WINDOW_ORDER.indexOf(b.window));
  const name = `${t(`providers:runner.${profile.runner}`)} · ${profile.alias}`;
  const best = mine.some((w) => w.provenance === "reported") ? "reported" : mine.some((w) => w.provenance === "estimated") ? "estimated" : "unknown";
  return (
    <div className="lim">
      <div className="lim-top">
        <BrandIcon id={profile.runner} />
        <span className="name">{name}</span>
        <Label>{provider?.name ?? profile.providerId}</Label>
        <div className="end">
          <ProvBadge value={best} />
        </div>
      </div>
      {signIn?.state === "signed_in" && (
        <div className="lim-meta lim-signin">
          <SignInBadge status={signIn} />
          {signIn.probedAt && <span className="muted">{t("plans.signInChecked", { time: when.ago(signIn.probedAt) })}</span>}
        </div>
      )}
      {signIn && signIn.state !== "signed_in" && <SignInControl profile={profile} status={signIn} session={session} compact />}
      {mine.length === 0 ? (
        <div className="mline">
          <span className="sec">{t("plans.quota")}</span>
          <TickMeter value={null} label={t("plans.unknownMeter", { name })} />
          <span className="v muted">
            —<small>{t("plans.noData")}</small>
          </span>
        </div>
      ) : (
        mine.map((w) => (
          <div className="mline" key={w.window}>
            <span className="sec">{t(`plans.window.${w.window}`)}</span>
            <TickMeter value={w.usedPct} color={color} label={w.usedPct === null ? t("plans.unknownMeter", { name }) : t("plans.meter", { name, window: t(`plans.window.${w.window}`), pct: Math.round(w.usedPct) })} />
            <span className="v" style={{ color: levelColor(w.usedPct, thresholds) }}>
              {w.usedPct === null ? "—" : `${Math.round(w.usedPct)}%`}
              <small>{w.resetsAt ? t("plans.resets", { time: when.at(w.resetsAt) }) : t("plans.seen", { time: when.ago(w.observedAt) })}</small>
            </span>
          </div>
        ))
      )}
    </div>
  );
}

function PlanWindows({ profiles, providers }: { profiles: ProfileSummary[]; providers: CatalogProvider[] }) {
  const { t } = useTranslation("limits");
  const limits = useDaemon("providers.limits", undefined);
  const signIn = useSignIn();
  const plan = profiles.filter((p) => p.credentialId === null && providers.find((x) => x.id === p.providerId)?.group !== "local");
  const thresholds = limits.data?.thresholds;
  return (
    <Panel>
      <div className="ph">
        <h2>{t("plans.title")}</h2>
        {thresholds && <span className="end lbl">{t("plans.notify", { warn: thresholds.warn, critical: thresholds.critical })}</span>}
      </div>
      {plan.length === 0 && <p className="lim-empty muted">{t("plans.none")}</p>}
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
  const toggle = async (enabled: boolean) => {
    setBusy(true);
    try {
      await call("providers.idleRefreshSet", { enabled });
      await qc.invalidateQueries({ queryKey: ["providers.limits"] });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="lim-idle">
      <label className="lim-idle-head">
        <input type="checkbox" checked={view.enabled} disabled={busy} onChange={(e) => void toggle(e.target.checked)} />
        <span>{t("alerts.idle")}</span>
      </label>
      <p className="muted">{t("alerts.idleHint", { minutes: view.everyMinutes })}</p>
      <p className="muted">
        {t("alerts.idleCalls")} <code className="mono">{view.endpoint}</code>
      </p>
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
      <div className="grid2">
        <PlanWindows profiles={profiles.data ?? []} providers={providers} />
        <div className="stack">
          <SpendPanel days={days} providers={providers} />
          <CapsPanel providers={providers} />
          <AlertsPanel />
        </div>
      </div>
    </section>
  );
}
