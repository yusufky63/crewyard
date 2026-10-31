import { useEffect, useMemo } from "react";
import { CircleX, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@crewyard/ui";
import { useInspector } from "../../inspector.ts";
import { useDaemon } from "../../ipc.ts";
import { useNav } from "../../nav.ts";
import { usePrefs } from "../../prefs.ts";
import { openSettings } from "../../screens/settings/model.ts";
import { useFormat } from "../../screens/tasks/parts.tsx";
import { buildProblems, problemCounts, pruneDismissed, visibleProblems, type Dismissed, type Problem, type ProblemCounts, type ProblemLink } from "./problems.ts";

// The Problems tab (DESIGN.md §4): every failure in the open project in one list, newest first,
// each with the place you fix it. Read only while the panel is open. A dismissal hides a row until
// its cause changes or comes back (problems.ts).

const NONE: Dismissed = {};

/** Every source of the list, read while the panel is open; the tab's count needs them too. */
export function useProblems(projectId: string): { all: Problem[]; shown: Problem[]; counts: ProblemCounts; dismissed: Dismissed; loading: boolean; failed: boolean } {
  const qc = useQueryClient();
  const live = { refetchInterval: 15_000 } as const;
  const sources = useDaemon("problems.sources", { projectId }, live);
  const stalls = useDaemon("stalls.list", { projectId }, live);
  const config = useDaemon("setup.configNotices", undefined, { staleTime: 30_000 });
  const roles = useDaemon("roles.list", { projectId }, { staleTime: 30_000 });
  const shares = useDaemon("agentfiles.shares", undefined, { staleTime: 30_000 });
  const keys = useDaemon("providers.keyChecks", undefined, { staleTime: 30_000 });
  const credentials = useDaemon("providers.credentials", undefined, { staleTime: 60_000 });
  const dismissed = usePrefs((s) => s.problemsDismissed[projectId] ?? NONE);
  const setDismissed = usePrefs((s) => s.setProblemsDismissed);

  // A run that ends, a check GitHub reports, a stall that opens: read the sources again, at most once a second.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const again = () => {
      timer ??= setTimeout(() => {
        timer = null;
        void qc.invalidateQueries({ queryKey: ["problems.sources"] });
      }, 1000);
    };
    const offs = ["tasks.changed", "github.changed", "stalls.changed"].map((topic) => window.crewyard.on(topic, again));
    offs.push(window.crewyard.on("agentfiles.changed", () => void qc.invalidateQueries({ queryKey: ["agentfiles.shares"] })));
    return () => {
      offs.forEach((off) => off());
      if (timer) clearTimeout(timer);
    };
  }, [qc]);

  const all = useMemo(
    () =>
      buildProblems({
        projectId,
        sources: sources.data,
        stalls: stalls.data,
        configNotices: config.data,
        roleProblems: roles.data?.problems,
        shares: shares.data,
        keyChecks: keys.data,
        credentials: credentials.data,
      }),
    [projectId, sources.data, stalls.data, config.data, roles.data, shares.data, keys.data, credentials.data],
  );
  const queries = [sources, stalls, config, roles, shares, keys, credentials];
  const complete = queries.every((q) => q.isSuccess);

  // Forget dismissals whose cause is gone, but only from a complete read.
  useEffect(() => {
    if (!complete) return;
    const pruned = pruneDismissed(dismissed, all);
    if (pruned !== dismissed) setDismissed(projectId, pruned);
  }, [complete, all, dismissed, projectId, setDismissed]);

  const shown = visibleProblems(all, dismissed);
  return { all, shown, counts: problemCounts(shown), dismissed, loading: queries.some((q) => q.isPending), failed: queries.some((q) => q.isError) };
}

/** Takes you to where a problem is fixed. */
function follow(link: ProblemLink): void {
  const nav = useNav.getState();
  switch (link.to) {
    case "task":
      nav.selectTask(link.taskId);
      nav.go("tasks");
      useInspector.getState().open({ taskId: link.taskId, ...(link.memberId ? { memberId: link.memberId } : {}), ...(link.runId ? { runId: link.runId } : {}), tab: "details" });
      return;
    case "inbox":
      nav.selectTask(link.taskId);
      nav.go("inbox");
      return;
    case "github":
      nav.selectTask(link.taskId);
      nav.go("github");
      return;
    case "settings":
      openSettings(link.section);
      return;
    case "providers":
      nav.go("providers");
      return;
    case "events":
      usePrefs.getState().setDrawerTab("events");
      return;
  }
}

function useProblemText() {
  const { t } = useTranslation("activity");
  const f = useFormat();
  return (p: Problem): { title: string; detail: string | null } => {
    const params: Record<string, string | number> = { ...p.title.params };
    if (typeof params.role === "string") params.role = params.role ? f.role(params.role) : "";
    if (typeof params.runner === "string") params.runner = f.runner(params.runner);
    const title = t(`problems.title.${p.title.key}`, params);
    let code: string | null = null;
    if (p.code) {
      if (p.kind === "run") code = f.t(`endDetail.${p.code}`, { defaultValue: p.code });
      else if (p.kind === "config") code = t(`settings:configNotice.reason.${p.code}`, { defaultValue: p.code });
      else if (p.kind === "role") code = t(`settings:roles.problem.${p.code}`, { defaultValue: p.code, detail: "" });
      else if (p.kind === "agentfile") code = t(`settings:agentfiles.error.${p.code.replace(/^agentfiles\./, "")}`, { defaultValue: p.code });
      else if (p.kind === "key") code = t(`providers:keyCheck.reason.${p.code}`, { status: p.text ?? "", defaultValue: p.code });
    }
    const text = p.kind === "key" ? null : p.text;
    return { title, detail: [code, text].filter(Boolean).join(" · ") || null };
  };
}

export function ProblemsTab({ projectId }: { projectId: string }) {
  const { t } = useTranslation("activity");
  const f = useFormat();
  const text = useProblemText();
  const { all, shown, counts, dismissed, loading, failed } = useProblems(projectId);
  const setDismissed = usePrefs((s) => s.setProblemsDismissed);
  const hidden = all.length - shown.length;

  const dismiss = (p: Problem) => {
    setDismissed(projectId, { ...dismissed, [p.id]: p.fingerprint });
    // Focus stays in the list: on the next row's first button, or the list itself when it was the last.
    requestAnimationFrame(() => (document.querySelector<HTMLElement>(".pb-list .pb-act button") ?? document.querySelector<HTMLElement>(".pb-list"))?.focus());
  };

  return (
    <div className="pb">
      <div className="drawer-tools">
        <span className="pb-summary" aria-live="polite">
          {counts.total === 0 ? t("problems.none") : t("problems.summary", { count: counts.total, danger: counts.danger, warning: counts.warning })}
        </span>
        {hidden > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setDismissed(projectId, {})}>
            {t("problems.restore", { count: hidden })}
          </Button>
        )}
      </div>
      {failed && <p className="drawer-empty ev-err">{t("problems.error")}</p>}
      {loading && shown.length === 0 && <p className="drawer-empty muted">{t("loading")}</p>}
      {!loading && shown.length === 0 && !failed && <p className="drawer-empty muted">{hidden > 0 ? t("problems.allDismissed") : t("problems.empty")}</p>}
      {shown.length > 0 && (
        <ul className="pb-list" aria-label={t("problems.listLabel")} tabIndex={-1}>
          {shown.map((p) => {
            const words = text(p);
            const Icon = p.severity === "danger" ? CircleX : TriangleAlert;
            return (
              <li key={p.id} className={`pb-row pb-${p.severity}`}>
                <span className="pb-sev">
                  <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span className="drawer-sr">{t(`problems.severity.${p.severity}`)}</span>
                </span>
                <span className="ev-time">{p.at ? f.when.at(p.at) : ""}</span>
                <span className="pb-main">
                  <span className="pb-title">
                    {words.title}
                    {p.taskTitle && <span className="muted as-typed"> · {p.taskTitle}</span>}
                  </span>
                  {words.detail && (
                    <span className="pb-detail mono as-typed" title={words.detail}>
                      {words.detail}
                    </span>
                  )}
                </span>
                <span className="pb-act">
                  <Button size="sm" onClick={() => follow(p.link)}>
                    {t(`problems.open.${p.link.to}`)}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => dismiss(p)} aria-label={t("problems.dismissLabel", { title: words.title })}>
                    {t("problems.dismiss")}
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
