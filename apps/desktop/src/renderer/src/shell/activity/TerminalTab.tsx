import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@crewyard/ui";
import type { TerminalShellId } from "../../../../shared/api.ts";
import { useDaemon } from "../../ipc.ts";
import { ariaKeys, matches } from "../../keys.ts";
import { useNav } from "../../nav.ts";
import { usePrefs } from "../../prefs.ts";
import { useWork } from "../../screens/tasks/data.ts";
import { attach, closeSession, createSession, focusSession, useTerminals, type TermSession } from "./terminals.ts";
import "@xterm/xterm/css/xterm.css";

// The Terminal tab (docs/adr/0016-terminal.md): your own shell in the project folder or the
// selected task's worktree, never started on its own, never given a key. Hiding the panel keeps it
// running; closing its tab ends it, and asks first while it runs.

function useShells() {
  return useQuery({ queryKey: ["terminal.shells"], queryFn: () => window.crewyard.terminalShells(), staleTime: 60_000 });
}

export function TerminalTab({ projectId }: { projectId: string }) {
  const { t } = useTranslation("activity");
  const allSessions = useTerminals((s) => s.sessions);
  const sessions = allSessions.filter((x) => x.projectId === projectId);
  const activeKey = useTerminals((s) => s.active[projectId]);
  const confirming = useTerminals((s) => s.confirming);
  const select = useTerminals((s) => s.select);
  const setConfirming = useTerminals((s) => s.setConfirming);
  const shells = useShells();
  const chosenShell = usePrefs((s) => s.terminalShell);
  const setShell = usePrefs((s) => s.setTerminalShell);
  const taskId = useNav((s) => s.taskId);
  const projects = useDaemon("projects.list", undefined);
  const project = projects.data?.find((p) => p.id === projectId);
  const task = useWork("tasks.get", { taskId: taskId ?? "" }, { enabled: Boolean(taskId) });
  const worktree = task.data && task.data.projectId === projectId ? task.data.worktree?.path ?? null : null;
  const [where, setWhere] = useState<"project" | "worktree">("project");
  const ids = { shell: useId(), where: useId() };
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const list = shells.data ?? [];
  const shell: TerminalShellId | null = (list.find((s) => s.id === chosenShell) ?? list[0])?.id ?? null;
  const place = where === "worktree" && worktree ? "worktree" : "project";
  const cwd = place === "worktree" ? worktree : (project?.path ?? null);
  const active = sessions.find((s) => s.key === activeKey) ?? sessions.at(-1) ?? null;

  const open = () => {
    if (!shell || !cwd) return;
    createSession(projectId, shell, cwd, place);
  };

  const askClose = (s: TermSession) => {
    if (s.state === "running" || s.state === "starting") setConfirming(s.key);
    else closeSession(s.key);
  };

  // Sub-tabs after the WAI-ARIA tabs pattern; Delete closes the focused one (asking while it runs).
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, s: TermSession) => {
    if (matches(e, "terminal.close")) {
      e.preventDefault();
      askClose(s);
      return;
    }
    const i = sessions.indexOf(s);
    const n = sessions.length;
    const next = e.key === "ArrowRight" ? (i + 1) % n : e.key === "ArrowLeft" ? (i + n - 1) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    const to = sessions[next]!;
    select(projectId, to.key);
    tabRefs.current[to.key]?.focus();
  };

  return (
    <div className="term">
      <div className="drawer-tools">
        <label className="drawer-field" htmlFor={ids.shell}>
          <span className="lbl">{t("terminal.shell")}</span>
          <select id={ids.shell} className="drawer-select" value={shell ?? ""} onChange={(e) => setShell(e.target.value)} disabled={list.length === 0}>
            {list.map((s) => (
              <option key={s.id} value={s.id} title={s.path}>
                {t(`terminal.shells.${s.id}`)}
              </option>
            ))}
          </select>
        </label>
        <div className="seg" role="group" aria-label={t("terminal.where")}>
          <button type="button" aria-pressed={place === "project"} onClick={() => setWhere("project")}>
            {t("terminal.project")}
          </button>
          <button type="button" aria-pressed={place === "worktree"} onClick={() => setWhere("worktree")} disabled={!worktree} title={worktree ?? t("terminal.noWorktree")}>
            {t("terminal.worktree")}
          </button>
        </div>
        <span className="drawer-path mono as-typed muted" title={cwd ?? undefined}>
          {cwd ?? ""}
        </span>
        <Button size="sm" onClick={open} disabled={!shell || !cwd}>
          {t("terminal.new")}
        </Button>
      </div>

      {sessions.length > 0 && (
        <div className="term-tabs" role="tablist" aria-label={t("terminal.tabsLabel")}>
          {sessions.map((s) => (
            <span key={s.key} className="term-tab" data-active={s.key === active?.key ? "" : undefined}>
              <button
                ref={(el) => {
                  tabRefs.current[s.key] = el;
                }}
                type="button"
                role="tab"
                id={`term-tab-${s.key}`}
                aria-selected={s.key === active?.key}
                aria-controls={`term-view-${s.key}`}
                aria-keyshortcuts={ariaKeys("terminal.close")}
                tabIndex={s.key === active?.key ? 0 : -1}
                onClick={() => select(projectId, s.key)}
                onKeyDown={(e) => onTabKey(e, s)}
              >
                <span className={`term-dot term-${s.state}`} aria-hidden="true" />
                {t("terminal.tabName", { shell: t(`terminal.shells.${s.shell}`), n: s.n })}
                <span className="drawer-sr">{t(`terminal.state.${s.state}`)}</span>
              </button>
              <button type="button" className="term-x" tabIndex={-1} onClick={() => askClose(s)} aria-label={t("terminal.close", { n: s.n })} title={t("terminal.closeTitle")}>
                <X size={12} strokeWidth={1.75} aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      )}

      {active && confirming === active.key && (
        <div className="term-confirm" role="alertdialog" aria-labelledby="term-confirm-text">
          <span id="term-confirm-text">{t("terminal.confirm")}</span>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
            {t("terminal.keep")}
          </Button>
          <Button
            size="sm"
            variant="danger"
            autoFocus
            onClick={() => {
              closeSession(active.key);
              requestAnimationFrame(() => document.querySelector<HTMLElement>(".term-tabs [role=tab][tabindex='0']")?.focus());
            }}
          >
            {t("terminal.end")}
          </Button>
        </div>
      )}

      {active ? <TermView key={active.key} session={active} /> : <TermEmpty />}
    </div>
  );
}

function TermEmpty() {
  const { t } = useTranslation("activity");
  return (
    <div className="term-empty">
      <p>{t("terminal.empty")}</p>
      <p className="muted">{t("terminal.emptyNote")}</p>
    </div>
  );
}

function TermView({ session }: { session: TermSession }) {
  const { t } = useTranslation("activity");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!box.current) return;
    const detach = attach(session.key, box.current);
    focusSession(session.key);
    return detach;
  }, [session.key]);
  return (
    <div className="term-view" id={`term-view-${session.key}`} role="tabpanel" aria-labelledby={`term-tab-${session.key}`}>
      {session.state === "failed" && <p className="term-line term-bad">{t("terminal.failed", { reason: t(`terminal.refused.${session.error}`, { defaultValue: session.error ?? "" }) })}</p>}
      {session.state === "exited" && <p className="term-line">{session.code === null ? t("terminal.endedHost") : t("terminal.ended", { code: session.code })}</p>}
      <div className="term-box" ref={box} />
      <p className="term-foot muted">
        <span className="mono as-typed" title={session.cwd}>
          {session.cwd}
        </span>
        <span>{t("terminal.foot")}</span>
      </p>
    </div>
  );
}
