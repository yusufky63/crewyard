import { useEffect, useId, useState } from "react";
import { AlertTriangle, CalendarClock, ChevronDown, ChevronUp } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import type { FallbackMode, ScheduleRunView, ScheduleView, TaskKind, TaskSize } from "@crewyard/core";
import { Button, Label, Panel } from "@crewyard/ui";
import { act, useErrorText, useWork } from "./data.ts";
import { ConfirmButton, ErrorLine } from "./parts.tsx";
import { draftFrom, draftProblem, emptyDraft, slotText, toInput, weekdayNames, type ScheduleDraft } from "./schedules.ts";

// Scheduled tasks, as the second view of the Tasks screen (the sidebar keeps its six items,
// DESIGN.md §4). A template proposes a task on a daily or weekly slot. The timer lives in the
// daemon: nothing runs while Crewyard is closed, and the page says so.

const KINDS: Array<TaskKind | "auto"> = ["auto", "code", "research", "review", "docs"];
const SIZES: Array<TaskSize | "auto"> = ["auto", "S", "M", "L"];
const FALLBACKS: Array<FallbackMode | "default"> = ["default", "manual", "ask", "auto", "wait_for_reset"];
const BEST_OF = [0, 2, 3, 4];

function useScheduleLive(): void {
  const qc = useQueryClient();
  useEffect(
    () =>
      window.crewyard.on("schedules.changed", () => {
        void qc.invalidateQueries({ queryKey: ["schedules.list"] });
        void qc.invalidateQueries({ queryKey: ["schedules.runs"] });
      }),
    [qc],
  );
}

function Form({ projectId, initial, onDone }: { projectId: string; initial: ScheduleDraft; onDone: () => void }) {
  const { t, i18n } = useTranslation("schedules");
  const tt = useTranslation("tasks").t;
  const errorText = useErrorText();
  const [d, setD] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const set = <K extends keyof ScheduleDraft>(k: K, v: ScheduleDraft[K]) => setD((x) => ({ ...x, [k]: v }));
  const problem = draftProblem(d);
  const days = weekdayNames(i18n.language);

  const save = async () => {
    if (problem) return;
    setBusy(true);
    setError(null);
    try {
      await act("schedules.save", toInput(projectId, d));
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="tk-crew frame sc-form" aria-label={d.id ? t("form.editTitle") : t("form.newTitle")}>
      <div className="tk-crew-head">
        <Label>{d.id ? t("form.editTitle") : t("form.newTitle")}</Label>
      </div>
      <div className="sc-grid">
        <label className="sc-field sc-wide">
          <span className="lbl">{t("form.title")}</span>
          <input className="pv-input" value={d.title} onChange={(e) => set("title", e.target.value)} placeholder={t("form.titlePlaceholder")} />
        </label>
        <label className="sc-field sc-wide">
          <span className="lbl">{t("form.description")}</span>
          <textarea className="pv-input" rows={3} value={d.description} onChange={(e) => set("description", e.target.value)} placeholder={t("form.descriptionPlaceholder")} />
        </label>
        <div className="sc-field">
          <span className="lbl" id={`${id}-cad`}>
            {t("form.cadence")}
          </span>
          <div className="seg" role="group" aria-labelledby={`${id}-cad`}>
            {(["daily", "weekly"] as const).map((c) => (
              <button key={c} type="button" aria-pressed={d.cadence === c} onClick={() => set("cadence", c)}>
                {t(`cadence.${c}`)}
              </button>
            ))}
          </div>
        </div>
        {d.cadence === "weekly" && (
          <label className="sc-field">
            <span className="lbl">{t("form.weekday")}</span>
            <select className="pv-input" value={d.weekday} onChange={(e) => set("weekday", Number(e.target.value))}>
              {days.map((name, i) => (
                <option key={i} value={i}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="sc-field">
          <span className="lbl">{t("form.time")}</span>
          <input className="pv-input mono" type="time" value={d.time} onChange={(e) => set("time", e.target.value)} aria-invalid={problem === "time" || undefined} />
        </label>
        <label className="sc-field">
          <span className="lbl">{t("form.timeZone")}</span>
          <input className="pv-input mono" value={d.timeZone} onChange={(e) => set("timeZone", e.target.value)} spellCheck={false} aria-invalid={problem === "timeZone" || undefined} />
        </label>
        <label className="sc-field">
          <span className="lbl">{tt("composer.kind")}</span>
          <select className="pv-input" value={d.kind} onChange={(e) => set("kind", e.target.value as TaskKind | "auto")}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {tt(`kind.${k}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="sc-field">
          <span className="lbl">{t("form.size")}</span>
          <select className="pv-input" value={d.size} onChange={(e) => set("size", e.target.value as TaskSize | "auto")}>
            {SIZES.map((s) => (
              <option key={s} value={s}>
                {s === "auto" ? tt("kind.auto") : s}
              </option>
            ))}
          </select>
        </label>
        <label className="sc-field">
          <span className="lbl">{tt("composer.onLimit")}</span>
          <select className="pv-input" value={d.fallback} onChange={(e) => set("fallback", e.target.value as FallbackMode | "default")}>
            {FALLBACKS.map((f) => (
              <option key={f} value={f}>
                {tt(`fallback.${f}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="sc-field">
          <span className="lbl">{tt("composer.budget")}</span>
          <input className="pv-input mono" inputMode="decimal" value={d.budget} onChange={(e) => set("budget", e.target.value)} placeholder={tt("composer.budgetNone")} aria-invalid={problem === "budgetUsd" || undefined} />
        </label>
        <label className="sc-field">
          <span className="lbl">{tt("composer.bestOf")}</span>
          <select className="pv-input" value={d.bestOf} onChange={(e) => set("bestOf", Number(e.target.value))}>
            {BEST_OF.map((n) => (
              <option key={n} value={n}>
                {n === 0 ? tt("composer.bestOfOff") : tt("composer.bestOfN", { count: n })}
              </option>
            ))}
          </select>
        </label>
        <label className="sc-field sc-wide">
          <span className="lbl">{t("form.precheck")}</span>
          <input className="pv-input mono" value={d.precheck} onChange={(e) => set("precheck", e.target.value)} placeholder={t("form.precheckPlaceholder")} spellCheck={false} aria-invalid={problem === "precheck" || undefined} />
          <span className="muted sc-hint">{t("form.precheckHint")}</span>
        </label>
        <label className="sc-field">
          <span className="lbl">{t("form.precheckTimeout")}</span>
          <input className="pv-input mono" inputMode="numeric" value={d.precheckTimeoutSec} onChange={(e) => set("precheckTimeoutSec", e.target.value)} aria-invalid={problem === "precheckTimeoutSec" || undefined} />
        </label>
        <label className="sc-check sc-wide">
          <input type="checkbox" checked={d.autoApprove} onChange={(e) => set("autoApprove", e.target.checked)} />
          <span>{t("form.autoApprove")}</span>
        </label>
        {d.autoApprove && (
          <div className="banner banner-warn frame sc-wide" role="note">
            <AlertTriangle size={14} strokeWidth={1.75} aria-hidden="true" />
            <span className="txt">{t("form.autoApproveWarning")}</span>
          </div>
        )}
      </div>
      <div className="tk-crew-actions">
        <p className="tk-est">{problem ? <span className="st-wait">{t(`invalid.${problem}`)}</span> : d.id ? t("form.editNote") : t("form.newNote")}</p>
        <div className="end">
          <Button variant="ghost" onClick={onDone}>
            {t("form.cancel")}
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={Boolean(problem) || busy}>
            {busy ? t("form.saving") : t("form.save")}
          </Button>
        </div>
      </div>
      <ErrorLine>{error}</ErrorLine>
    </section>
  );
}

function RunLine({ r, timeZone, onOpenTask }: { r: ScheduleRunView; timeZone: string; onOpenTask: (taskId: string) => void }) {
  const { t, i18n } = useTranslation("schedules");
  const tone = r.outcome === "failed" ? "st-bad" : r.outcome === "skipped_precheck" || r.outcome === "skipped_missed" ? "muted" : r.outcome === "running_precheck" ? "st-run" : "st-ok";
  return (
    <li className="sc-run">
      <span className="mono sc-small">{r.slotAt ? slotText(r.slotAt, timeZone, i18n.language) : t("run.manual")}</span>
      <span className={`st ${tone}`}>{t(`outcome.${r.outcome}`, { count: r.count })}</span>
      <span className="muted sc-small">
        {r.outcome === "skipped_precheck" && (r.detail ? t(`detail.${r.detail.replace(/\./g, "_")}`, { defaultValue: r.detail }) : t("run.exit", { code: r.precheckExit ?? "-" }))}
        {r.outcome !== "skipped_precheck" && r.detail ? t(`detail.${r.detail.replace(/\./g, "_")}`, { defaultValue: r.detail }) : ""}
      </span>
      {r.taskId && (
        <Button size="sm" variant="ghost" onClick={() => onOpenTask(r.taskId!)}>
          {t("run.openTask")}
        </Button>
      )}
    </li>
  );
}

function ScheduleRow({ s, onEdit, onOpenTask }: { s: ScheduleView; onEdit: () => void; onOpenTask: (taskId: string) => void }) {
  const { t, i18n } = useTranslation("schedules");
  const errorText = useErrorText();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runs = useWork("schedules.runs", { id: s.id, limit: 10 }, { enabled: open });
  const day = s.cadence === "weekly" && s.weekday !== null ? weekdayNames(i18n.language)[s.weekday] : null;
  const when = day ? t("when.weekly", { day, time: s.time, zone: s.timeZone }) : t("when.daily", { time: s.time, zone: s.timeZone });
  const run$ = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <div className="tk-row">
      <div className="tk-top">
        <div className="tk-top-main">
          <div className="tk-title">{s.title}</div>
          <div className="tk-meta">
            <span>
              <CalendarClock size={13} strokeWidth={1.75} aria-hidden="true" />
              <span className="as-typed">{when}</span>
            </span>
            {s.precheck && <span className="mono as-typed">{t("row.precheck", { command: s.precheck })}</span>}
            {s.autoApprove && (
              <span className="st-wait">
                <AlertTriangle size={13} strokeWidth={1.75} aria-hidden="true" />
                {t("row.autoApprove")}
              </span>
            )}
          </div>
        </div>
        <button type="button" className="tk-expand" aria-expanded={open} aria-label={open ? t("row.collapse") : t("row.expand")} onClick={() => setOpen((v) => !v)}>
          {open ? <ChevronUp size={16} strokeWidth={1.75} /> : <ChevronDown size={16} strokeWidth={1.75} />}
        </button>
      </div>
      <div className="tk-status">
        <span className={`st ${s.enabled ? "st-run" : "muted"}`}>{s.enabled ? t("row.enabled") : t("row.disabled")}</span>
        {s.nextAt && <span className="muted tk-small">{t("row.next", { when: slotText(s.nextAt, s.timeZone, i18n.language) })}</span>}
        {s.pending > 0 && <span className="st-wait tk-small">{t("row.pending", { count: s.pending })}</span>}
        {s.lastRun && <span className="muted tk-small">{t("row.last", { outcome: t(`outcome.${s.lastRun.outcome}`, { count: s.lastRun.count }) })}</span>}
        <div className="end">
          <div className="seg" role="group" aria-label={t("row.switch", { title: s.title })}>
            <button type="button" aria-pressed={s.enabled} onClick={() => !s.enabled && void run$(() => act("schedules.setEnabled", { id: s.id, enabled: true }))}>
              {t("row.on")}
            </button>
            <button type="button" aria-pressed={!s.enabled} onClick={() => s.enabled && void run$(() => act("schedules.setEnabled", { id: s.id, enabled: false }))}>
              {t("row.off")}
            </button>
          </div>
          <Button size="sm" onClick={() => void run$(() => act("schedules.runNow", { id: s.id }))} title={t("row.runNowHint")}>
            {t("row.runNow")}
          </Button>
          <Button size="sm" variant="ghost" onClick={onEdit}>
            {t("row.edit")}
          </Button>
          <ConfirmButton label={t("row.delete")} confirm={t("row.deleteConfirm")} confirmLabel={t("row.deleteYes")} onConfirm={() => run$(() => act("schedules.delete", { id: s.id }))} />
        </div>
      </div>
      <ErrorLine>{error}</ErrorLine>
      {open && (
        <ol className="sc-runs">
          {runs.data?.length === 0 && <li className="muted sc-small">{t("run.none")}</li>}
          {runs.data?.map((r) => (
            <RunLine key={r.id} r={r} timeZone={s.timeZone} onOpenTask={onOpenTask} />
          ))}
        </ol>
      )}
    </div>
  );
}

export function Schedules({ projectId, onOpenTask }: { projectId: string; onOpenTask: (taskId: string) => void }) {
  const { t } = useTranslation("schedules");
  useScheduleLive();
  const list = useWork("schedules.list", { projectId });
  const [editing, setEditing] = useState<ScheduleDraft | null>(null);
  const all = list.data ?? [];
  return (
    <>
      <div className="banner frame sc-only-open" role="note">
        <CalendarClock size={14} strokeWidth={1.75} aria-hidden="true" />
        <span>{t("onlyOpen")}</span>
      </div>
      {editing ? (
        <Form key={editing.id ?? "new"} projectId={projectId} initial={editing} onDone={() => setEditing(null)} />
      ) : (
        <div className="sc-head">
          <Button onClick={() => setEditing(emptyDraft())}>{t("new")}</Button>
        </div>
      )}
      <Panel className="tk-list sc-list">
        {list.isError && <p className="tk-empty muted">{t("errors.load")}</p>}
        {list.isSuccess && all.length === 0 && <p className="tk-empty muted">{t("empty")}</p>}
        {all.map((s) => (
          <ScheduleRow key={s.id} s={s} onEdit={() => setEditing(draftFrom(s))} onOpenTask={onOpenTask} />
        ))}
      </Panel>
    </>
  );
}
