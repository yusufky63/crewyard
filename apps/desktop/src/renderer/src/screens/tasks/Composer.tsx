import { useId, useState, type FormEvent, type KeyboardEvent } from "react";
import { Folder, GitBranch } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { FallbackMode, TaskKind } from "@crewyard/core";
import { Button, Label, Panel } from "@crewyard/ui";
import { useDaemon } from "../../ipc.ts";
import { useNav } from "../../nav.ts";
import { act, useErrorText } from "./data.ts";
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
  const repo = useDaemon("github.repo", { projectId }, { staleTime: 60_000, retry: false });
  const [text, setText] = useState("");
  const [branch, setBranch] = useState("");
  const [kind, setKind] = useState<TaskKind | "auto">("auto");
  const [fallback, setFallback] = useState<FallbackMode | "default">("default");
  const [budget, setBudget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
      setText("");
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
          <div className="end">
            <span className="kbd">Ctrl</span>
            <span className="kbd">Enter</span>
            <Button type="submit" disabled={!ready}>
              {busy ? t("composer.proposing") : t("composer.propose")}
            </Button>
          </div>
        </div>
        <div className="tk-composer-foot">
          <Label>{t("composer.note")}</Label>
        </div>
        <ErrorLine>{error}</ErrorLine>
      </form>
    </Panel>
  );
}
