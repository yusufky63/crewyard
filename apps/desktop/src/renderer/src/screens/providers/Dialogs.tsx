import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { KeyRound, RefreshCw, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@crewyard/ui";
import {
  PROFILE_RUNNERS,
  runnerSupport,
  signInKindFor,
  usableWith,
  type BalanceView,
  type CatalogProvider,
  type CredentialSummary,
  type ProfileRunner,
  type ProfileSummary,
} from "@crewyard/core";
import { call } from "../../ipc.ts";
import { Field, Modal } from "./Modal.tsx";
import { newestModels, ProvBadge, useMoney, useWhen } from "./shared.tsx";
import { SignInControl, useSignIn } from "./SignIn.tsx";

const errorText = (err: unknown) => (err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err));

function useRefresh() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("providers.") });
}

const suggestAlias = (providerId: string, taken: Set<string>) => {
  const base = providerId.replace(/[^a-z0-9._-]/gi, "-").slice(0, 32);
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`.toLowerCase())) return `${base}-${i}`;
};

function ModelSelect({ provider, value, onChange, id }: { provider: CatalogProvider; value: string; onChange: (v: string) => void; id?: string }) {
  const { t } = useTranslation("providers");
  const models = useMemo(() => [...provider.models].sort((a, b) => (b.released ?? "").localeCompare(a.released ?? "")), [provider]);
  return (
    <select id={id} className="pv-input" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{t("dialog.noModel")}</option>
      {models.map((m) => (
        <option key={m.id} value={m.id}>
          {m.id}
        </option>
      ))}
    </select>
  );
}

/** Pick a provider, paste a key (encrypted by the daemon with DPAPI), choose which runners get a profile. */
export function AddProviderDialog({ providers, credentials, initialId, onClose }: { providers: CatalogProvider[]; credentials: CredentialSummary[]; initialId: string | null; onClose: () => void }) {
  const { t } = useTranslation("providers");
  const refresh = useRefresh();
  const taken = useMemo(() => new Set(credentials.map((c) => c.alias.toLowerCase())), [credentials]);
  const sorted = useMemo(() => [...providers].sort((a, b) => a.name.localeCompare(b.name)), [providers]);
  const [providerId, setProviderId] = useState(initialId ?? "");
  const provider = providers.find((p) => p.id === providerId);
  const usable = provider ? PROFILE_RUNNERS.filter((r) => usableWith(runnerSupport(provider, r))) : [];
  const [alias, setAlias] = useState(initialId ? suggestAlias(initialId, taken) : "");
  const [secret, setSecret] = useState("");
  const [runners, setRunners] = useState<Set<ProfileRunner>>(() => new Set(provider ? usable : []));
  const [model, setModel] = useState(provider ? (newestModels(provider, 1)[0]?.id ?? "") : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const local = provider?.group === "local";

  const pick = (id: string) => {
    setProviderId(id);
    const p = providers.find((x) => x.id === id);
    setAlias(suggestAlias(id, taken));
    setRunners(new Set(p ? PROFILE_RUNNERS.filter((r) => usableWith(runnerSupport(p, r))) : []));
    setModel(p ? (newestModels(p, 1)[0]?.id ?? "") : "");
    setError(null);
  };

  const toggle = (r: ProfileRunner) =>
    setRunners((s) => {
      const n = new Set(s);
      if (n.has(r)) n.delete(r);
      else n.add(r);
      return n;
    });

  const save = async () => {
    if (!provider) return;
    setBusy(true);
    setError(null);
    try {
      const cred = await call("providers.credentialAdd", { alias, providerId: provider.id, secret: local ? null : secret });
      // The key is in the daemon now; drop our copy right away.
      setSecret("");
      const failed: string[] = [];
      for (const runner of usable.filter((r) => runners.has(r))) {
        try {
          await call("providers.profileCreate", { alias: cred.alias, runner, providerId: provider.id, credentialId: cred.id, defaultModel: model || null });
        } catch (err) {
          failed.push(`${t(`runner.${runner}`)}: ${errorText(err)}`);
        }
      }
      await refresh();
      if (failed.length) setError(t("dialog.profilesFailed", { list: failed.join("; ") }));
      else onClose();
    } catch (err) {
      setError(t("dialog.failed", { message: errorText(err) }));
    } finally {
      setBusy(false);
    }
  };

  const ready = Boolean(provider) && alias.trim() !== "" && (local || secret.trim() !== "");
  return (
    <Modal
      title={t("dialog.addTitle")}
      onClose={onClose}
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t("dialog.cancel")}
          </Button>
          <Button size="sm" variant="primary" disabled={!ready || busy} onClick={() => void save()}>
            <KeyRound size={14} strokeWidth={1.75} />
            {busy ? t("dialog.saving") : local ? t("dialog.saveLocal") : t("dialog.save")}
          </Button>
        </>
      }
    >
      <form
        className="pv-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !busy) void save();
        }}
      >
        <Field label={t("dialog.provider")} htmlFor="pv-provider">
          <select id="pv-provider" className="pv-input" value={providerId} onChange={(e) => pick(e.target.value)} data-autofocus={initialId ? undefined : ""}>
            <option value="" disabled>
              {t("dialog.pickProvider")}
            </option>
            {sorted.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {t(`group.${p.group}`)}
              </option>
            ))}
          </select>
        </Field>
        {provider && (
          <>
            <Field label={t("dialog.alias")} hint={t("dialog.aliasHint")} htmlFor="pv-alias">
              <input id="pv-alias" className="pv-input mono" value={alias} onChange={(e) => setAlias(e.target.value)} maxLength={40} spellCheck={false} autoComplete="off" />
            </Field>
            {local ? (
              <p className="pv-hint">{t("dialog.local")}</p>
            ) : (
              <Field
                label={t("dialog.key")}
                htmlFor="pv-key"
                hint={
                  <>
                    {t("dialog.keyHint")}
                    {provider.env[0] ? ` ${t("dialog.envHint", { env: provider.env[0] })}` : ""}
                  </>
                }
              >
                <input id="pv-key" className="pv-input mono" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" spellCheck={false} data-autofocus={initialId ? "" : undefined} />
              </Field>
            )}
            <Field label={t("dialog.runners")} hint={t("dialog.runnersHint")}>
              <div className="pv-checks">
                {PROFILE_RUNNERS.map((r) => {
                  const support = runnerSupport(provider, r);
                  const ok = usableWith(support);
                  if (support === "none") return null;
                  return (
                    <label key={r} className={`pv-check${ok ? "" : " off"}`} title={t(`support.${support}`)}>
                      <input type="checkbox" checked={ok && runners.has(r)} disabled={!ok} onChange={() => toggle(r)} />
                      <span>{t(`runner.${r}`)}</span>
                      <span className="muted">{ok ? t(`supportShort.${support}`) : t("supportShort.conversion")}</span>
                    </label>
                  );
                })}
              </div>
            </Field>
            {provider.models.length > 0 && (
              <Field label={t("dialog.model")} htmlFor="pv-model">
                <ModelSelect id="pv-model" provider={provider} value={model} onChange={setModel} />
              </Field>
            )}
          </>
        )}
        {error && (
          <p className="pv-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}

function CredentialBlock({ credential, provider, balance, used }: { credential: CredentialSummary; provider: CatalogProvider; balance: BalanceView | undefined; used: boolean }) {
  const { t } = useTranslation("providers");
  const refresh = useRefresh();
  const money = useMoney();
  const when = useWhen();
  const [replacing, setReplacing] = useState(false);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const replace = () =>
    run("replace", async () => {
      await call("providers.credentialSetSecret", { id: credential.id, secret });
      setSecret("");
      setReplacing(false);
    });

  const remove = () => {
    if (!window.confirm(t("manage.removeConfirm", { alias: credential.alias }))) return;
    void run("remove", () => call("providers.credentialRemove", { id: credential.id }));
  };

  return (
    <div className="pv-item">
      <div className="pv-item-top">
        <KeyRound size={14} strokeWidth={1.75} className="muted" />
        <span className="mono">{credential.alias}</span>
        <span className={credential.isSet ? "st st-ok" : "st st-wait"}>{credential.kind === "local" ? t("manage.local") : credential.isSet ? t("manage.keySet") : t("manage.keyMissing")}</span>
        <div className="end">
          {provider.balance && credential.kind === "api_key" && (
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void run("balance", () => call("providers.balancesRefresh", { credentialId: credential.id }))}>
              <RefreshCw size={14} strokeWidth={1.75} />
              {busy === "balance" ? t("manage.checking") : t("manage.checkBalance")}
            </Button>
          )}
          {credential.kind === "api_key" && (
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setReplacing((v) => !v)}>
              {t("manage.replace")}
            </Button>
          )}
          <Button size="sm" variant="danger" disabled={busy !== null || used} title={used ? t("manage.inUse") : undefined} onClick={remove}>
            {t("manage.remove")}
          </Button>
        </div>
      </div>
      {provider.balance && credential.kind === "api_key" && (
        <div className="pv-item-line">
          {balance?.wallets.length ? (
            <>
              <span className="num mono">{balance.wallets.map((w) => money(w)).join(" · ")}</span>
              <ProvBadge value="reported" />
              {balance.fetchedAt && <span className="muted">{t("manage.checkedAt", { time: when.ago(balance.fetchedAt) })}</span>}
            </>
          ) : (
            <>
              <span className="muted">{t("manage.balanceNever")}</span>
              <ProvBadge value="unknown" />
            </>
          )}
          {balance?.error && <span className="pv-error-inline">{t("manage.balanceError", { message: balance.error })}</span>}
        </div>
      )}
      {replacing && (
        <form
          className="pv-inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (secret.trim()) void replace();
          }}
        >
          <input className="pv-input mono" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} aria-label={t("dialog.key")} autoComplete="off" spellCheck={false} autoFocus />
          <Button size="sm" type="submit" disabled={!secret.trim() || busy !== null}>
            {busy === "replace" ? t("dialog.saving") : t("manage.replaceSave")}
          </Button>
        </form>
      )}
      {error && <p className="pv-error">{error}</p>}
    </div>
  );
}

function ProfileLine({ profile, provider, credentials }: { profile: ProfileSummary; provider: CatalogProvider; credentials: CredentialSummary[] }) {
  const { t } = useTranslation("providers");
  const refresh = useRefresh();
  const [error, setError] = useState<string | null>(null);
  const cred = credentials.find((c) => c.id === profile.credentialId);
  const signIn = useSignIn();
  const status = signIn.status.find((s) => s.profileId === profile.id);
  const session = signIn.sessions.find((s) => s.profileId === profile.id);
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(errorText(err));
    }
  };
  const del = () => {
    if (!window.confirm(t("manage.deleteConfirm", { alias: profile.alias, path: profile.configDir }))) return;
    void act(() => call("providers.profileDelete", { id: profile.id }));
  };
  return (
    <div className="pv-item">
      <div className="pv-item-top">
        <span>{t(`runner.${profile.runner}`)}</span>
        <span className="mono">{profile.alias}</span>
        <span className="muted">{cred ? t("manage.usesKey", { alias: cred.alias }) : status ? t("manage.signsIn", { provider: t(`signIn.kind.${status.kind}`) }) : t("manage.ownSignIn")}</span>
        <div className="end">
          <Button size="sm" variant="danger" onClick={del}>
            <Trash2 size={14} strokeWidth={1.75} />
            {t("manage.delete")}
          </Button>
        </div>
      </div>
      <div className="pv-item-line">
        {provider.models.length > 0 && (
          <label className="pv-inline">
            <span className="lbl">{t("dialog.model")}</span>
            <ModelSelect provider={provider} value={profile.defaultModel ?? ""} onChange={(v) => void act(() => call("providers.profileUpdate", { id: profile.id, defaultModel: v || null }))} />
          </label>
        )}
        <span className="pv-path mono" title={profile.configDir}>
          {profile.configDir}
        </span>
      </div>
      {status && <SignInControl profile={profile} status={status} session={session} />}
      {error && <p className="pv-error">{error}</p>}
    </div>
  );
}

function AddProfile({ provider, credentials, profiles }: { provider: CatalogProvider; credentials: CredentialSummary[]; profiles: ProfileSummary[] }) {
  const { t } = useTranslation("providers");
  const refresh = useRefresh();
  const usable = PROFILE_RUNNERS.filter((r) => usableWith(runnerSupport(provider, r)));
  const local = provider.group === "local";
  const [runner, setRunner] = useState<ProfileRunner | "">(usable[0] ?? "");
  const support = runner ? runnerSupport(provider, runner) : "none";
  // Own sign-in only where we can start that runner's own login: Codex with ChatGPT, Gemini CLI with
  // Google (PLAN.md §6). Claude Code never; OpenCode plans stay on keys.
  const signInAllowed = runner !== "" && support === "native" && !local && signInKindFor(runner, provider.id) !== null;
  const [credentialId, setCredentialId] = useState(credentials[0]?.id ?? "");
  const [alias, setAlias] = useState("");
  const [model, setModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const taken = new Set(profiles.filter((p) => p.runner === runner).map((p) => p.alias.toLowerCase()));
  if (!usable.length) return null;

  const create = async () => {
    if (!runner) return;
    setError(null);
    try {
      await call("providers.profileCreate", { alias, runner, providerId: provider.id, credentialId: credentialId || null, defaultModel: model || null });
      setAlias("");
      await refresh();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <form
      className="pv-add-profile"
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <select className="pv-input" value={runner} onChange={(e) => setRunner(e.target.value as ProfileRunner)} aria-label={t("manage.runner")}>
        {usable.map((r) => (
          <option key={r} value={r}>
            {t(`runner.${r}`)}
          </option>
        ))}
      </select>
      <select className="pv-input" value={credentialId} onChange={(e) => setCredentialId(e.target.value)} aria-label={t("manage.credential")}>
        {credentials.map((c) => (
          <option key={c.id} value={c.id}>
            {c.alias}
          </option>
        ))}
        {signInAllowed && <option value="">{t("manage.ownSignInOption", { runner: t(`runner.${runner}`) })}</option>}
      </select>
      <input className="pv-input mono" value={alias} onChange={(e) => setAlias(e.target.value)} placeholder={t("manage.aliasPlaceholder")} aria-label={t("dialog.alias")} maxLength={40} spellCheck={false} />
      {provider.models.length > 0 && <ModelSelect provider={provider} value={model} onChange={setModel} />}
      <Button size="sm" type="submit" disabled={!alias.trim() || taken.has(alias.trim().toLowerCase()) || (!credentialId && !signInAllowed)}>
        {t("manage.addProfile")}
      </Button>
      {error && <p className="pv-error">{error}</p>}
    </form>
  );
}

export function ManageDialog({
  provider,
  credentials,
  profiles,
  balances,
  onAddKey,
  onClose,
}: {
  provider: CatalogProvider;
  credentials: CredentialSummary[];
  profiles: ProfileSummary[];
  balances: BalanceView[];
  onAddKey: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("providers");
  const mine = credentials.filter((c) => c.providerId === provider.id);
  const myProfiles = profiles.filter((p) => p.providerId === provider.id);
  return (
    <Modal title={t("manage.title", { provider: provider.name })} onClose={onClose} wide footer={<Button size="sm" onClick={onClose}>{t("dialog.close")}</Button>}>
      <section className="pv-section">
        <div className="pv-section-head">
          <span className="lbl">{t("manage.keys")}</span>
          <Button size="sm" variant="ghost" onClick={onAddKey}>
            {t("manage.addKey")}
          </Button>
        </div>
        {mine.length === 0 && <p className="muted pv-empty">{t("manage.noKeys")}</p>}
        {mine.map((c) => (
          <CredentialBlock key={c.id} credential={c} provider={provider} balance={balances.find((b) => b.credentialId === c.id)} used={profiles.some((p) => p.credentialId === c.id)} />
        ))}
      </section>
      <section className="pv-section">
        <div className="pv-section-head">
          <span className="lbl">{t("manage.profiles")}</span>
        </div>
        {myProfiles.length === 0 && <p className="muted pv-empty">{t("manage.noProfiles")}</p>}
        {myProfiles.map((p) => (
          <ProfileLine key={p.id} profile={p} provider={provider} credentials={credentials} />
        ))}
        <AddProfile provider={provider} credentials={mine} profiles={profiles} />
      </section>
    </Modal>
  );
}
