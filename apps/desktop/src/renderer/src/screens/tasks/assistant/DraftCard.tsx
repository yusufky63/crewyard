import { useId, useState } from "react";
import { ArrowRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AssistantDraftView, TaskKind, TaskSize } from "@crewyard/core";
import { Button } from "@crewyard/ui";
import { act } from "../data.ts";
import { openTask, showTask } from "./openTask.ts";
import { useAssistantError } from "./errors.ts";

const KINDS: TaskKind[] = ["code", "research", "review", "docs"];
const SIZES: Array<TaskSize | ""> = ["", "S", "M", "L"];

/** One editable draft: the assistant's, a preset's, or a finished task's suggestion. `onChanged` re-reads its list. */
export function DraftCard({ draft, index, onChanged }: { draft: AssistantDraftView; index: number; onChanged?: () => void }) {
  const { t } = useTranslation("assistant");
  const tk = useTranslation("tasks").t;
  const errorText = useAssistantError();
  const [title, setTitle] = useState(draft.title);
  const [description, setDescription] = useState(draft.description);
  const [kind, setKind] = useState<TaskKind>(draft.kind);
  const [size, setSize] = useState<TaskSize | "">(draft.size ?? "");
  const [criteria, setCriteria] = useState(draft.acceptance.join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const n = String(index).padStart(2, "0");

  if (draft.status === "added")
    return (
      <article className="spec as-draft as-draft-added" aria-labelledby={`${id}-t`}>
        <div className="as-draft-top">
          <span className="lbl num">{n}</span>
          <span className="badge badge-ok">{t("drafts.addedBadge")}</span>
          <span className="badge">{tk(`kind.${draft.kind}`)}</span>
          {draft.size && <span className="badge">{draft.size}</span>}
        </div>
        <p className="as-draft-title as-typed" id={`${id}-t`}>
          {draft.title}
        </p>
        <p className="muted tk-small">{t("drafts.added")}</p>
        {draft.taskId && (
          <Button size="sm" className="as-open-task" onClick={() => openTask(draft.taskId!)}>
            {t("drafts.open")}
            <ArrowRight aria-hidden="true" />
          </Button>
        )}
      </article>
    );

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await act("assistant.addDraft", {
        draftId: draft.id,
        edit: { title: title.trim(), description: description.trim(), kind, size: size || null, acceptance: criteria.split("\n").map((c) => c.trim()).filter(Boolean) },
      });
      // The task opens on Tasks with its crew proposal, which still waits for your approval.
      showTask(res.taskId);
      onChanged?.();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    setError(null);
    try {
      await act("assistant.discardDraft", { draftId: draft.id });
      onChanged?.();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <article className="spec as-draft" aria-label={t("drafts.cardLabel", { n: index, title: draft.title })}>
      <div className="as-draft-top">
        <span className="lbl num">{n}</span>
        <span className="badge">{t(`drafts.from.${draft.source}`)}</span>
      </div>
      <label className="as-field">
        <span className="lbl">{t("drafts.fieldTitle")}</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <div className="as-draft-row">
        <label className="as-field">
          <span className="lbl">{t("drafts.fieldKind")}</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as TaskKind)}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {tk(`kind.${k}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="as-field">
          <span className="lbl">{t("drafts.fieldSize")}</span>
          <select value={size} onChange={(e) => setSize(e.target.value as TaskSize | "")}>
            {SIZES.map((s) => (
              <option key={s || "none"} value={s}>
                {s || t("drafts.sizeNone")}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="as-field">
        <span className="lbl">{t("drafts.fieldDescription")}</span>
        <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label className="as-field">
        <span className="lbl">{kind === "research" ? t("drafts.fieldQuestions") : t("drafts.fieldCriteria")}</span>
        <textarea rows={3} value={criteria} onChange={(e) => setCriteria(e.target.value)} placeholder={t("drafts.criteriaHint")} />
      </label>
      <div className="as-draft-actions">
        <Button size="sm" tone="ok" onClick={() => void add()} disabled={busy || !title.trim()}>
          {busy ? t("drafts.adding") : t("drafts.add")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void discard()} disabled={busy}>
          {t("drafts.discard")}
        </Button>
      </div>
      {error && (
        <p className="tk-error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}
