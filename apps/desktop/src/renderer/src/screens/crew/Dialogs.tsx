import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CandidateView, HandoffStop } from "@crewyard/core";
import { BrandIcon, Button } from "@crewyard/ui";
import { matches } from "../../keys.ts";
import { HandoffStopChoice } from "../tasks/parts.tsx";

/** Native modal <dialog>: focus stays inside, Esc cancels, focus returns to the opener. */
function Dialog({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer: ReactNode }) {
  const { t } = useTranslation("crew");
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (d && !d.open) d.showModal();
    d?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => {
      d?.close();
      opener?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="crew-dialog panel"
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="crew-dialog-head">
        <h2>{title}</h2>
        <button type="button" className="crew-x" onClick={onClose} aria-label={t("dialog.close")}>
          <X size={16} strokeWidth={1.75} />
        </button>
      </div>
      <div className="crew-dialog-body">{children}</div>
      <div className="crew-dialog-foot">{footer}</div>
    </dialog>
  );
}

/** Stop always confirms and names what it stops (DESIGN.md §7). */
export function StopDialog({ target, onConfirm, onClose }: { target: string; onConfirm: () => Promise<void>; onClose: () => void }) {
  const { t } = useTranslation("crew");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      title={t("stop.title")}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} data-autofocus>
            {t("dialog.cancel")}
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void onConfirm().finally(() => setBusy(false));
            }}
          >
            {t("stop.confirm")}
          </Button>
        </>
      }
    >
      <p>{t("stop.body", { target })}</p>
      <p className="muted">{t("stop.keeps")}</p>
    </Dialog>
  );
}

/** A note for the agent; it waits in the step's outbox while the step has no live process. */
export function MessageDialog({ target, live, onSend, onClose }: { target: string; live: boolean; onSend: (text: string) => Promise<void>; onClose: () => void }) {
  const { t } = useTranslation("crew");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const send = () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    void onSend(text.trim()).finally(() => setBusy(false));
  };
  return (
    <Dialog
      title={t("message.title", { target })}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("dialog.cancel")}
          </Button>
          <Button variant="primary" disabled={!text.trim() || busy} onClick={send}>
            {t("message.send")}
          </Button>
        </>
      }
    >
      <label className="lbl" htmlFor="crew-message">
        {t("message.label")}
      </label>
      <textarea
        id="crew-message"
        className="crew-textarea"
        rows={5}
        value={text}
        data-autofocus
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (matches(e, "submit")) {
            e.preventDefault();
            send();
          }
        }}
      />
      <p className="muted">{live ? t("message.live") : t("message.queued")}</p>
    </Dialog>
  );
}

/** "Change AI": pick another of the step's candidates; the daemon runs the same durable handoff as a limit. */
export function ChangeAiDialog({
  target,
  candidates,
  runnerLabel,
  live,
  onConfirm,
  onClose,
  title,
  body,
}: {
  target: string;
  /** Hand off now (a limit question) reuses this dialog with its own title and note. */
  title?: string;
  body?: string;
  candidates: CandidateView[];
  runnerLabel: (runner: CandidateView["runner"]) => string;
  /** A turn is under way, so the user may let it finish before the switch. */
  live: boolean;
  onConfirm: (profileId: string, stop: HandoffStop | undefined) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation("crew");
  const [pick, setPick] = useState(candidates[0]?.profileId ?? "");
  const [stop, setStop] = useState<HandoffStop>("interrupt");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      title={title ?? t("changeAi.title", { target })}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("dialog.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={!pick || busy}
            onClick={() => {
              setBusy(true);
              void onConfirm(pick, live ? stop : undefined).finally(() => setBusy(false));
            }}
          >
            {t("changeAi.confirm")}
          </Button>
        </>
      }
    >
      <fieldset className="crew-pick">
        <legend className="lbl">{t("changeAi.label")}</legend>
        {candidates.map((c, i) => (
          <label key={c.profileId} className="crew-pick-row">
            <input type="radio" name="crew-change-ai" value={c.profileId} checked={pick === c.profileId} onChange={() => setPick(c.profileId)} data-autofocus={i === 0 ? true : undefined} />
            <BrandIcon id={c.runner} />
            <span>{`${runnerLabel(c.runner)} · ${c.alias}`}</span>
            <span className="mono muted">{c.model ?? t("node.defaultModel")}</span>
          </label>
        ))}
      </fieldset>
      {live && <HandoffStopChoice name="crew-change-stop" value={stop} onChange={setStop} />}
      <p className="muted">{body ?? t("changeAi.body")}</p>
    </Dialog>
  );
}

export interface StepOption {
  step: string;
  label: string;
}

/**
 * Add a step: a role from the project's role set (custom roles included) and the step it starts
 * after. A follow-up of a running crew has its step fixed and waits for its own approval.
 */
export function AddStepDialog({
  title,
  roles,
  steps,
  after,
  fixedAfter,
  requireAfter = false,
  note,
  onConfirm,
  onClose,
}: {
  title: string;
  roles: Array<{ id: string; label: string }>;
  steps: StepOption[];
  after: string | null;
  fixedAfter: boolean;
  /** A follow-up from the task node: it must go after one of `steps`, but you pick which. */
  requireAfter?: boolean;
  note: string;
  onConfirm: (role: string, after: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation("crew");
  const [role, setRole] = useState(roles[0]?.id ?? "");
  const [dep, setDep] = useState(after ?? (requireAfter ? (steps[0]?.step ?? "") : ""));
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("dialog.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={!role || busy}
            onClick={() => {
              setBusy(true);
              void onConfirm(role, dep ? [dep] : []).finally(() => setBusy(false));
            }}
          >
            {t("addStep.confirm")}
          </Button>
        </>
      }
    >
      <label className="crew-field">
        <span className="lbl">{t("addStep.role")}</span>
        <select value={role} onChange={(e) => setRole(e.target.value)} data-autofocus>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
      </label>
      <label className="crew-field">
        <span className="lbl">{t("addStep.after")}</span>
        <select value={dep} onChange={(e) => setDep(e.target.value)} disabled={fixedAfter}>
          {!fixedAfter && !requireAfter && <option value="">{t("addStep.afterNone")}</option>}
          {steps.map((s) => (
            <option key={s.step} value={s.step}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <p className="muted">{note}</p>
    </Dialog>
  );
}

/** Skip confirms and names what waits for the step, so nobody is surprised by what starts without it. */
export function SkipDialog({ target, dependents, onConfirm, onClose }: { target: string; dependents: string[]; onConfirm: () => Promise<void>; onClose: () => void }) {
  const { t } = useTranslation("crew");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      title={t("skip.title", { target })}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} data-autofocus>
            {t("dialog.cancel")}
          </Button>
          {/* Skipping holds a step back for good, so its confirm is warn rather than the neutral primary. */}
          <Button
            tone="warn"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void onConfirm().finally(() => setBusy(false));
            }}
          >
            {t("skip.confirm")}
          </Button>
        </>
      }
    >
      <p>{t("skip.body", { target })}</p>
      <p className={dependents.length > 0 ? "crew-why" : "muted"}>{dependents.length > 0 ? t("skip.dependents", { steps: dependents.join(", "), count: dependents.length }) : t("skip.noDependents")}</p>
    </Dialog>
  );
}

export interface PickRow {
  candidate: CandidateView;
  /** A second line under the name, e.g. how many steps the profile fits. */
  note?: string | null;
  /** Why it cannot be picked; the row stays listed, disabled, with this text. */
  why?: string | null;
}

/**
 * Pick one profile from a scored list, for the Change AI paths that start nothing: a step before
 * its run, every step of a proposal, or a follow-up that runs a finished step again. The rows
 * come from crew.candidates, so the dialog can open before they arrive.
 */
export function PickProfileDialog({
  title,
  label,
  body,
  confirm,
  state,
  rows,
  runnerLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  label: string;
  body: string;
  confirm: string;
  state: "loading" | "error" | "ready";
  rows: PickRow[];
  runnerLabel: (runner: CandidateView["runner"]) => string;
  onConfirm: (profileId: string) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation("crew");
  const first = rows.find((r) => !r.why)?.candidate.profileId ?? "";
  const [chosen, setChosen] = useState("");
  const [busy, setBusy] = useState(false);
  // The rows may arrive after the dialog opens; until you pick, the first open one is selected.
  const pick = chosen || first;
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("dialog.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={!pick || busy || state !== "ready"}
            onClick={() => {
              setBusy(true);
              void onConfirm(pick).finally(() => setBusy(false));
            }}
          >
            {confirm}
          </Button>
        </>
      }
    >
      <fieldset className="crew-pick" aria-busy={state === "loading"}>
        <legend className="lbl">{label}</legend>
        {state === "loading" && <p className="muted">{t("panel.loading")}</p>}
        {state === "error" && <p className="crew-notice bad">{t("pick.error")}</p>}
        {state === "ready" && rows.length === 0 && <p className="muted">{t("pick.none")}</p>}
        {rows.map((r) => {
          const c = r.candidate;
          const id = `pick-why-${c.profileId}`;
          return (
            <label key={c.profileId} className={r.why ? "crew-pick-row off" : "crew-pick-row"}>
              <input
                type="radio"
                name="crew-pick-profile"
                value={c.profileId}
                checked={pick === c.profileId}
                disabled={!!r.why}
                aria-describedby={r.why ? id : undefined}
                onChange={() => setChosen(c.profileId)}
                data-autofocus={c.profileId === first ? true : undefined}
              />
              <BrandIcon id={c.runner} />
              <span className="crew-cand-name">
                <span>{`${runnerLabel(c.runner)} · ${c.alias}`}</span>
                {r.why ? (
                  <span id={id} className="crew-why">
                    {r.why}
                  </span>
                ) : (
                  r.note && <span className="mono muted">{r.note}</span>
                )}
              </span>
              <span className="mono muted">{c.model ?? t("node.defaultModel")}</span>
            </label>
          );
        })}
      </fieldset>
      <p className="muted">{body}</p>
    </Dialog>
  );
}

/** Cancel task confirms and says what it stops, as the task row does; the worktree stays. */
export function CancelTaskDialog({ title, running, onConfirm, onClose }: { title: string; running: number; onConfirm: () => Promise<void>; onClose: () => void }) {
  const { t } = useTranslation("crew");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      title={t("cancelTask.title", { title })}
      onClose={onClose}
      footer={
        <>
          {/* "Cancel" beside "Cancel task" would read as the same thing; this one keeps the task. */}
          <Button variant="ghost" onClick={onClose} data-autofocus>
            {t("cancelTask.keep")}
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void onConfirm().finally(() => setBusy(false));
            }}
          >
            {t("cancelTask.confirm")}
          </Button>
        </>
      }
    >
      <p>{running > 0 ? t("cancelTask.body", { count: running }) : t("cancelTask.bodyIdle")}</p>
      <p className="muted">{t("cancelTask.keeps")}</p>
    </Dialog>
  );
}
