import { useId, useState } from "react";
import { ArrowRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AssistantGoalDraftView } from "@crewyard/core";
import { Button } from "@crewyard/ui";
import { useNav } from "../../../nav.ts";
import { act } from "../data.ts";
import { useGoalNav } from "../goalNav.ts";
import { useFormat } from "../parts.tsx";
import { useAssistantError } from "./errors.ts";
import { fillComposer } from "./goalDraft.ts";

/** `Open in composer`: the project's Tasks screen, its composer in Orchestra mode with the goal's text. */
function openInComposer(projectId: string, d: AssistantGoalDraftView): void {
  const nav = useNav.getState();
  if (nav.projectId !== projectId) nav.openProject(projectId);
  nav.go("tasks");
  fillComposer(projectId, d);
}

/**
 * A goal the assistant drafted with draft_goal (docs/adr/0022). Its text is agent-written and shown
 * as plain text. `Open in composer` puts it into the Tasks composer in Orchestra mode; planning it
 * is still your Plan goal click there, which states the planning cost first.
 */
export function GoalDraftCard({ draft, projectId, onChanged }: { draft: AssistantGoalDraftView; projectId: string; onChanged?: () => void }) {
  const { t } = useTranslation("assistant");
  const f = useFormat();
  const errorText = useAssistantError();
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  const discard = async () => {
    setError(null);
    try {
      await act("assistant.discardGoalDraft", { draftId: draft.id });
      onChanged?.();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const openGoal = () => {
    if (!draft.goalId) return;
    useNav.getState().go("tasks");
    useGoalNav.getState().open(draft.goalId);
  };

  return (
    <article className="spec as-draft as-goal-draft" aria-labelledby={`${id}-t`}>
      <div className="as-draft-top">
        <span className="badge badge-info">{t("goalDraft.badge")}</span>
        <span className="badge">{t("goalDraft.from")}</span>
        {draft.status === "planned" && <span className="badge badge-ok">{t("goalDraft.plannedBadge")}</span>}
      </div>
      <p className="lbl" id={`${id}-t`}>
        {t("goalDraft.label")}
      </p>
      <p className="as-goal-text as-typed">{draft.text}</p>
      {(draft.plannerAlias || draft.budgetUsd) && (
        <p className="muted tk-small as-goal-meta">
          {draft.plannerAlias && <span>{t("goalDraft.planner", { alias: draft.plannerAlias })}</span>}
          {draft.budgetUsd ? <span>{t("goalDraft.budget", { budget: f.usd(draft.budgetUsd) })}</span> : null}
        </p>
      )}
      {draft.status === "planned" ? (
        <>
          <p className="muted tk-small">{t("goalDraft.planned")}</p>
          {draft.goalId && (
            <Button size="sm" className="as-open-task" onClick={openGoal}>
              {t("goalDraft.openGoal")}
              <ArrowRight aria-hidden="true" />
            </Button>
          )}
        </>
      ) : (
        <>
          <p className="muted tk-small">{t("goalDraft.note")}</p>
          <div className="as-draft-actions">
            <Button size="sm" variant="primary" onClick={() => openInComposer(projectId, draft)}>
              {t("goalDraft.open")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void discard()}>
              {t("drafts.discard")}
            </Button>
          </div>
        </>
      )}
      {error && (
        <p className="tk-error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}
