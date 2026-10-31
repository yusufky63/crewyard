import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { History, Plus, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { BrandIcon, Button, Label, Panel } from "@crewyard/ui";
import { PROFILE_RUNNERS, runnerSupport, type BalanceView, type CatalogProvider, type CredentialSummary, type KeyCheckView, type ProfileSummary, type SignInStatus, type SpendSlice } from "@crewyard/core";
import { call } from "../../ipc.ts";
import { useProvidersQuery as useDaemon } from "./data.ts";
import { FIXTURE } from "./fixture.ts";
import { CatalogDialog, PinNote } from "./Catalog.tsx";
import { AddProviderDialog, ManageDialog } from "./Dialogs.tsx";
import { KeyStateNote, useKeyChecks } from "./KeyCheck.tsx";
import { newestModels, ProvBadge, useMoney, usePrice, useProvidersLive, useWhen } from "./shared.tsx";
import { SignInBadge, useSignIn } from "./SignIn.tsx";
import "./providers.css";

type Filter = "all" | "connected" | CatalogProvider["group"];
const FILTERS: Filter[] = ["all", "connected", "first-party", "coding-plan", "aggregator", "local"];

function RunnerChips({ provider }: { provider: CatalogProvider }) {
  const { t } = useTranslation("providers");
  return (
    <div className="rchips">
      {PROFILE_RUNNERS.map((r) => {
        const s = runnerSupport(provider, r);
        if (s === "none") return null;
        const cls = s === "config" ? "cfg" : s === "conversion" ? "off" : "on";
        return (
          <span key={r} className={`rchip ${cls}`} title={t(`support.${s}`)}>
            {t(`runner.${r}`)}
          </span>
        );
      })}
    </div>
  );
}

function ModelsCell({ provider }: { provider: CatalogProvider }) {
  const { t } = useTranslation("providers");
  const price = usePrice();
  if (provider.group === "local" && provider.models.length === 0) {
    const host = provider.openaiBase ? new URL(provider.openaiBase).host : null;
    return <div className="prov-model">{host ?? t("localModels")}</div>;
  }
  const models = newestModels(provider);
  if (!models.length) return <div className="prov-model muted">{t("noModels")}</div>;
  return (
    <div className="prov-model">
      {models.map((m) => (
        <div key={m.id}>
          {m.id} · {m.cost?.input != null && m.cost.output != null ? `${price(m.cost.input)} / ${price(m.cost.output)}` : t("noPrice")}
        </div>
      ))}
    </div>
  );
}

function CredentialCell({
  provider,
  creds,
  profiles,
  balances,
  today,
  signIns,
  checks,
}: {
  provider: CatalogProvider;
  creds: CredentialSummary[];
  profiles: ProfileSummary[];
  balances: BalanceView[];
  today: SpendSlice[];
  signIns: SignInStatus[];
  checks: KeyCheckView[];
}) {
  const { t } = useTranslation("providers");
  const money = useMoney();
  const when = useWhen();
  const signIn = profiles.filter((p) => p.credentialId === null);
  // Sign-in profiles show where each one stands; local providers keep their one summary line.
  const withStatus = signIn.flatMap((p) => {
    const s = signIns.find((x) => x.profileId === p.id);
    return s ? [{ p, s }] : [];
  });
  const rest = signIn.filter((p) => !withStatus.some((w) => w.p.id === p.id));
  if (!creds.length && !signIn.length) return <span className="muted">{t("notConnected")}</span>;
  return (
    <div className="pv-creds">
      {creds.map((c) => {
        const bal = balances.find((b) => b.credentialId === c.id);
        const spent = today.find((s) => s.key === c.id);
        return (
          <div key={c.id}>
            <div>{c.kind === "local" ? t("noKeyNeeded", { alias: c.alias }) : t("keyAlias", { alias: c.alias })}</div>
            <div className="pv-sub">
              <KeyStateNote check={checks.find((k) => k.credentialId === c.id)} />
              {bal?.wallets.length ? (
                <>
                  {t("balance", { amount: bal.wallets.map((w) => money(w)).join(" · ") })} <ProvBadge value="reported" />
                </>
              ) : c.kind === "api_key" ? (
                <>
                  {c.caps.dailyUsd !== null ? t("todayOfCap", { spent: money(spent?.usd ?? 0), cap: money(c.caps.dailyUsd) }) : t("today", { spent: money(spent?.usd ?? 0) })} <ProvBadge value={spent?.provenance ?? "estimated"} />
                </>
              ) : (
                t("noLimit")
              )}
            </div>
          </div>
        );
      })}
      {withStatus.map(({ p, s }) => (
        <div key={p.id}>
          <div>{t("signInAlias", { runner: t(`runner.${p.runner}`), alias: p.alias })}</div>
          <div className="pv-sub">
            <SignInBadge status={s} />
            <span>{s.probedAt ? t("signIn.checked", { time: when.ago(s.probedAt) }) : t("signIn.neverChecked")}</span>
          </div>
        </div>
      ))}
      {rest.length > 0 && (
        <div>
          <div>{t("ownSignIn", { aliases: rest.map((p) => p.alias).join(", ") })}</div>
          <div className="pv-sub">
            {provider.group === "local" ? t("noLimit") : t("windowsOnLimits")} {provider.group !== "local" && <ProvBadge value="unknown" />}
          </div>
        </div>
      )}
    </div>
  );
}

export function ProvidersScreen() {
  const { t, i18n } = useTranslation("providers");
  const when = useWhen();
  const qc = useQueryClient();
  useProvidersLive();
  const catalog = useDaemon("providers.catalog", undefined, { staleTime: Infinity });
  const creds = useDaemon("providers.credentials", undefined);
  const profiles = useDaemon("providers.profiles", undefined);
  const balances = useDaemon("providers.balances", undefined);
  const spend = useDaemon("providers.spend", { days: 1 });
  const signIn = useSignIn();
  const checks = useKeyChecks();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState<{ id: string | null } | null>(null);
  // Screenshot mode can open one provider's dialog with `manage=<id>`.
  const [managing, setManaging] = useState<string | null>(() => (FIXTURE ? new URLSearchParams(location.search).get("manage") : null));
  // ...and the catalog versions dialog with `versions`.
  const [versions, setVersions] = useState(() => FIXTURE && new URLSearchParams(location.search).has("versions"));

  const refresh = useMutation({
    mutationFn: () => call("providers.catalogRefresh", { force: true }),
    onSettled: () => qc.invalidateQueries({ predicate: (q) => ["providers.catalog", "providers.catalogSnapshots", "providers.priceCheck"].includes(String(q.queryKey[0])) }),
  });

  const providers = useMemo(() => catalog.data?.providers ?? [], [catalog.data]);
  const credList = useMemo(() => creds.data ?? [], [creds.data]);
  const profList = useMemo(() => profiles.data ?? [], [profiles.data]);
  const connected = useMemo(() => new Set([...credList.map((c) => c.providerId), ...profList.map((p) => p.providerId)]), [credList, profList]);
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: providers.length, connected: 0, "first-party": 0, "coding-plan": 0, aggregator: 0, local: 0 };
    for (const p of providers) {
      c[p.group]++;
      if (connected.has(p.id)) c.connected++;
    }
    return c;
  }, [providers, connected]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return providers
      .filter((p) => (filter === "all" ? true : filter === "connected" ? connected.has(p.id) : p.group === filter))
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.id.includes(q) || p.models.some((m) => m.id.toLowerCase().includes(q)))
      .map((p, i) => ({ p, i }))
      // Connected first; otherwise keep the catalog's curated order.
      .sort((a, b) => Number(connected.has(b.p.id)) - Number(connected.has(a.p.id)) || a.i - b.i)
      .map(({ p }) => p);
  }, [providers, filter, query, connected]);

  const info = catalog.data?.info;
  const managed = providers.find((p) => p.id === managing);

  return (
    <section className="screen providers" aria-label={t("title")}>
      <div className="page-head">
        <div>
          <h1>{t("title")}</h1>
          <div className="sub lbl">
            {info
              ? t("sub", {
                  date: when.date(info.generatedAt),
                  sha: info.sourceSha.slice(0, 8),
                  providers: info.providerCount,
                  models: new Intl.NumberFormat(i18n.language).format(info.modelCount),
                })
              : " "}
          </div>
          {info && (
            <div className="pv-catline">
              <span className="muted">
                {t(`origin.${info.origin}`)} · {info.checkedAt ? t("checked", { time: when.ago(info.checkedAt) }) : t("neverChecked")}
              </span>
              <PinNote info={info} />
            </div>
          )}
        </div>
        <div className="right">
          <Button size="sm" variant="ghost" onClick={() => setVersions(true)}>
            <History size={14} strokeWidth={1.75} />
            {t("catalog.open")}
          </Button>
          <Button size="sm" variant="ghost" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
            <RefreshCw size={14} strokeWidth={1.75} />
            {refresh.isPending ? t("refreshing") : t("refresh")}
          </Button>
          <Button size="sm" variant="primary" onClick={() => setAdding({ id: null })}>
            <Plus size={14} strokeWidth={1.75} />
            {t("add")}
          </Button>
        </div>
      </div>

      {info?.lastError && (
        <div className="banner banner-warn pv-banner" role="status">
          {t("offline", { error: info.lastError })}
        </div>
      )}
      {catalog.isError && <div className="banner banner-warn pv-banner">{t("common:errors.daemon", { message: String(catalog.error) })}</div>}

      <div className="pv-toolbar">
        <div className="tabs" role="tablist" aria-label={t("filters.label")}>
          {FILTERS.map((f) => (
            <button key={f} role="tab" aria-selected={filter === f} onClick={() => setFilter(f)}>
              {t(`filters.${f}`)} <span className="n">{counts[f]}</span>
            </button>
          ))}
        </div>
        <input className="pv-input pv-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("search")} aria-label={t("search")} />
      </div>

      <Panel>
        <table className="pv-table">
          <thead>
            <tr>
              <th>{t("cols.provider")}</th>
              <th>{t("cols.models")}</th>
              <th>{t("cols.runners")}</th>
              <th>{t("cols.credential")}</th>
              <th>
                <span className="sr-only">{t("cols.actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const on = connected.has(p.id);
              return (
                <tr key={p.id} className={on ? "" : "dim"}>
                  <td>
                    <div className="prov-name">
                      <BrandIcon id={p.id} />
                      {p.name}
                    </div>
                    <Label className="pv-group">
                      {t(`group.${p.group}`)} · {p.group === "local" && p.models.length === 0 ? t("localModels") : t("models", { count: p.modelCount })}
                    </Label>
                  </td>
                  <td>
                    <ModelsCell provider={p} />
                  </td>
                  <td>
                    <RunnerChips provider={p} />
                  </td>
                  <td>
                    <CredentialCell
                      provider={p}
                      creds={credList.filter((c) => c.providerId === p.id)}
                      profiles={profList.filter((x) => x.providerId === p.id)}
                      balances={balances.data ?? []}
                      today={spend.data?.todayByCredential ?? []}
                      signIns={signIn.status}
                      checks={checks}
                    />
                  </td>
                  <td className="pv-act">
                    {on ? (
                      <Button size="sm" variant="ghost" onClick={() => setManaging(p.id)} aria-label={t("manageNamed", { name: p.name })}>
                        {t("manageAction")}
                      </Button>
                    ) : (
                      <Button size="sm" onClick={() => setAdding({ id: p.id })} aria-label={t("connectNamed", { name: p.name })}>
                        {t("connectAction")}
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
            {catalog.isSuccess && rows.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  {filter === "connected" && !query ? t("emptyConnected") : t("empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="note-row">
          <span className="pv-legend">
            <span className="rchip on">{t("legend.direct")}</span>
            <span className="rchip cfg">{t("legend.config")}</span>
            <span className="rchip off">{t("legend.conversion")}</span>
          </span>
          <span>{t("sources")}</span>
        </div>
      </Panel>

      {versions && <CatalogDialog onClose={() => setVersions(false)} />}
      {adding && <AddProviderDialog providers={providers} credentials={credList} initialId={adding.id} onClose={() => setAdding(null)} />}
      {managed && (
        <ManageDialog
          provider={managed}
          credentials={credList}
          profiles={profList}
          balances={balances.data ?? []}
          onClose={() => setManaging(null)}
          onAddKey={() => {
            setManaging(null);
            setAdding({ id: managed.id });
          }}
        />
      )}
    </section>
  );
}
