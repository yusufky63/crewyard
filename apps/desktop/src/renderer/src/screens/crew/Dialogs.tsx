import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CandidateView } from "@crewyard/core";
import { BrandIcon, Button } from "@crewyard/ui";
import { matches } from "../../keys.ts";

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
  onConfirm,
  onClose,
}: {
  target: string;
  candidates: CandidateView[];
  runnerLabel: (runner: CandidateView["runner"]) => string;
  onConfirm: (profileId: string) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation("crew");
  const [pick, setPick] = useState(candidates[0]?.profileId ?? "");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      title={t("changeAi.title", { target })}
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
              void onConfirm(pick).finally(() => setBusy(false));
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
      <p className="muted">{t("changeAi.body")}</p>
    </Dialog>
  );
}
