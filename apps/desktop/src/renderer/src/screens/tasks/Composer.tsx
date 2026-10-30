import { useId, useState, type FormEvent, type KeyboardEvent } from "react";
import { Folder, GitBranch } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { FallbackMode, IssueDetail, TaskKind } from "@crewyard/core";
import { Button, Label, Panel } from "@crewyard/ui";
import { useNav } from "../../nav.ts";
import { act, useErrorText, useWork } from "./data.ts";
import { issueDraft } from "./issue.ts";
import { ImportButton, IssueChip, IssuePicker } from "./IssuePicker.tsx";
import { splitTaskText } from "./model.ts";
import { ErrorLine } from "./parts.tsx";

const KINDS: Array<TaskKind | "auto"> = ["auto", "code", "research", "review", "docs"];
const FALLBACKS: Array<FallbackMode | "default"> = ["default", "manual", "ask", "auto", "wait_for_reset"];

/**
 * DESIGN.md `Composer`: one text, the repo, base branch, task kind, on-limit mode and an optional
 * budget. Submitting (Ctrl Enter) only proposes a crew; nothing starts until it is approved.
 */
export function Composer({ projectId, projectName }: { projectId: string; projectName: string }) {
  const { t } = useTranslation("tasks");
  const errorText = useErrorText();
  const selectTask = useNav((s) => s.selectTask);
  const repo = useWork("github.repo", { projectId }, { staleTime: 60_000, retry: false });
  const [text, setText] = useState("");
  const [branch, setBranch] = useState("");
  const [kind, setKind] = useState<TaskKind | "auto">("auto");
  const [fallback, setFallback] = useState<FallbackMode | "default">("default");
  const [budget, setBudget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [issue, setIssue] = useState<{ number: number; url: string; title: string } | null>(null);
  const ids = { text: useId(), branch: useId(), kind: useId(), fallback: useId(), budget: useId() };

  const { title, description } = splitTaskText(text);
  const budgetUsd = budget.trim() === "" ? undefined : Number(budget);
  const budgetBad = budgetUsd !== undefined && (!Number.isFinite(budgetUsd) || budgetUsd <= 0);
  const ready = title.length > 0 && !budgetBad && !busy;

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const task = await act("tasks.propose", {
        projectId,
        title,
        ...(description ? { description } : {}),
        ...(kind !== "auto" ? { kind } : {}),
        ...(fallback !== "default" ? { fallback } : {}),
        ...(branch.trim() ? { baseBranch: branch.trim() } : {}),
        ...(budgetUsd !== undefined ? { budgetUsd } : {}),
      });
      // The link is kept with the task; a failure here leaves the proposed task as it is.
      if (issue) await act("github.linkIssue", { taskId: task.id, number: issue.number, url: issue.url, title: issue.title }).catch((err: unknown) => setError(errorText(err)));
      setText("");
      setIssue(null);
      selectTask(task.id);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <Panel className="tk-composer">
      <form onSubmit={(e) => void submit(e)} onKeyDown={onKey}>
        <label className="lbl" htmlFor={ids.text}>
          {t("composer.label")}
        </label>
        <textarea id={ids.text} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("composer.placeholder")} rows={2} />
        {picking && (
          <IssuePicker
            projectId={projectId}
            onClose={() => setPicking(false)}
            onPick={(picked: IssueDetail) => {
              setText(issueDraft(picked));
              setIssue({ number: picked.number, url: picked.url, title: picked.title });
              setPicking(false);
            }}
          />
        )}
        <div className="tk-composer-row">
          <span className="chip" title={t("composer.repoTitle")}>
            <Folder size={14} strokeWidth={1.75} aria-hidden="true" />
            <b>{projectName}</b>
          </span>
          <label className="chip tk-field" htmlFor={ids.branch} title={t("composer.branchTitle")}>
            <GitBranch size={14} strokeWidth={1.75} aria-hidden="true" />
            <span className="sr">{t("composer.branch")}</span>
            <input id={ids.branch} value={branch} onChange={(e) => setBranch(e.target.value)} placeholder={repo.data?.currentBranch ?? t("composer.branchCurrent")} spellCheck={false} />
          </label>
          <label className="chip tk-field" htmlFor={ids.kind}>
            {t("composer.kind")}
            <select id={ids.kind} value={kind} onChange={(e) => setKind(e.target.value as TaskKind | "auto")}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`kind.${k}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="chip tk-field" htmlFor={ids.fallback}>
            {t("composer.onLimit")}
            <select id={ids.fallback} value={fallback} onChange={(e) => setFallback(e.target.value as FallbackMode | "default")}>
              {FALLBACKS.map((f) => (
                <option key={f} value={f}>
                  {t(`fallback.${f}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="chip tk-field" htmlFor={ids.budget}>
            {t("composer.budget")}
            <input id={ids.budget} className="num" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder={t("composer.budgetNone")} aria-invalid={budgetBad || undefined} size={6} />
          </label>
          {issue ? <IssueChip issue={issue} onRemove={() => setIssue(null)} /> : repo.data?.remote && <ImportButton onClick={() => setPicking(true)} />}
          <div className="end">
            <span className="kbd">Ctrl</span>
            <span className="kbd">Enter</span>
            <Button type="submit" disabled={!ready}>
              {busy ? t("composer.proposing") : t("composer.propose")}
            </Button>
          </div>
        </div>
        <div className="tk-composer-foot">
          <Label>{issue ? t("issues.composerNote") : t("composer.note")}</Label>
        </div>
        <ErrorLine>{error}</ErrorLine>
      </form>
    </Panel>
  );
}
