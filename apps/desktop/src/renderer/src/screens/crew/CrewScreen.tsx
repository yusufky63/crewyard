import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ReactFlowProvider } from "@xyflow/react";
import { ArrowLeftRight, Copy, List, Maximize2, MessageSquare, Minimize2, Network, Pause, PanelRight, Play, RotateCw, Square, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button, ContextMenu, MENU_SEPARATOR, type ContextMenuEntry } from "@crewyard/ui";
import type { CrewLayout, TaskDetail } from "@crewyard/core";
import { useInspector } from "../../inspector.ts";
import { call, useDaemon } from "../../ipc.ts";
import { useNav } from "../../nav.ts";
import { screens } from "../../registry.ts";
import { actionsFor, handoffCandidates, supersededRuns, type ActionId } from "./actions.ts";
import { CrewCanvas } from "./CrewCanvas.tsx";
import { useNodeTitle } from "./CrewNode.tsx";
import { ChangeAiDialog, MessageDialog, StopDialog } from "./Dialogs.tsx";
import { crewFixture } from "./fixture.ts";
import { MemberStatusLabel, runnerName, TaskStatusLabel, useFormatters } from "./labels.tsx";
import { buildGraph, defaultLayout, mergeLayout, type GraphNodeModel, type Point } from "./model.ts";
import "@xyflow/react/dist/base.css";
import "./crew.css";
import { matches } from "../../keys.ts";

// Crew graph (DESIGN.md §6): one task's crew as a graph. Moving nodes changes only the saved
// layout, never who does the work. Run actions go through the tasks IPC; layouts through crew.*.

// Screenshot mode only: the main process passes query params solely when CREWYARD_SHOT is set.
const query = new URLSearchParams(typeof location === "undefined" ? "" : location.search);
const FIXTURE = query.has("fixture");
const SHOT = { menu: query.get("crewMenu"), select: query.get("crewSelect"), full: query.get("crewFull") === "1", list: query.get("crewList") === "1" };

const ICONS: Record<ActionId, LucideIcon> = { open: PanelRight, message: MessageSquare, pause: Pause, resume: Play, retry: RotateCw, change_ai: ArrowLeftRight, copy_run_id: Copy, stop: Square };

const errorCode = (err: unknown) => (err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err));

/** Re-reads the task when the daemon reports a change; run events are batched to one read a second. */
function useCrewLive(taskId: string | null) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!taskId) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => void qc.invalidateQueries({ queryKey: ["tasks.get", { taskId }] });
    const offTasks = window.crewyard.on("tasks.changed", (p) => {
      if ((p as { taskId?: string }).taskId === taskId) refresh();
    });
    const offRuns = window.crewyard.on("runs.event", (p) => {
      if ((p as { taskId?: string }).taskId !== taskId || timer) return;
      timer = setTimeout(() => {
        timer = null;
        refresh();
      }, 1000);
    });
    return () => {
      offTasks();
      offRuns();
      if (timer) clearTimeout(timer);
    };
  }, [qc, taskId]);
}

function TaskPicker({ projectId }: { projectId: string }) {
  const { t } = useTranslation("crew");
  const selectTask = useNav((s) => s.selectTask);
  const go = useNav((s) => s.go);
  const q = useDaemon("tasks.list", { projectId });
  const hasTasksScreen = screens.some((s) => s.id === "tasks");
  const tasks = (q.data ?? []).slice(0, 8);
  return (
    <div className="crew-picker panel">
      <div className="ph">
        <h2>{t("picker.title")}</h2>
      </div>
      {q.isError ? (
        <p className="crew-picker-note">{t("picker.error")}</p>
      ) : q.isPending ? (
        <p className="crew-picker-note muted">{t("picker.loading")}</p>
      ) : tasks.length === 0 ? (
        <div className="crew-picker-note">
          <p className="muted">{t("picker.empty")}</p>
          {hasTasksScreen && (
            <Button size="sm" onClick={() => go("tasks")}>
              {t("picker.openTasks")}
            </Button>
          )}
        </div>
      ) : (
        <ul className="crew-picker-list">
          {tasks.map((task) => (
            <li key={task.id}>
              <button type="button" className="crew-picker-row" onClick={() => selectTask(task.id)}>
                <span className="crew-picker-name">{task.title}</span>
                <TaskStatusLabel status={task.status} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type Dialog = { kind: "stop" | "message" | "change_ai"; nodeId: string } | null;
type Menu = { nodeId: string; x: number; y: number } | null;

function CrewView({ task, fixture }: { task: TaskDetail; fixture: boolean }) {
  const { t } = useTranslation("crew");
  const qc = useQueryClient();
  const inspector = useInspector();
  const title = useNodeTitle();
  const fmt = useFormatters();
  const model = useMemo(() => buildGraph(task), [task]);
  const defaults = useMemo(() => defaultLayout(model), [model]);
  const layoutKey = ["crew.layout.get", { taskId: task.id }] as const;
  const saved = useDaemon("crew.layout.get", { taskId: task.id }, { enabled: !fixture, staleTime: Infinity });

  const [local, setLocal] = useState<Record<string, Point>>({});
  const [dirty, setDirty] = useState(0);
  const [selected, setSelected] = useState<string | null>(SHOT.select);
  const [menu, setMenu] = useState<Menu>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [full, setFull] = useState(SHOT.full);
  const [list, setList] = useState(SHOT.list);
  const [fitKey, setFitKey] = useState(0);
  const [notice, setNotice] = useState<{ text: string; bad: boolean } | null>(null);

  const positions = useMemo(() => {
    const merged = mergeLayout(defaults, saved.data?.positions ?? {});
    for (const [id, p] of Object.entries(local)) if (id in merged) merged[id] = p;
    return merged;
  }, [defaults, saved.data, local]);

  // Save a moment after the last finished move, so a run of Alt + arrow presses is one write.
  useEffect(() => {
    if (!dirty || fixture) return;
    const id = setTimeout(() => {
      void call("crew.layout.save", { taskId: task.id, positions })
        .then((layout: CrewLayout) => qc.setQueryData(layoutKey, layout))
        .catch((err: unknown) => setNotice({ text: t("error.layout", { code: errorCode(err) }), bad: true }));
    }, 400);
    return () => clearTimeout(id);
    // layoutKey is rebuilt every render from task.id, which is already a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, positions, task.id, fixture, qc, t]);

  const onMove = useCallback((id: string, p: Point, done: boolean) => {
    setLocal((prev) => ({ ...prev, [id]: p }));
    if (done) setDirty((n) => n + 1);
  }, []);

  const byId = useMemo(() => new Map(model.nodes.map((n) => [n.id, n])), [model]);

  const openInspector = useCallback(
    (n: GraphNodeModel) => inspector.open({ taskId: task.id, ...(n.memberId ? { memberId: n.memberId } : {}), ...(n.run ? { runId: n.run.id } : {}) }),
    [inspector, task.id],
  );

  const onSelect = useCallback(
    (id: string | null) => {
      setSelected(id);
      const n = id ? byId.get(id) : null;
      if (n) openInspector(n);
    },
    [byId, openInspector],
  );

  const onMenu = useCallback((nodeId: string, x: number, y: number) => setMenu({ nodeId, x, y }), []);
  const closeMenu = useCallback(() => setMenu(null), []);

  // Screenshot mode can ask for the menu of one node to be open.
  useEffect(() => {
    if (!SHOT.menu) return;
    const id = setTimeout(() => {
      const el = document.querySelector<HTMLElement>(`[data-node="${CSS.escape(SHOT.menu!)}"]`);
      if (!el) return;
      el.focus();
      const r = el.getBoundingClientRect();
      setMenu({ nodeId: SHOT.menu!, x: r.left + 24, y: r.bottom - 8 });
    }, 1500);
    return () => clearTimeout(id);
  }, []);

  const toggleFull = useCallback(() => setFull((f) => !f), []);

  // F toggles full screen; Esc leaves it once nothing above it (menu, dialog, inspector) is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (menu || dialog || el?.closest("input, textarea, select, [contenteditable], dialog")) return;
      if (matches(e, "graph.full") && !list) {
        e.preventDefault();
        setFull((f) => !f);
      } else if (matches(e, "close") && full && !useInspector.getState().target) {
        setFull(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menu, dialog, full, list]);

  const refresh = () => void qc.invalidateQueries({ queryKey: ["tasks.get", { taskId: task.id }] });
  const runCall = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      setNotice({ text: ok, bad: false });
    } catch (err) {
      const code = errorCode(err);
      setNotice({ text: t(`error.${code}`, { defaultValue: t("error.generic", { code }) }), bad: true });
    } finally {
      refresh();
    }
  };

  const ctx = useMemo(
    () => ({
      resumable: new Set(task.resumableRunIds),
      taskCancelled: !!task.cancelledAt,
      superseded: supersededRuns(task),
      handoffTargets: (memberId: string, profileId: string) => handoffCandidates(task, memberId, profileId).length,
    }),
    [task],
  );

  const menuNode = menu ? byId.get(menu.nodeId) : undefined;
  const menuItems: ContextMenuEntry[] = menuNode
    ? actionsFor(menuNode, ctx).flatMap((group, gi) => [
        ...(gi > 0 ? [MENU_SEPARATOR] : []),
        ...group.map((a) => {
          const Icon = ICONS[a.id];
          return {
            id: a.id,
            label: t(`menu.${a.id}`),
            icon: <Icon size={14} strokeWidth={1.75} />,
            tone: a.danger ? ("danger" as const) : undefined,
            disabledReason: a.disabled ? t(`menu.why.${a.disabled}`) : null,
          };
        }),
      ])
    : [];

  const act = (id: ActionId, n: GraphNodeModel) => {
    const run = n.run;
    switch (id) {
      case "open":
        setSelected(n.id);
        return openInspector(n);
      case "message":
      case "stop":
      case "change_ai":
        return setDialog({ kind: id, nodeId: n.id });
      case "retry":
        if (run) void runCall(() => call("runs.retry", { runId: run.id }), t("done.retry", { target: title(n, task.title) }));
        return;
      case "pause":
        if (run) void runCall(() => call("runs.pause", { runId: run.id, sessionId: run.nativeSessionId }), t("done.pause", { target: title(n, task.title) }));
        return;
      case "resume":
        if (run) void runCall(() => call("runs.resume", { runId: run.id }), t("done.resume", { target: title(n, task.title) }));
        return;
      case "copy_run_id":
        if (run)
          void navigator.clipboard.writeText(run.id).then(
            () => setNotice({ text: t("done.copied"), bad: false }),
            () => setNotice({ text: t("error.copy"), bad: true }),
          );
        return;
    }
  };

  const resetLayout = async () => {
    setLocal({});
    setDirty(0);
    if (!fixture) {
      try {
        qc.setQueryData(layoutKey, await call("crew.layout.reset", { taskId: task.id }));
      } catch (err) {
        setNotice({ text: t("error.layout", { code: errorCode(err) }), bad: true });
      }
    }
    setFitKey((k) => k + 1);
  };

  const dialogNode = dialog ? byId.get(dialog.nodeId) : undefined;
  const members = model.nodes.filter((n) => n.kind === "member").length;

  return (
    <section className="screen crew" aria-label={t("title")}>
      <div className="page-head">
        <div>
          <h1>{t("title")}</h1>
          <div className="sub lbl">
            {/* The title is the user's own text: no forced uppercase, which would also apply Turkish casing to English words. */}
            <span className="crew-sub-title">{task.title}</span> · {t("sub", { count: members })}
            {fixture && <span className="crew-fixture"> · {t("fixture")}</span>}
          </div>
        </div>
        <div className="right">
          <Button size="sm" variant="ghost" onClick={() => void resetLayout()} disabled={list}>
            {t("reset")}
          </Button>
          <Button size="sm" aria-pressed={list} onClick={() => setList((l) => !l)}>
            {list ? <Network /> : <List />}
            {list ? t("showGraph") : t("showList")}
          </Button>
          <Button size="sm" onClick={toggleFull} disabled={list} title={t("full.enterHint")}>
            {full ? <Minimize2 /> : <Maximize2 />}
            {full ? t("full.exit") : t("full.enter")}
          </Button>
        </div>
      </div>

      <div className="crew-live" role="status" aria-live="polite">
        {notice && <span className={notice.bad ? "crew-notice bad" : "crew-notice"}>{notice.text}</span>}
      </div>

      {list ? (
        <div className="crew-list panel">
          <table>
            <thead>
              <tr>
                <th className="lbl">{t("list.step")}</th>
                <th className="lbl">{t("list.runner")}</th>
                <th className="lbl">{t("list.status")}</th>
                <th className="lbl">{t("list.model")}</th>
                <th className="lbl">{t("list.fact")}</th>
              </tr>
            </thead>
            <tbody>
              {model.nodes.map((n) => (
                <tr key={n.id} className={n.kind === "standby" ? "standby" : undefined}>
                  <td>
                    <button
                      type="button"
                      data-node={n.id}
                      aria-haspopup="menu"
                      className="crew-list-open"
                      onClick={() => onSelect(n.id)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.currentTarget.focus();
                        onMenu(n.id, e.clientX, e.clientY);
                      }}
                      onKeyDown={(e) => {
                        if (matches(e, "graph.menu")) {
                          e.preventDefault();
                          const r = e.currentTarget.getBoundingClientRect();
                          onMenu(n.id, r.left + 24, r.bottom);
                        }
                      }}
                    >
                      {title(n, task.title)}
                    </button>
                  </td>
                  <td>{n.kind === "task" ? "" : runnerName(t, n.runner)}</td>
                  <td>{n.kind === "task" && n.taskStatus ? <TaskStatusLabel status={n.taskStatus} /> : n.status ? <MemberStatusLabel status={n.status} /> : null}</td>
                  <td className="mono">{n.kind === "task" ? "" : [n.model ?? t("node.defaultModel"), n.account ?? t("node.noAccount")].join(" · ")}</td>
                  <td className="mono muted">{fmt.fact(n.fact)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className={full ? "crew-frame full" : "crew-frame"}>
          <ReactFlowProvider>
            <CrewCanvas
              model={model}
              taskTitle={task.title}
              positions={positions}
              selected={selected}
              full={full}
              onMove={onMove}
              onSelect={onSelect}
              onMenu={onMenu}
              onToggleFull={toggleFull}
              fitKey={fitKey}
            />
          </ReactFlowProvider>
          {full && (
            <Button size="sm" className="crew-exit" onClick={() => setFull(false)}>
              {t("full.exit")} <span className="kbd">Esc</span>
            </Button>
          )}
        </div>
      )}
      {!list && <p className="crew-help">{t("legend.help")}</p>}

      {menu && menuNode && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={t("menu.label", { target: title(menuNode, task.title) })}
          heading={t("menu.heading")}
          title={title(menuNode, task.title)}
          items={menuItems}
          onClose={closeMenu}
          onSelect={(id) => act(id as ActionId, menuNode)}
        />
      )}

      {dialog?.kind === "stop" && dialogNode?.run && (
        <StopDialog
          target={t("stop.target", {
            target: title(dialogNode, task.title),
            model: dialogNode.run.model ?? t("node.defaultModel"),
            account: dialogNode.account ?? t("node.noAccount"),
          })}
          onClose={() => setDialog(null)}
          onConfirm={() => runCall(() => call("runs.stop", { runId: dialogNode.run!.id, sessionId: dialogNode.run!.nativeSessionId }), t("done.stop", { target: title(dialogNode, task.title) })).then(() => setDialog(null))}
        />
      )}
      {dialog?.kind === "change_ai" && dialogNode?.run && dialogNode.memberId && (
        <ChangeAiDialog
          target={title(dialogNode, task.title)}
          candidates={handoffCandidates(task, dialogNode.memberId, dialogNode.run.profileId)}
          runnerLabel={(r) => runnerName(t, r)}
          onClose={() => setDialog(null)}
          onConfirm={(profileId) =>
            runCall(() => call("runs.handoff", { runId: dialogNode.run!.id, targetProfileId: profileId }), t("done.handoff", { target: title(dialogNode, task.title) })).then(() => setDialog(null))
          }
        />
      )}
      {dialog?.kind === "message" && dialogNode?.run && (
        <MessageDialog
          target={title(dialogNode, task.title)}
          live={dialogNode.run.state === "starting" || dialogNode.run.state === "running" || dialogNode.run.state === "waiting_input" || dialogNode.run.state === "waiting_approval"}
          onClose={() => setDialog(null)}
          onSend={(text) => runCall(() => call("runs.message", { runId: dialogNode.run!.id, text, sessionId: dialogNode.run!.nativeSessionId }), t("done.message")).then(() => setDialog(null))}
        />
      )}
    </section>
  );
}

export function CrewScreen() {
  const { t } = useTranslation("crew");
  const projectId = useNav((s) => s.projectId);
  const taskId = useNav((s) => s.taskId);
  const selectTask = useNav((s) => s.selectTask);
  useCrewLive(FIXTURE ? null : taskId);
  const q = useDaemon("tasks.get", { taskId: taskId ?? "" }, { enabled: !FIXTURE && !!taskId });
  const [fixture] = useState(() => (FIXTURE ? crewFixture() : null));

  if (fixture) return <CrewView key={fixture.id} task={fixture} fixture />;
  if (!projectId) return null;
  if (!taskId)
    return (
      <section className="screen crew" aria-label={t("title")}>
        <div className="page-head">
          <div>
            <h1>{t("title")}</h1>
            <div className="sub lbl">{t("noTask")}</div>
          </div>
        </div>
        <TaskPicker projectId={projectId} />
      </section>
    );
  if (q.isError)
    return (
      <section className="screen crew" aria-label={t("title")}>
        <div className="page-head">
          <div>
            <h1>{t("title")}</h1>
            <div className="sub lbl">{t(`error.${errorCode(q.error)}`, { defaultValue: t("error.generic", { code: errorCode(q.error) }) })}</div>
          </div>
          <div className="right">
            <Button size="sm" onClick={() => selectTask(null)}>
              {t("picker.choose")}
            </Button>
          </div>
        </div>
      </section>
    );
  if (!q.data)
    return (
      <section className="screen crew" aria-label={t("title")}>
        <div className="page-head">
          <div>
            <h1>{t("title")}</h1>
            <div className="sub lbl">{t("picker.loading")}</div>
          </div>
        </div>
      </section>
    );
  return <CrewView key={q.data.id} task={q.data} fixture={false} />;
}
