import { Notification } from "electron";
import type { AssistantTopics, IpcMethod, IpcParams, IpcResult, LimitNoticePayload, NotificationSettings, RequestView, TasksTopics } from "@crewyard/core";
import type { Translate } from "../i18n.ts";
import {
  activationArgs,
  AutopilotBatches,
  AUTOPILOT_BATCH_MS,
  decideAction,
  emptyToastState,
  limitToast,
  parseActivation,
  requestToast,
  requestToastPlan,
  suppression,
  ToastGrants,
  toastXml,
  type ToastAction,
  type ToastTarget,
} from "./rules.ts";

// Windows toasts from the main process (PLAN.md §7.3, §11), shown through Electron's `toastXml`
// with foreground activation. Every press comes back through Notification.handleActivation, also
// after a restart or from the Action Center, as the raw `launch` / `arguments` string. A press
// only acts with an unspent grant for that exact toast, and only after the request is read again
// from the daemon; anything else just opens the item.

type Call = <M extends IpcMethod>(method: M, params: IpcParams<M>) => Promise<IpcResult<M>>;

export interface ToasterDeps {
  call: Call;
  settings(): NotificationSettings | null;
  t(): Translate;
  locale(): string;
  /** Brings the window forward on a screen; null only focuses it. */
  open(target: ToastTarget | null): void;
  /** "basic" off Windows: title and text only (platform.ts). Windows toasts when absent. */
  style?: "toast" | "basic";
}

const BUTTON_KEY: Record<ToastAction, string> = { approve: "button.approve", open: "button.open", handoff: "button.handoff", wait: "button.wait" };

export class Toaster {
  private readonly seen = emptyToastState();
  private readonly grants = new ToastGrants();
  /** Shown toasts, held until Windows closes them so their events stay wired. */
  private readonly live = new Set<Notification>();

  constructor(private readonly deps: ToasterDeps) {}

  /** Fed every daemon event; reacts to the request, limit and Autopilot topics only. */
  onEvent(topic: string, payload: unknown): void {
    if (topic === "requests.changed") void this.onRequest(payload as TasksTopics["requests.changed"]).catch(() => undefined);
    else if (topic === "limits.notice") void this.onLimit(payload as LimitNoticePayload).catch(() => undefined);
    else if (topic === "autopilot.changed") this.onAutopilot(payload as AssistantTopics["autopilot.changed"]);
  }

  private readonly autopilot = new AutopilotBatches();

  private onAutopilot(ev: AssistantTopics["autopilot.changed"]): void {
    const projectId = ev.projectId;
    if (!projectId) return;
    const target: ToastTarget = { screen: "tasks", projectId, taskId: null, requestId: null };
    const quiet = () => {
      const s = this.deps.settings();
      return !s || suppression(s, projectId, new Date()) !== null;
    };
    if (ev.halted) {
      if (quiet()) return;
      const t = this.deps.t();
      this.show({ title: t("toast.autopilotHaltedTitle"), lines: [t("toast.autopilotHalted")], launch: activationArgs("open", null, target), buttons: [] });
      return;
    }
    if (ev.action?.outcome !== "done" || !this.autopilot.add(projectId)) return;
    const timer = setTimeout(() => {
      const n = this.autopilot.flush(projectId);
      if (n === 0 || quiet()) return;
      const t = this.deps.t();
      this.show({ title: t("toast.autopilotTitle"), lines: [t(n === 1 ? "toast.autopilotOne" : "toast.autopilotMany", { count: n })], launch: activationArgs("open", null, target), buttons: [] });
    }, AUTOPILOT_BATCH_MS);
    timer.unref?.();
  }

  async activate(raw: string): Promise<void> {
    const a = parseActivation(raw);
    if (!a) return this.deps.open(null);
    if (a.action !== "open" && a.token) {
      const grant = this.grants.redeem(a.token, a.action);
      const s = this.deps.settings();
      if (grant && s) {
        try {
          const [open, policy] = await Promise.all([this.deps.call("requests.list", { taskId: grant.taskId }), this.deps.call("settings.toastPolicy", { projectId: grant.projectId })]);
          const answer = decideAction(grant, a.action, open.find((r) => r.id === grant.requestId), s, policy.toastApprovals);
          if (answer) {
            await this.deps.call("requests.answer", { requestId: grant.requestId, answer, runId: grant.runId, sessionId: grant.sessionId });
            return;
          }
        } catch {
          // The daemon refused or is restarting: fall through and show the item instead.
        }
      }
    }
    this.deps.open(a.target);
  }

  /** A plain toast without buttons, for the Settings screen's test and the close-to-tray hint. */
  plain(titleKey: string, bodyKey: string): void {
    const t = this.deps.t();
    this.show({ title: t(titleKey), lines: [t(bodyKey)], launch: activationArgs("open", null, { screen: "tasks", projectId: null, taskId: null, requestId: null }), buttons: [] });
  }

  private time(iso: string): string {
    return new Intl.DateTimeFormat(this.deps.locale(), { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  }

  private async onRequest(ev: TasksTopics["requests.changed"]): Promise<void> {
    if (!ev.open) {
      this.grants.revokeRequest(ev.requestId);
      return;
    }
    if (!requestToast(this.seen, ev)) return;
    const s = this.deps.settings();
    if (!s || suppression(s, ev.projectId, new Date())) return;
    const [open, task, policy] = await Promise.all([
      this.deps.call("requests.list", { taskId: ev.taskId }),
      this.deps.call("tasks.get", { taskId: ev.taskId }),
      this.deps.call("settings.toastPolicy", { projectId: ev.projectId }),
    ]);
    const req = open.find((r) => r.id === ev.requestId);
    if (!req) return;
    const plan = requestToastPlan(req, s, policy.toastApprovals);
    const target: ToastTarget = { screen: "inbox", projectId: req.projectId, taskId: req.taskId, requestId: req.id };
    const acting = plan.actions.some((x) => x !== "open");
    const grant = acting ? this.grants.issue({ requestId: req.id, runId: req.runId, sessionId: req.sessionId, taskId: req.taskId, projectId: req.projectId, actions: plan.actions, targetProfileId: plan.targetProfileId }) : null;
    const t = this.deps.t();
    const { title, lines } = this.describe(req, plan.kind, task.title, t);
    this.show({
      title,
      lines,
      launch: activationArgs("open", null, target),
      buttons: plan.actions.map((action) => ({ label: t(BUTTON_KEY[action]), args: activationArgs(action, action === "open" ? null : (grant?.token ?? null), target) })),
    });
  }

  private describe(req: RequestView, kind: ReturnType<typeof requestToastPlan>["kind"], taskTitle: string, t: Translate): { title: string; lines: string[] } {
    const p = req.payload;
    if (p.kind === "approval") {
      const what = p.command ?? (p.network ? t("toast.network") : p.paths[0] ? t("toast.paths", { path: p.paths[0] }) : "");
      return { title: t(`toast.approvalTitle.${req.risk ?? "unknown"}`), lines: [taskTitle, what].filter(Boolean) };
    }
    if (p.kind === "question") return { title: t("toast.questionTitle"), lines: [taskTitle, p.questions[0]?.prompt ?? ""].filter(Boolean) };
    if (kind === "limit") {
      const window = p.window ? t(`window.${p.window}`) : t("toast.limitTitle");
      return { title: t("toast.limitTitle"), lines: [taskTitle, p.resetsAt ? t("toast.limitResets", { window, time: this.time(p.resetsAt) }) : t("toast.limitNoReset", { window })] };
    }
    if (kind === "budget") return { title: t("toast.budgetTitle"), lines: [taskTitle, t("toast.budgetBody")] };
    return { title: t("toast.handoffTitle"), lines: [taskTitle] };
  }

  private async onLimit(n: LimitNoticePayload): Promise<void> {
    const level = limitToast(this.seen, n);
    const s = this.deps.settings();
    if (!level || !s) return;
    const task = n.taskId ? await this.deps.call("tasks.get", { taskId: n.taskId }).catch(() => null) : null;
    if (suppression(s, task?.projectId ?? null, new Date())) return;
    const t = this.deps.t();
    const window = t(`window.${n.window}`);
    const target: ToastTarget = task ? { screen: "tasks", projectId: task.projectId, taskId: task.id, requestId: null } : { screen: "limits", projectId: null, taskId: null, requestId: null };
    const usage = n.usedPct === null ? t("toast.limitUnknown", { window }) : t("toast.limitPct", { window, pct: Math.round(n.usedPct) });
    this.show({ title: t(`toast.${level}Title`), lines: task ? [task.title, usage] : [usage], launch: activationArgs("open", null, target), buttons: [] });
  }

  private show(content: Parameters<typeof toastXml>[0]): void {
    if (!Notification.isSupported()) return;
    // Linux and macOS (docs/adr/0010): no toast XML and no buttons; a click opens the item, as
    // pressing a toast's body does, so nothing is answered from outside the app there.
    const basic = this.deps.style === "basic";
    const n = basic ? new Notification({ title: content.title, body: content.lines.join("\n") }) : new Notification({ toastXml: toastXml(content) });
    if (basic) n.on("click", () => void this.activate(content.launch));
    this.live.add(n);
    const drop = () => this.live.delete(n);
    n.on("close", drop);
    n.on("failed", drop);
    n.show();
  }
}
