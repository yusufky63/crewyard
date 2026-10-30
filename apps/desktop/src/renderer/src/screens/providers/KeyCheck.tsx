import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Activity, KeyRound, Wand2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@crewyard/ui";
import {
  EFFORT_LEVELS,
  effortSupport,
  PROFILE_NOTE_MAX,
  suggestSlots,
  type CatalogProvider,
  type EffortLevel,
  type KeyCheckView,
  type ModelSlots,
  type ProfilePresets,
  type ProfileSummary,
} from "@crewyard/core";
import { call } from "../../ipc.ts";
import { useProvidersQuery as useDaemon } from "./data.ts";
import { useWhen } from "./shared.tsx";

// Key check, model discovery and the latency check (feature scan A6), and a profile's presets with
// its "when to use" note (A16). The note goes to the crew proposal only, never to an agent.

const errorText = (err: unknown) => (err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err));

export function useKeyChecks(): KeyCheckView[] {
  return useDaemon("providers.keyChecks", undefined).data ?? [];
}

const STATE_CLASS: Record<KeyCheckView["state"], string> = { valid: "st st-ok", invalid: "st st-bad", unknown: "st st-wait", unchecked: "st muted" };

/** Short state for the providers table: only a rejected key earns space there. */
export function KeyStateNote({ check }: { check: KeyCheckView | undefined }) {
  const { t } = useTranslation("providers");
  if (check?.state !== "invalid") return null;
  return <span className="st st-bad">{t("keyCheck.state.invalid")}</span>;
}

/** The key's state, what the provider listed, and reachability, with a button for each check. */
export function KeyCheckLine({ credentialId, check, local }: { credentialId: string; check: KeyCheckView | undefined; local: boolean }) {
  const { t } = useTranslation("providers");
  const when = useWhen();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<"key" | "speed" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (what: "key" | "speed") => {
    setBusy(what);
    setError(null);
    try {
      await call(what === "key" ? "providers.keyCheck" : "providers.latencyCheck", { credentialId });
      await qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("providers.") });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };
  const state = check?.state ?? "unchecked";
  const lat = check?.latency ?? null;
  return (
    <div className="pv-kc">
      <div className="pv-item-line">
        {!local && <span className={STATE_CLASS[state]}>{t(`keyCheck.state.${state}`)}</span>}
        {check?.reason && <span className="muted">{t(`keyCheck.reason.${check.reason}`, { status: check.status ?? "" })}</span>}
        {state === "invalid" && check?.status && <span className="muted">{t("keyCheck.http", { status: check.status })}</span>}
        {check?.checkedAt && <span className="muted">{t("manage.checkedAt", { time: when.ago(check.checkedAt) })}</span>}
        <div className="end">
          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void run("key")}>
            <KeyRound size={14} strokeWidth={1.75} />
            {busy === "key" ? t("manage.checking") : local ? t("keyCheck.listModels") : t("keyCheck.check")}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void run("speed")}>
            <Activity size={14} strokeWidth={1.75} />
            {busy === "speed" ? t("manage.checking") : t("keyCheck.speed")}
          </Button>
        </div>
      </div>
      {check && check.models.length > 0 && (
        <details className="pv-models">
          <summary>
            {t("keyCheck.listed", { count: check.models.length })}
            {check.extraModels.length > 0 && ` · ${t("keyCheck.extra", { count: check.extraModels.length })}`}
          </summary>
          <div className="pv-model-list mono">
            {check.models.map((m) => (
              <span key={m} className={check.extraModels.includes(m) ? "extra" : undefined} title={check.extraModels.includes(m) ? t("keyCheck.extraTitle") : undefined}>
                {m}
              </span>
            ))}
          </div>
        </details>
      )}
      {lat && (
        <div className="pv-item-line">
          <span className={lat.class === "ok" ? "st st-ok" : lat.class === "slow" ? "st st-wait" : "st st-bad"}>{t(`keyCheck.latency.${lat.class}`)}</span>
          {lat.ms !== null && <span className="num mono">{t("keyCheck.ms", { ms: lat.ms })}</span>}
          <span className="muted">{t("manage.checkedAt", { time: when.ago(lat.checkedAt) })}</span>
          <span className="muted">{t("keyCheck.latencyNote")}</span>
        </div>
      )}
      {error && <p className="pv-error">{error}</p>}
    </div>
  );
}

/** Catalog models newest first, then the ones only the provider's list has. */
export function ModelOptions({ provider, extra }: { provider: CatalogProvider; extra: string[] }) {
  const { t } = useTranslation("providers");
  const models = [...provider.models].sort((a, b) => (b.released ?? "").localeCompare(a.released ?? ""));
  const known = new Set(models.map((m) => m.id));
  const more = extra.filter((m) => !known.has(m));
  return (
    <>
      {models.map((m) => (
        <option key={m.id} value={m.id}>
          {m.id}
        </option>
      ))}
      {more.length > 0 && (
        <optgroup label={t("keyCheck.extraGroup")}>
          {more.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </optgroup>
      )}
    </>
  );
}

const SLOTS: Array<keyof ModelSlots> = ["haiku", "sonnet", "opus"];

/** Note, effort, read-only and Claude Code's model slots for one profile; each change saves at once. */
export function PresetsEditor({ profile, provider, listed }: { profile: ProfileSummary; provider: CatalogProvider; listed: string[] }) {
  const { t } = useTranslation("providers");
  const qc = useQueryClient();
  const [note, setNote] = useState(profile.note ?? "");
  const [error, setError] = useState<string | null>(null);
  const save = async (patch: Partial<ProfilePresets>) => {
    setError(null);
    try {
      await call("providers.profileUpdate", { id: profile.id, ...patch });
      await qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("providers.") });
    } catch (err) {
      setError(errorText(err));
    }
  };
  const commitNote = () => {
    const next = note.replace(/\s+/g, " ").trim();
    if (next !== (profile.note ?? "")) void save({ note: next || null });
  };
  const effort = effortSupport(profile.runner, profile.providerId);
  const slotsApply = profile.runner === "claude-code" && provider.id !== "anthropic" && provider.anthropicBase !== null;
  const slotChoices = [...new Set([...provider.models.map((m) => m.id), ...listed])].sort();
  const slots = profile.modelSlots ?? { haiku: null, sonnet: null, opus: null };
  const fill = () => void save({ modelSlots: suggestSlots(slotChoices, profile.defaultModel) });
  return (
    <div className="pv-presets">
      <label className="pv-inline pv-note">
        <span className="lbl">{t("presets.note")}</span>
        <input
          className="pv-input"
          value={note}
          maxLength={PROFILE_NOTE_MAX}
          placeholder={t("presets.notePlaceholder")}
          onChange={(e) => setNote(e.target.value)}
          onBlur={commitNote}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitNote();
          }}
        />
      </label>
      <div className="pv-item-line">
        {effort && (
          <label className="pv-inline">
            <span className="lbl">{t("presets.effort")}</span>
            <select className="pv-input" value={profile.effort ?? ""} onChange={(e) => void save({ effort: (e.target.value || null) as EffortLevel | null })}>
              <option value="">{t("presets.effortDefault")}</option>
              {EFFORT_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {t(`presets.effortLevel.${l}`)}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="pv-inline pv-ro" title={t("presets.readOnlyHint")}>
          <input type="checkbox" checked={profile.readOnly} onChange={(e) => void save({ readOnly: e.target.checked })} />
          <span>{t("presets.readOnly")}</span>
        </label>
      </div>
      {slotsApply && (
        <div className="pv-slots">
          <span className="lbl">{t("presets.slots")}</span>
          {SLOTS.map((s) => (
            <label key={s} className="pv-inline">
              <span className="muted mono">{s}</span>
              <select className="pv-input" value={slots[s] ?? ""} onChange={(e) => void save({ modelSlots: { ...slots, [s]: e.target.value || null } })}>
                <option value="">{t("presets.slotDefault")}</option>
                {slotChoices.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <Button size="sm" variant="ghost" disabled={slotChoices.length === 0} onClick={fill} title={t("presets.fillHint")}>
            <Wand2 size={14} strokeWidth={1.75} />
            {t("presets.fill")}
          </Button>
        </div>
      )}
      {error && <p className="pv-error">{error}</p>}
    </div>
  );
}
