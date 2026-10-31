import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GoalDetail, IpcMethod, NotificationSettings, RequestView, TaskDetail } from "@crewyard/core";
import { translator } from "../i18n.ts";
import { Toaster } from "./toaster.ts";

// The Electron side of goal toasts (design §3.6): the toaster reads the goal again before it
// decides, raises each goal toast once, never repeats them after a daemon start, opens the goal it
// names, and labels a goal task's request with its goal.

const h = vi.hoisted(() => ({ shown: [] as Array<{ toastXml?: string; title?: string; body?: string }> }));

vi.mock("electron", () => ({
  Notification: class {
    static isSupported() {
      return true;
    }
    constructor(private readonly opts: { toastXml?: string; title?: string; body?: string }) {}
    on() {
      return this;
    }
    show() {
      h.shown.push(this.opts);
    }
  },
}));

const settings: NotificationSettings = { enabled: true, quietHours: { enabled: false, start: "22:00", end: "08:00" }, mutedProjects: [], approveFromToast: true, limitActions: true };

const goal = (over: Partial<GoalDetail> = {}) => ({ id: "goal_1", projectId: "p1", title: "Geçiş anahtarları", status: "needs_you", reason: "plan_ready", outcome: null, ...over }) as GoalDetail;

function toaster(answers: Partial<Record<IpcMethod, unknown>>) {
  const calls: string[] = [];
  const call = vi.fn(async (method: IpcMethod) => {
    calls.push(method);
    if (!(method in answers)) throw new Error(`unexpected ${method}`);
    return answers[method];
  });
  const opened: unknown[] = [];
  const t = new Toaster({ call: call as never, settings: () => settings, t: () => translator("en"), locale: () => "en", open: (x) => opened.push(x) });
  return { t, calls, opened };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  h.shown.length = 0;
});

describe("Toaster goal toasts", () => {
  it("reads the goal again, toasts once when it first needs you, and the toast opens that goal", async () => {
    const { t, calls } = toaster({ "goals.get": goal() });
    t.onEvent("goals.changed", { goalId: "goal_1", projectId: "p1", status: "needs_you", cause: "planned" });
    await flush();
    expect(calls).toEqual(["goals.get"]);
    expect(h.shown).toHaveLength(1);
    expect(h.shown[0]!.toastXml).toContain("Geçiş anahtarları: needs you");
    expect(h.shown[0]!.toastXml).toContain("The plan is ready for you to review.");
    expect(h.shown[0]!.toastXml).toContain("g=goal_1");
    // The same goal needing you again, for any reason, never reads or toasts again.
    t.onEvent("goals.changed", { goalId: "goal_1", projectId: "p1", status: "needs_you", cause: "decision" });
    await flush();
    expect(calls).toEqual(["goals.get"]);
    expect(h.shown).toHaveLength(1);
  });

  it("a press on a goal toast opens the Tasks screen on that goal", async () => {
    const { t, opened } = toaster({});
    await t.activate("crewyard-toast?a=open&s=tasks&p=p1&g=goal_1");
    expect(opened).toEqual([{ screen: "tasks", projectId: "p1", taskId: null, requestId: null, goalId: "goal_1" }]);
  });

  it("raises nothing on a launch for goals that finished, wait for review or needed you before it", async () => {
    const { t, calls } = toaster({ "goals.get": goal({ status: "finished", reason: null, outcome: "merged" }) });
    t.onEvent("daemon.ready", { pid: 1 });
    t.onEvent("goals.changed", { goalId: "goal_1", projectId: "p1", status: "finished", cause: "released" });
    t.onEvent("goals.changed", { goalId: "goal_2", projectId: "p1", status: "ready_for_review", cause: "released" });
    t.onEvent("goals.changed", { goalId: "goal_3", projectId: "p1", status: "needs_you", cause: "released" });
    await flush();
    expect(calls).toEqual([]);
    expect(h.shown).toHaveLength(0);
  });

  it("toasts ready for a pull request when the runner announces it", async () => {
    const { t } = toaster({ "goals.get": goal({ status: "ready_for_review", reason: null }) });
    t.onEvent("goals.changed", { goalId: "goal_1", projectId: "p1", status: "ready_for_review", cause: "finished" });
    await flush();
    expect(h.shown[0]!.toastXml).toContain("Geçiş anahtarları: ready for a pull request");
  });
});

describe("Toaster goal task requests", () => {
  it("labels a goal task's request with its goal and number", async () => {
    const req: RequestView = {
      id: "q1",
      taskId: "t2",
      projectId: "p1",
      runId: "run1",
      sessionId: null,
      kind: "approval",
      risk: "high",
      payload: { kind: "approval", toolCallId: null, command: "pnpm add @simplewebauthn/server", cwd: "C:\\Projeler\\my app", paths: [], network: true, policy: null },
      createdAt: "2026-10-31T10:00:00.000Z",
      answeredAt: null,
      answer: null,
      answeredBy: null,
    };
    const task = { id: "t2", projectId: "p1", title: "Sunucu", goal: { goalId: "goal_1", key: "k2", number: 2, waiting: false, hold: null, joined: false, hidden: false } } as unknown as TaskDetail;
    const { t, calls } = toaster({ "requests.list": [req], "tasks.get": task, "settings.toastPolicy": { toastApprovals: "none" }, "goals.get": goal() });
    t.onEvent("requests.changed", { requestId: "q1", taskId: "t2", projectId: "p1", open: true });
    await flush();
    await flush();
    expect(calls).toContain("goals.get");
    expect(h.shown[0]!.toastXml).toContain("Geçiş anahtarları · 02 Sunucu");
  });
});
