import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ReactFlowProvider } from "@xyflow/react";
import {
  ArrowLeftRight,
  Copy,
  FileDiff,
  FolderTree,
  Hourglass,
  List,
  ListPlus,
  Maximize2,
  MessageSquare,
  Minimize2,
  Network,
  Pause,
  PanelRight,
  Pencil,
  Play,
  Plus,
  RotateCw,
  SkipForward,
  Square,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button, ContextMenu, MENU_SEPARATOR, type ContextMenuEntry } from "@crewyard/ui";
import { crewProblems, dependencyRefusal, type CandidateView, type CrewLayout, type CrewMemberView, type CrewProposalEdit, type TaskDetail } from "@crewyard/core";
import { useInspector } from "../../inspector.ts";
import { call, useDaemon } from "../../ipc.ts";
import { useNav } from "../../nav.ts";
import { screens } from "../../registry.ts";
import { actionsFor, handoffCandidates, supersededRuns, type ActionId, type HandoffAsk } from "./actions.ts";
import { CrewBar } from "./CrewBar.tsx";
import { bulkCounts, checkEnv, handoffAsks, pendingSteps, rulesFromRoles, skipDependents } from "./manage.ts";
import { StepPanel, stepIndex } from "./StepPanel.tsx";
import { CrewCanvas } from "./CrewCanvas.tsx";
import { useNodeTitle } from "./CrewNode.tsx";
import { AddStepDialog, ChangeAiDialog, MessageDialog, SkipDialog, StopDialog } from "./Dialogs.tsx";
import { crewFixture, fixtureCandidates, fixtureRoles, type CrewFixture } from "./fixture.ts";
import { MemberStatusLabel, runnerName, TaskStatusLabel, useFormatters } from "./labels.tsx";
import { buildGraph, defaultLayout, memberNodeId, mergeLayout, type GraphNodeModel, type Point } from "./model.ts";
import "@xyflow/react/dist/base.css";
import "./crew.css";
import { matches } from "../../keys.ts";
import { canChooseHandoffStop } from "../tasks/model.ts";

// Crew graph (DESIGN.md §6): one task's crew as a graph. Moving nodes changes only the saved
// layout, never who does the work. Run actions go through the tasks IPC; layouts through crew.*.
// Managing the crew (add, remove or change a step, draw a dependency, order the standby chain,
// skip, follow up, pause all) is a separate explicit call each: crew.edit and its siblings.

// Screenshot mode only: the main process passes query params solely when CREWYARD_SHOT is set.
const query = new URLSearchParams(typeof location === "undefined" ? "" : location.search);
const FIXTURE = query.has("fixture");
const SHOT = {
  menu: query.get("crewMenu"),
  select: query.get("crewSelect"),
  full: query.get("crewFull") === "1",
  list: query.get("crewList") === "1",
  /** A member id whose step editor opens (proposal fixture). */
  panel: query.get("crewPanel"),
  /** `skip:<memberId>` or `add` opens that dialog. */
  dialog: query.get("crewDialog"),
};
const FIXTURES: readonly CrewFixture[] = ["default", "loop", "proposal", "manage"];

const ICONS: Record<ActionId, LucideIcon> = {
  open: PanelRight,
  open_changes: FileDiff,
  open_files: FolderTree,
  message: MessageSquare,
  pause: Pause,
  resume: Play,
  retry: RotateCw,
  change_ai: ArrowLeftRight,
  handoff_now: ArrowLeftRight,
  wait_reset: Hourglass,
  edit: Pencil,
  add_step: Plus,
  add_after: ListPlus,
  remove_step: Trash2,
  skip: SkipForward,
  follow_up: ListPlus,
  pause_all: Pause,
  resume_all: Play,
  copy_run_id: Copy,
  stop: Square,
};

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
    const offRequests = window.crewyard.on("requests.changed", (p) => {
      if ((p as { taskId?: string }).taskId === taskId) void qc.invalidateQueries({ queryKey: ["requests.list", { taskId }] });
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
      offRequests();
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

type Dialog =
  | { kind: "stop" | "message" | "change_ai" | "skip" | "handoff_now"; nodeId: string }
  | { kind: "add_step"; after: string | null; followUp: boolean; target: string | null }
  | null;
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
  const [dialog, setDialog] = useState<Dialog>(() => initialDialog(task));
  const [editing, setEditing] = useState<string | null>(SHOT.panel);
  const [busy, setBusy] = useState(false);
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

  // A step that can still change opens its editor; anything else opens the inspector, as before.
  const onSelect = useCallback(
    (id: string | null) => {
      setSelected(id);
      const n = id ? byId.get(id) : null;
      if (n?.memberId && (model.proposal || byId.get(memberNodeId(n.memberId))?.pending)) setEditing(n.memberId);
      else if (n) openInspector(n);
    },
    [byId, openInspector, model.proposal],
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

  // ---- managing the crew
  const members = useMemo(() => task.crew?.members ?? [], [task.crew]);
  const rolesQ = useDaemon("roles.list", { projectId: task.projectId }, { enabled: !fixture, staleTime: 30_000 });
  const roles = useMemo(() => (fixture ? fixtureRoles() : rolesQ.data?.roles), [fixture, rolesQ.data]);
  const rules = useMemo(() => rulesFromRoles(roles), [roles]);
  const requests = useDaemon("requests.list", { taskId: task.id }, { enabled: !fixture });
  const asks = useMemo(() => handoffAsks(requests.data), [requests.data]);
  const bulk = useMemo(() => bulkCounts(task), [task]);
  const pending = useMemo(() => pendingSteps(task), [task]);
  const env = useMemo(() => checkEnv(task, rules), [task, rules]);
  const editingMember = editing ? (members.find((m) => m.id === editing) ?? null) : null;
  const ranked = useDaemon("crew.candidates", { taskId: task.id, role: editingMember?.role ?? "" }, { enabled: !fixture && !!editingMember });
  const editable = useMemo(() => new Set(members.filter((m) => model.proposal || m.pendingApproval).map((m) => memberNodeId(m.id))), [members, model.proposal]);
  const stepLabel = (m: CrewMemberView) => t("node.memberHead", { step: stepIndex(members, m.step), role: fmt.role(m.role, m.roleTitle) });
  // Unknown roles are only a problem once the role list has loaded.
  const problems = useMemo(() => crewProblems(members, rules).filter((p) => roles || p.code !== "unknown_role"), [members, rules, roles]);
  const problemText = (scope: ReadonlySet<string> | null): string | null => {
    const p = problems.find((x) => !scope || scope.has(x.params.step ?? "") || scope.has(x.params.other ?? ""));
    if (!p) return null;
    const params = { ...p.params, ...(p.params.step ? { step: stepIndex(members, p.params.step) } : {}), ...(p.params.other ? { other: stepIndex(members, p.params.other) } : {}) };
    return t(`edit.why.${p.code}`, { ...params, defaultValue: t(`error.crew.${p.code}`) });
  };

  const failText = (err: unknown) => {
    const code = errorCode(err);
    return t(`error.${code}`, { defaultValue: t("error.generic", { code }) });
  };
  // Every edit returns the task as the daemon now has it, estimate included.
  const edit = async (e: CrewProposalEdit) => {
    if (fixture) return;
    setBusy(true);
    try {
      const detail = await call("crew.edit", { taskId: task.id, edit: e });
      qc.setQueryData(["tasks.get", { taskId: task.id }], detail);
      if (e.kind === "remove_step" && e.memberId === editing) setEditing(null);
      if (e.kind === "add_step") setEditing(detail.crew?.members.at(-1)?.id ?? null);
      const est = detail.crew?.estimate;
      setNotice({ text: t("done.edit", { cost: est ? fmt.cost(est.usd, est.provenance) : t("fact.costUnknown") }), bad: false });
      void qc.invalidateQueries({ queryKey: ["crew.candidates"] });
    } catch (err) {
      setNotice({ text: failText(err), bad: true });
    } finally {
      setBusy(false);
    }
  };
  const crewCall = async <R,>(fn: () => Promise<R>, ok: (r: R) => string) => {
    if (fixture) return;
    setBusy(true);
    try {
      setNotice({ text: ok(await fn()), bad: false });
    } catch (err) {
      setNotice({ text: failText(err), bad: true });
    } finally {
      setBusy(false);
      refresh();
    }
  };
  const approve = () => crewCall(() => call("tasks.approve", { taskId: task.id }), () => t("done.approved"));
  const approveSteps = () => crewCall(() => call("crew.approveSteps", { taskId: task.id }), () => t("done.approvedSteps"));
  const pauseAll = () => crewCall(() => call("crew.pauseAll", { taskId: task.id }), (r) => t("done.pauseAll", { count: r.runIds.length }));
  const resumeAll = () => crewCall(() => call("crew.resumeAll", { taskId: task.id }), (r) => t("done.resumeAll", { count: r.runIds.length }));

  const onConnect = (fromId: string, toId: string) => {
    const source = members.find((m) => m.id === byId.get(fromId)?.memberId);
    const target = members.find((m) => m.id === byId.get(toId)?.memberId);
    if (!target || !source) return;
    // The rule the daemon applies, checked first so a refused drag says why at once.
    const why = dependencyRefusal(members, target, source.step, env);
    if (why) {
      const params = { ...why.params, ...(why.params?.path ? { path: why.params.path.split(" → ").map((x) => stepIndex(members, x)).join(" → ") } : {}) };
      setNotice({ text: t(`edit.why.${why.code}`, { ...params, defaultValue: t(`error.crew.${why.code}`) }), bad: true });
      return;
    }
    void edit({ kind: "add_dependency", memberId: target.id, dependsOn: source.step });
  };
  const removeLabel = (fromId: string, toId: string) => {
    const a = byId.get(fromId);
    const b = byId.get(toId);
    return t("edge.remove", { from: a ? title(a, task.title) : fromId, to: b ? title(b, task.title) : toId });
  };

  const ctx = useMemo(
    () => ({
      resumable: new Set(task.resumableRunIds),
      taskCancelled: !!task.cancelledAt,
      superseded: supersededRuns(task),
      handoffTargets: (memberId: string, profileId: string) => handoffCandidates(task, memberId, profileId).length,
      proposal: model.proposal,
      crewSize: members.length,
      handoffAsk: (runId: string) => asks.get(runId) ?? null,
      bulk,
    }),
    [task, model.proposal, members.length, asks, bulk],
  );

  const menuNode = menu ? byId.get(menu.nodeId) : undefined;
  const menuItems: ContextMenuEntry[] = menuNode
    ? actionsFor(menuNode, ctx).flatMap((group, gi) => [
        ...(gi > 0 ? [MENU_SEPARATOR] : []),
        ...group.map((a) => {
          const Icon = ICONS[a.id];
          return {
            id: a.id,
            label: t(a.id === "retry" && menuNode.run?.endReason === "failed" ? "menu.retry_failed" : `menu.${a.id}`),
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
      case "open_changes":
      case "open_files":
        setSelected(n.id);
        return inspector.open({ taskId: task.id, ...(n.memberId ? { memberId: n.memberId } : {}), ...(n.run ? { runId: n.run.id } : {}), tab: id === "open_changes" ? "changes" : "files" });
      case "edit":
        setSelected(n.id);
        setEditing(n.memberId);
        // Move the keyboard into the editor, which sits after the canvas in tab order.
        requestAnimationFrame(() => document.querySelector<HTMLElement>(".crew-panel select")?.focus());
        return;
      case "add_step":
        return setDialog({ kind: "add_step", after: null, followUp: false, target: null });
      case "add_after":
      case "follow_up": {
        const m = members.find((x) => x.id === n.memberId);
        return setDialog({ kind: "add_step", after: m?.step ?? null, followUp: id === "follow_up", target: title(n, task.title) });
      }
      case "remove_step":
        if (n.memberId) void edit({ kind: "remove_step", memberId: n.memberId });
        return;
      case "skip":
      case "handoff_now":
        return setDialog({ kind: id, nodeId: n.id });
      case "wait_reset": {
        const ask = run ? asks.get(run.id) : undefined;
        if (run && ask)
          void runCall(
            () => call("requests.answer", { requestId: ask.requestId, answer: { kind: "handoff", decision: "wait_for_reset" }, runId: run.id, sessionId: run.nativeSessionId }),
            t("done.waitReset", { target: title(n, task.title) }),
          );
        return;
      }
      case "pause_all":
        return void pauseAll();
      case "resume_all":
        return void resumeAll();
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

  const dialogNode = dialog && "nodeId" in dialog ? byId.get(dialog.nodeId) : undefined;
  const stepCount = members.length;
  const pendingScope = new Set(pending.map((m) => m.step));
  const roleOptions = (roles ?? []).map((r) => ({ id: r.id, label: r.builtin ? fmt.role(r.id) : t("panel.roleFile", { title: r.title }) }));

  const panel = editingMember && (
    <StepPanel
      key={editingMember.id}
      members={members}
      member={editingMember}
      index={stepIndex(members, editingMember.step)}
      ranked={
        fixture
          ? { state: "ready", candidates: fixtureCandidates(editingMember.role) }
          : ranked.isError
            ? { state: "error", candidates: [], error: errorCode(ranked.error) }
            : { state: ranked.data ? "ready" : "loading", candidates: ranked.data ?? [] }
      }
      roles={roles}
      env={env}
      busy={busy}
      onEdit={(e) => void edit(e)}
      onClose={() => {
        const id = editingMember.id;
        setEditing(null);
        document.querySelector<HTMLElement>(`[data-node="${CSS.escape(memberNodeId(id))}"]`)?.focus();
      }}
    />
  );

  return (
    <section className="screen crew" aria-label={t("title")}>
      <div className="page-head">
        <div>
          <h1>{t("title")}</h1>
          <div className="sub lbl">
            {/* The title is the user's own text: no forced uppercase, which would also apply Turkish casing to English words. */}
            <span className="crew-sub-title">{task.title}</span> · {t("sub", { count: stepCount })}
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

      <CrewBar
        proposal={model.proposal}
        steps={stepCount}
        estimate={task.crew?.estimate ?? null}
        problem={model.proposal ? problemText(null) : problemText(pendingScope)}
        bulk={bulk}
        pending={pending.length}
        cancelled={!!task.cancelledAt}
        busy={busy}
        onAddStep={() => setDialog({ kind: "add_step", after: null, followUp: false, target: null })}
        onApprove={() => void approve()}
        onPauseAll={() => void pauseAll()}
        onResumeAll={() => void resumeAll()}
        onApproveSteps={() => void approveSteps()}
      />

      <div className="crew-live" role="status" aria-live="polite">
        {notice && <span className={notice.bad ? "crew-notice bad" : "crew-notice"}>{notice.text}</span>}
      </div>

      {list ? (
        <div className={panel ? "crew-list-wrap with-panel" : "crew-list-wrap"}>
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
                  <td className="mono muted">{n.loop ? fmt.loopLine(fmt.loop(n.loop)) || fmt.fact(n.fact) : fmt.fact(n.fact)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {panel}
        </div>
      ) : (
        <div className={[full ? "crew-frame full" : "crew-frame", panel ? "with-panel" : ""].filter(Boolean).join(" ")}>
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
              editable={fixture ? undefined : editable}
              onConnect={onConnect}
              onRemoveDependency={(dep) => void edit({ kind: "remove_dependency", ...dep })}
              removeLabel={removeLabel}
            />
          </ReactFlowProvider>
          {panel}
          {full && (
            <Button size="sm" className="crew-exit" onClick={() => setFull(false)}>
              {t("full.exit")} <span className="kbd">Esc</span>
            </Button>
          )}
        </div>
      )}
      {!list && <p className="crew-help">{editable.size > 0 ? t("legend.helpEdit") : t("legend.help")}</p>}

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
          live={canChooseHandoffStop(dialogNode.run)}
          onClose={() => setDialog(null)}
          onConfirm={(profileId, stop) =>
            runCall(() => call("runs.handoff", { runId: dialogNode.run!.id, targetProfileId: profileId, ...(stop ? { stop } : {}) }), t("done.handoff", { target: title(dialogNode, task.title) })).then(() => setDialog(null))
          }
        />
      )}
      {dialog?.kind === "add_step" && (
        <AddStepDialog
          title={dialog.followUp && dialog.target ? t("addStep.followTitle", { target: dialog.target }) : t("addStep.title")}
          roles={roleOptions}
          steps={members.filter((m) => !dialog.followUp || m.step === dialog.after).map((m) => ({ step: m.step, label: stepLabel(m) }))}
          after={dialog.after}
          fixedAfter={dialog.followUp}
          note={dialog.followUp ? t("addStep.followNote") : t("addStep.proposalNote")}
          onClose={() => setDialog(null)}
          onConfirm={async (role, after) => {
            await edit({ kind: "add_step", role, after });
            setDialog(null);
            if (dialog.followUp) setNotice({ text: t("done.followUp"), bad: false });
          }}
        />
      )}
      {dialog?.kind === "skip" && dialogNode?.memberId && (
        <SkipDialog
          target={title(dialogNode, task.title)}
          dependents={skipDependents(task, dialogNode.memberId).map(stepLabel)}
          onClose={() => setDialog(null)}
          onConfirm={() => crewCall(() => call("crew.skip", { taskId: task.id, memberId: dialogNode.memberId! }), () => t("done.skip", { target: title(dialogNode, task.title) })).then(() => setDialog(null))}
        />
      )}
      {dialog?.kind === "handoff_now" && dialogNode?.run && asks.get(dialogNode.run.id) && (
        <ChangeAiDialog
          target={title(dialogNode, task.title)}
          title={t("handoffNow.title", { target: title(dialogNode, task.title) })}
          body={t("handoffNow.body")}
          candidates={askCandidates(asks.get(dialogNode.run.id)!)}
          runnerLabel={(r) => runnerName(t, r)}
          live={false}
          onClose={() => setDialog(null)}
          onConfirm={(profileId) =>
            runCall(
              () =>
                call("requests.answer", {
                  requestId: asks.get(dialogNode.run!.id)!.requestId,
                  answer: { kind: "handoff", decision: "hand_off", targetProfileId: profileId },
                  runId: dialogNode.run!.id,
                  sessionId: dialogNode.run!.nativeSessionId,
                }),
              t("done.handoff", { target: title(dialogNode, task.title) }),
            ).then(() => setDialog(null))
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

/** The proposed target first, then the other standby candidates that passed preflight. */
function askCandidates(ask: HandoffAsk): CandidateView[] {
  const seen = new Set<string>();
  return [ask.proposed, ...ask.candidates].filter((c): c is CandidateView => {
    if (!c || seen.has(c.profileId)) return false;
    seen.add(c.profileId);
    return true;
  });
}

/** Screenshot mode can open the Add step or Skip dialog. */
function initialDialog(task: TaskDetail): Dialog {
  if (SHOT.dialog === "add") return { kind: "add_step", after: null, followUp: false, target: null };
  const skip = SHOT.dialog?.startsWith("skip:") ? SHOT.dialog.slice(5) : null;
  return skip && task.crew?.members.some((m) => m.id === skip) ? { kind: "skip", nodeId: memberNodeId(skip) } : null;
}

export function CrewScreen() {
  const { t } = useTranslation("crew");
  const projectId = useNav((s) => s.projectId);
  const taskId = useNav((s) => s.taskId);
  const selectTask = useNav((s) => s.selectTask);
  useCrewLive(FIXTURE ? null : taskId);
  const q = useDaemon("tasks.get", { taskId: taskId ?? "" }, { enabled: !FIXTURE && !!taskId });
  const [fixture] = useState(() => {
    if (!FIXTURE) return null;
    const v = query.get("fixture") as CrewFixture | null;
    return crewFixture(v && FIXTURES.includes(v) ? v : "default");
  });

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
