import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { AUTOPILOT_BOUNDS, type AutopilotLimits, type AutopilotLogEntry } from "@crewyard/core";
import { Button, Label, ProvenanceBadge } from "@crewyard/ui";
import { useNav } from "../../nav.ts";
import { act, useWork } from "./data.ts";

// DESIGN.md `Autopilot` (docs/adr/0017): the strip under the task assistant's header. Off by
// default; turning it on the first time shows what it may do and what stays with you, and your
// `Turn on` records the consent. Only this strip (your click) changes its limits. The log shows
// every call it made, allowed or refused, with the agent's reason as plain text.

/** Screenshot runs: `autopilot=consent` opens the consent card. */
const SHOT = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("autopilot") : null;

const LIMIT_KEYS: Array<keyof AutopilotLimits> = ["perTaskUsd", "perDayUsd", "tasksPerHour", "concurrent"];
const MAY = ["create", "edit", "approve", "message", "retry", "cancel", "complete"] as const;
const YOURS = ["push", "spend", "inbox", "delete", "signin", "limits"] as const;

function useAutopilotError(): (err: unknown) => string {
  const { t } = useTranslation("autopilot");
  return (err) => {
    const code = (err instanceof Error ? err.message : String(err)).replace(/^.*Error: /, "").trim();
    return t(`errors.${code.replace(/\./g, "_")}`, { defaultValue: t("errors.other", { message: code }) });
  };
}

export function AutopilotStrip({ projectId }: { projectId: string }) {
  const { t, i18n } = useTranslation("autopilot");
  const errorText = useAutopilotError();
  const qc = useQueryClient();
  const q = useWork("autopilot.get", { projectId }, { refetchOnMount: "always" });
  const [asking, setAsking] = useState(SHOT === "consent");
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = { title: useId(), text: useId(), log: useId() };

  useEffect(() => {
    return window.crewyard.on("autopilot.changed", (p) => {
      const id = (p as { projectId?: string | null }).projectId;
      if (id === projectId || id === null) void qc.invalidateQueries({ queryKey: ["autopilot.get", { projectId }] });
    });
  }, [projectId, qc]);

  const v = q.data;
  if (!v) return null;

  const save = async (patch: { enabled?: boolean; consent?: boolean; limits?: Partial<AutopilotLimits> }) => {
    setError(null);
    try {
      qc.setQueryData(["autopilot.get", { projectId }], await act("autopilot.set", { projectId, ...patch }));
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    }
  };

  const money = (usd: number) => new Intl.NumberFormat(i18n.language, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: usd < 1 ? 4 : 2 }).format(usd);
  const state = v.killed ? "killed" : v.halted ? "halted" : v.enabled ? "on" : "off";

  return (
    <section className="ap-strip" aria-label={t("label")} data-state={state}>
      <div className="ap-line">
        <Label>{t("title")}</Label>
        <span className={`ap-state ap-state-${state}`}>{t(`state.${state}`)}</span>
        {v.enabled && !v.killed && !v.halted && (
          <span className="ap-usage">
            <span className="num">{t("usage.today", { spent: money(v.usage.committedTodayUsd), cap: money(v.limits.perDayUsd) })}</span>
            <ProvenanceBadge provenance="estimated">{t("usage.estimated")}</ProvenanceBadge>
            <span className="muted num">{t("usage.started", { n: v.usage.startedLastHour, cap: v.limits.tasksPerHour })}</span>
            <span className="muted num">{t("usage.active", { n: v.usage.active, cap: v.limits.concurrent })}</span>
          </span>
        )}
        {!v.enabled && !asking && <span className="muted ap-lead">{t("lead")}</span>}
        <div className="end">
          {v.enabled ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => setEditing((x) => !x)} aria-expanded={editing}>
                {t("limits.edit")}
              </Button>
              {v.halted ? (
                <Button size="sm" onClick={() => void save({ enabled: true })}>
                  {t("halted.again")}
                </Button>
              ) : null}
              <Button size="sm" onClick={() => void save({ enabled: false })}>
                {t("off")}
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => (v.consentAt ? void save({ enabled: true }) : setAsking(true))} disabled={asking}>
              {v.consentAt ? t("on") : t("onFirst")}
            </Button>
          )}
        </div>
      </div>

      {v.killed && <p className="banner banner-warn ap-banner">{t("killed")}</p>}
      {v.halted && (
        <p className="banner banner-warn ap-banner">
          {t("halted.text")}
          {v.halted.detail && <span className="ap-quote mono">{v.halted.detail}</span>}
        </p>
      )}

      {asking && (
        <div className="banner ap-consent" role="alertdialog" aria-labelledby={ids.title} aria-describedby={ids.text}>
          <span className="lbl" id={ids.title}>
            {t("consent.title")}
          </span>
          <p id={ids.text}>{t("consent.lead")}</p>
          <div className="ap-lists">
            <div>
              <Label>{t("consent.may")}</Label>
              <ul>
                {MAY.map((k) => (
                  <li key={k}>{t(`consent.mayItems.${k}`)}</li>
                ))}
              </ul>
            </div>
            <div>
              <Label>{t("consent.yours")}</Label>
              <ul>
                {YOURS.map((k) => (
                  <li key={k}>{t(`consent.yoursItems.${k}`)}</li>
                ))}
              </ul>
            </div>
          </div>
          <LimitsForm
            limits={v.limits}
            submit={t("consent.accept")}
            cancel={t("consent.cancel")}
            onCancel={() => setAsking(false)}
            onSubmit={async (limits) => {
              if (await save({ enabled: true, consent: true, limits })) setAsking(false);
            }}
          />
        </div>
      )}

      {editing && v.enabled && (
        <LimitsForm
          limits={v.limits}
          submit={t("limits.save")}
          cancel={t("limits.cancel")}
          onCancel={() => setEditing(false)}
          onSubmit={async (limits) => {
            if (await save({ limits })) setEditing(false);
          }}
        />
      )}

      {error && (
        <p className="tk-error" role="alert">
          {error}
        </p>
      )}

      {v.log.length > 0 && (
        <details className="ap-log">
          <summary>
            <Label id={ids.log}>{t("log.title")}</Label>
            <span className="muted num">{v.log.length}</span>
          </summary>
          <ol aria-labelledby={ids.log}>
            {v.log.map((e) => (
              <LogLine key={e.seq} e={e} />
            ))}
          </ol>
        </details>
      )}
      {v.consentAt && <p className="muted tk-small ap-consented">{t("consent.recorded", { time: new Date(v.consentAt).toLocaleString(i18n.language, { dateStyle: "medium", timeStyle: "short" }) })}</p>}
    </section>
  );
}

function LimitsForm({ limits, submit, cancel, onSubmit, onCancel }: { limits: AutopilotLimits; submit: string; cancel: string; onSubmit(l: AutopilotLimits): void | Promise<void>; onCancel(): void }) {
  const { t } = useTranslation("autopilot");
  const [draft, setDraft] = useState<Record<keyof AutopilotLimits, string>>(() => Object.fromEntries(LIMIT_KEYS.map((k) => [k, String(limits[k])])) as Record<keyof AutopilotLimits, string>);
  const parsed: AutopilotLimits = { perTaskUsd: Number(draft.perTaskUsd), perDayUsd: Number(draft.perDayUsd), tasksPerHour: Number(draft.tasksPerHour), concurrent: Number(draft.concurrent) };
  const valid = LIMIT_KEYS.every((k) => Number.isFinite(parsed[k]) && parsed[k] >= AUTOPILOT_BOUNDS[k][0] && parsed[k] <= AUTOPILOT_BOUNDS[k][1]) && parsed.perDayUsd >= parsed.perTaskUsd;
  return (
    <form
      className="ap-limits"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) void onSubmit(parsed);
      }}
    >
      {LIMIT_KEYS.map((k) => (
        <label key={k} className="as-field">
          <span className="lbl">{t(`limits.${k}`)}</span>
          <input type="number" inputMode="decimal" min={AUTOPILOT_BOUNDS[k][0]} max={AUTOPILOT_BOUNDS[k][1]} step={k.endsWith("Usd") ? 0.01 : 1} value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
        </label>
      ))}
      <div className="ap-limits-acts">
        {!valid && <span className="tk-small ap-invalid">{t("limits.invalid")}</span>}
        <Button size="sm" variant="primary" type="submit" disabled={!valid}>
          {submit}
        </Button>
        <Button size="sm" variant="ghost" type="button" onClick={onCancel}>
          {cancel}
        </Button>
      </div>
    </form>
  );
}

function LogLine({ e }: { e: AutopilotLogEntry }) {
  const { t, i18n } = useTranslation("autopilot");
  const selectTask = useNav((s) => s.selectTask);
  const time = new Intl.DateTimeFormat(i18n.language, { hour: "2-digit", minute: "2-digit" }).format(new Date(e.at));
  return (
    <li className={`ap-entry ap-${e.outcome}`}>
      <span className="muted num">{time}</span>
      <span className="ap-what">
        <span>{t(`log.action.${e.action}`, { defaultValue: e.action })}</span>
        {e.outcome === "refused" && <span className="badge ap-refused-badge">{t("log.refused", { code: t(`refusal.${e.code ?? "failed"}`, { defaultValue: e.code ?? "" }) })}</span>}
        {e.taskId && e.taskTitle && (
          <button type="button" className="ap-link as-typed" onClick={() => selectTask(e.taskId!)}>
            {e.taskTitle}
          </button>
        )}
        {e.reason && (
          <span className="ap-quote" aria-label={t("log.reason")}>
            {e.reason}
          </span>
        )}
      </span>
    </li>
  );
}
