import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { CircleDot, ExternalLink, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { IssueDetail, IssueSummary, TaskIssue } from "@crewyard/core";
import { Button } from "@crewyard/ui";
import { act, useErrorText, useWork } from "./data.ts";
import { matchIssue } from "./issue.ts";
import { ErrorLine } from "./parts.tsx";
import "./issues.css";

// Issue import (A4). Picking an issue only fills the composer; the text stays editable, it is
// shown again in the crew proposal, and nothing starts until the crew is approved.

/** The open issues of the project's repo in a modal list: type to filter, arrows to move, Enter to pick. */
export function IssuePicker({ projectId, onPick, onClose }: { projectId: string; onPick: (issue: IssueDetail) => void; onClose: () => void }) {
  const { t } = useTranslation("tasks");
  const errorText = useErrorText();
  const ref = useRef<HTMLDialogElement>(null);
  const listId = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const issues = useWork("github.issues", { projectId }, { staleTime: 30_000, retry: false });
  const shown = (issues.data?.issues ?? []).filter((i) => matchIssue(i, query));
  const current = shown[Math.min(active, shown.length - 1)];

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    d?.querySelector<HTMLElement>("input")?.focus();
    return () => d?.close();
  }, []);

  useEffect(() => {
    document.getElementById(`${listId}-${current?.number}`)?.scrollIntoView({ block: "nearest" });
  }, [current, listId]);

  const pick = async (i: IssueSummary) => {
    setBusy(i.number);
    setError(null);
    try {
      onPick(await act("github.issue", { projectId, number: i.number }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, Math.min(shown.length - 1, a + (e.key === "ArrowDown" ? 1 : -1))));
    } else if (e.key === "Enter" && current && busy === null) {
      e.preventDefault();
      void pick(current);
    }
  };

  const problem = issues.data?.problem;
  return (
    <dialog
      ref={ref}
      className="tk-issues panel"
      aria-label={t("issues.title")}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="tk-issues-head">
        <h2>{t("issues.title")}</h2>
        {issues.data?.repo && (
          <span className="lbl">
            <span className="as-typed">{issues.data.repo}</span>
          </span>
        )}
        <button type="button" className="tk-x" onClick={onClose} aria-label={t("issues.close")}>
          <X size={16} strokeWidth={1.75} />
        </button>
      </div>
      <div className="tk-issues-body">
        <input
          className="tk-issues-search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKey}
          placeholder={t("issues.search")}
          aria-label={t("issues.search")}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={current ? `${listId}-${current.number}` : undefined}
          spellCheck={false}
        />
        <p className="tk-issues-note">{t("issues.untrusted")}</p>
        {issues.isLoading && <p className="muted tk-small">{t("issues.loading")}</p>}
        {problem && <p className="tk-error">{t(`issues.problem.${problem}`, { defaultValue: t("issues.problem.error") })}</p>}
        {issues.isError && <p className="tk-error">{errorText(issues.error)}</p>}
        {issues.isSuccess && !problem && shown.length === 0 && <p className="muted tk-small">{query ? t("issues.noMatch") : t("issues.none")}</p>}
        <ul id={listId} role="listbox" className="tk-issues-list" aria-label={t("issues.listLabel")}>
          {shown.map((i) => (
            <li
              key={i.number}
              id={`${listId}-${i.number}`}
              role="option"
              aria-selected={i === current}
              onMouseEnter={() => setActive(shown.indexOf(i))}
              onClick={() => void pick(i)}
            >
              <span className="num muted">#{i.number}</span>
              <span className="tk-issue-title">{i.title}</span>
              <span className="tk-issue-meta muted">
                {i.labels.slice(0, 3).map((l) => (
                  <span key={l} className="tk-issue-label as-typed">
                    {l}
                  </span>
                ))}
                {busy === i.number ? t("issues.loadingOne") : i.author ? t("issues.by", { author: i.author }) : ""}
              </span>
            </li>
          ))}
        </ul>
        <ErrorLine>{error}</ErrorLine>
      </div>
    </dialog>
  );
}

/** Shown in the composer while an imported issue is attached to the draft. */
export function IssueChip({ issue, onRemove }: { issue: { number: number; url: string; title: string }; onRemove: () => void }) {
  const { t } = useTranslation("tasks");
  return (
    <span className="chip tk-issue-chip">
      <CircleDot size={14} strokeWidth={1.75} aria-hidden="true" />
      <a href={issue.url} target="_blank" rel="noreferrer" title={issue.title}>
        {t("issues.chip", { number: issue.number })}
      </a>
      <button type="button" onClick={onRemove} aria-label={t("issues.detach", { number: issue.number })} title={t("issues.detach", { number: issue.number })}>
        <X size={12} strokeWidth={1.75} />
      </button>
    </span>
  );
}

/** In the crew proposal: where the task came from, and that its text is GitHub data to check first. */
export function IssueNote({ taskId, description }: { taskId: string; description: string }) {
  const { t } = useTranslation("tasks");
  const link = useWork("github.taskIssue", { taskId }, { retry: false });
  const issue: TaskIssue | null | undefined = link.data;
  if (!issue) return null;
  return (
    <div className="tk-issue-note">
      <div className="row">
        {/* Plain case: an uppercase label would turn "GitHub" into "GİTHUB" in Turkish. */}
        <span className="tk-issue-from">{t("issues.fromIssue")}</span>
        <a href={issue.url} target="_blank" rel="noreferrer" className="tk-issue-link">
          <CircleDot size={14} strokeWidth={1.75} aria-hidden="true" />
          <span className="as-typed">{`#${issue.number} ${issue.title}`}</span>
          <ExternalLink size={12} strokeWidth={1.75} aria-hidden="true" />
        </a>
      </div>
      <p className="tk-issues-note">{t("issues.proposalNote")}</p>
      {description && (
        <details>
          <summary>{t("issues.showText")}</summary>
          <pre className="tk-issue-text">{description}</pre>
        </details>
      )}
    </div>
  );
}

export function ImportButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation("tasks");
  return (
    <Button type="button" size="sm" variant="ghost" onClick={onClick} title={t("issues.importTitle")}>
      {t("issues.import")}
    </Button>
  );
}
