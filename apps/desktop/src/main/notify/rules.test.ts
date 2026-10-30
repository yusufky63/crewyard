import { describe, expect, it } from "vitest";
import type { CandidateView, LimitNoticePayload, NotificationSettings, RequestPayload, RequestView } from "@crewyard/core";
import {
  activationArgs,
  decideAction,
  emptyToastState,
  escapeXml,
  GRANT_TTL_MS,
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

const settings = (over: Partial<NotificationSettings> = {}): NotificationSettings => ({
  enabled: true,
  quietHours: { enabled: false, start: "22:00", end: "08:00" },
  mutedProjects: [],
  approveFromToast: true,
  limitActions: true,
  ...over,
});

const notice = (over: Partial<LimitNoticePayload>): LimitNoticePayload => ({ kind: "warn", profileId: "a", window: "5h", usedPct: 82, resetsAt: "2026-10-30T15:00:00.000Z", provenance: "reported", minutesUntilFull: null, runId: "r2", taskId: "t", observedAt: "2026-10-30T10:05:00.000Z", ...over });

const cand = (profileId: string): CandidateView => ({
  profileId,
  alias: profileId,
  runner: "codex",
  providerId: "openai",
  model: null,
  score: 1,
  headroom: { pct: 80, window: "5h", provenance: "reported" },
  estimate: { usd: null, provenance: "unknown" },
  reasons: [],
});

const approval: RequestPayload = { kind: "approval", toolCallId: "c1", command: "pnpm test", cwd: "C:\\wt", paths: [], network: false, policy: null };
const limitPause = (over: Partial<Extract<RequestPayload, { kind: "handoff" }>> = {}): RequestPayload => ({
  kind: "handoff",
  trigger: "limit",
  window: "5h",
  resetsAt: "2026-10-30T16:40:00.000Z",
  proposedTarget: cand("backup"),
  candidates: [cand("backup")],
  detail: null,
  ...over,
});

const req = (payload: RequestPayload, over: Partial<RequestView> = {}): RequestView => ({
  id: "q1",
  taskId: "t1",
  projectId: "p1",
  runId: "r1",
  sessionId: "s1",
  kind: payload.kind,
  risk: payload.kind === "approval" ? "low" : null,
  payload,
  createdAt: "2026-10-30T10:00:00.000Z",
  answeredAt: null,
  answer: null,
  answeredBy: null,
  ...over,
});

const at = (hhmm: string) => new Date(`2026-10-30T${hhmm}:00`);

describe("dedup and hysteresis", () => {
  it("raises one toast per crossing and re-arms only after the window resets or drops under 70%", () => {
    const s = emptyToastState();
    expect(limitToast(s, notice({ usedPct: 82 }))).toBe("warn");
    expect(limitToast(s, notice({ usedPct: 85 }))).toBeNull();
    expect(limitToast(s, notice({ kind: "critical", usedPct: 96 }))).toBe("critical");
    expect(limitToast(s, notice({ kind: "critical", usedPct: 97 }))).toBeNull();
    // A new window instance re-arms.
    expect(limitToast(s, notice({ usedPct: 81, resetsAt: "2026-10-30T20:00:00.000Z" }))).toBe("warn");
    expect(limitToast(s, notice({ kind: "ahead_of_pace" }))).toBeNull();
    // Limit reached arrives as a handoff request, which has its own toast.
    expect(limitToast(s, notice({ kind: "reached", usedPct: 100 }))).toBeNull();
    // Context windows belong to one run each.
    expect(limitToast(s, notice({ window: "context", runId: "x", resetsAt: null }))).toBe("warn");
    expect(limitToast(s, notice({ window: "context", runId: "y", resetsAt: null }))).toBe("warn");
  });

  it("toasts a request once, when it opens", () => {
    const s = emptyToastState();
    const ev = { requestId: "q", taskId: "t", projectId: "p", open: true };
    expect(requestToast(s, ev)).toBe(true);
    expect(requestToast(s, ev)).toBe(false);
    expect(requestToast(s, { ...ev, requestId: "q2", open: false })).toBe(false);
  });
});

describe("mute and quiet hours", () => {
  it("says why a toast is held back: off, muted project, then quiet hours", () => {
    const quiet = { enabled: true, start: "22:00", end: "08:00" };
    expect(suppression(settings(), "p1", at("10:00"))).toBeNull();
    expect(suppression(settings({ enabled: false }), "p1", at("10:00"))).toBe("disabled");
    expect(suppression(settings({ mutedProjects: ["p1"] }), "p1", at("10:00"))).toBe("muted");
    expect(suppression(settings({ mutedProjects: ["p1"] }), "p2", at("10:00"))).toBeNull();
    // Account-wide limit notices belong to no project, so project mute never hides them.
    expect(suppression(settings({ mutedProjects: ["p1"] }), null, at("10:00"))).toBeNull();
    expect(suppression(settings({ quietHours: quiet }), "p1", at("23:00"))).toBe("quiet");
  });
});

describe("toast buttons per risk", () => {
  it("offers Approve once only for low risk", () => {
    expect(requestToastPlan(req(approval, { risk: "low" }), settings(), "low").actions).toEqual(["approve", "open"]);
    expect(requestToastPlan(req(approval, { risk: "medium" }), settings(), "low").actions).toEqual(["open"]);
    expect(requestToastPlan(req(approval, { risk: "high" }), settings(), "low").actions).toEqual(["open"]);
    expect(requestToastPlan(req(approval, { risk: null }), settings(), "low").actions).toEqual(["open"]);
    expect(requestToastPlan(req(approval, { risk: "low" }), settings({ approveFromToast: false }), "low").actions).toEqual(["open"]);
    // The project's own rule (.crewyard/project.json `toastApprovals: "none"`) wins over the app setting.
    expect(requestToastPlan(req(approval, { risk: "low" }), settings(), "none").actions).toEqual(["open"]);
  });

  it("questions always open the Inbox", () => {
    const q: RequestPayload = { kind: "question", questions: [{ prompt: "Which branch?", options: [{ label: "main" }], allowFreeText: true }] };
    expect(requestToastPlan(req(q), settings(), "low").actions).toEqual(["open"]);
  });

  it("a limit pause offers Hand off and Wait for reset only when each can work", () => {
    expect(requestToastPlan(req(limitPause()), settings(), "low")).toEqual({ kind: "limit", actions: ["handoff", "wait", "open"], targetProfileId: "backup" });
    expect(requestToastPlan(req(limitPause({ proposedTarget: null })), settings(), "low").actions).toEqual(["wait", "open"]);
    expect(requestToastPlan(req(limitPause({ resetsAt: null })), settings(), "low").actions).toEqual(["handoff", "open"]);
    expect(requestToastPlan(req(limitPause()), settings({ limitActions: false }), "low")).toEqual({ kind: "limit", actions: ["open"], targetProfileId: null });
    expect(requestToastPlan(req(limitPause({ trigger: "budget" })), settings(), "low").kind).toBe("budget");
    expect(requestToastPlan(req(limitPause({ trigger: "budget" })), settings(), "low").actions).toEqual(["open"]);
    expect(requestToastPlan(req(limitPause({ trigger: "handoff_failed" })), settings(), "low").actions).toEqual(["open"]);
  });
});

describe("activation validation", () => {
  const grantFor = (g: ToastGrants, actions: ToastAction[] = ["approve", "open"], targetProfileId: string | null = null) =>
    g.issue({ requestId: "q1", runId: "r1", sessionId: "s1", taskId: "t1", projectId: "p1", actions, targetProfileId });

  it("redeems a token once, only for an action its toast offered, and only before it expires", () => {
    let now = 1_000;
    const g = new ToastGrants(() => now);
    const a = grantFor(g);
    expect(a.token).toMatch(/^[0-9a-f]{32}$/);
    expect(g.redeem(a.token, "approve")?.requestId).toBe("q1");
    expect(g.redeem(a.token, "approve")).toBeNull();

    // A button the toast never showed spends the token and does nothing.
    const b = grantFor(g, ["open"]);
    expect(g.redeem(b.token, "approve")).toBeNull();
    expect(g.redeem(b.token, "open")).toBeNull();

    const c = grantFor(g);
    now += GRANT_TTL_MS;
    expect(g.redeem(c.token, "approve")).toBeNull();
    expect(g.redeem("0".repeat(32), "approve")).toBeNull();
  });

  it("drops a request's tokens once it is answered elsewhere", () => {
    const g = new ToastGrants();
    const a = grantFor(g);
    g.revokeRequest("q1");
    expect(g.redeem(a.token, "approve")).toBeNull();
    expect(g.size).toBe(0);
  });

  it("re-checks the request as it is now before acting", () => {
    const g = new ToastGrants();
    const grant = grantFor(g);
    expect(decideAction(grant, "approve", req(approval), settings(), "low")).toEqual({ kind: "approval", decision: "allow_once" });
    // Gone, answered, re-classified, a different request, or the setting switched off: open only.
    expect(decideAction(grant, "approve", undefined, settings(), "low")).toBeNull();
    expect(decideAction(grant, "approve", req(approval, { answeredAt: "2026-10-30T10:01:00.000Z" }), settings(), "low")).toBeNull();
    expect(decideAction(grant, "approve", req(approval, { risk: "medium" }), settings(), "low")).toBeNull();
    expect(decideAction(grant, "approve", req(approval, { id: "q2" }), settings(), "low")).toBeNull();
    expect(decideAction(grant, "approve", req(approval), settings({ approveFromToast: false }), "low")).toBeNull();
    expect(decideAction(grant, "approve", req(approval), settings(), "none")).toBeNull();
    expect(decideAction(grant, "approve", req(limitPause()), settings(), "low")).toBeNull();
  });

  it("hands off only to the target the toast showed, and waits only with a known reset", () => {
    const g = new ToastGrants();
    const grant = grantFor(g, ["handoff", "wait", "open"], "backup");
    expect(decideAction(grant, "handoff", req(limitPause()), settings(), "low")).toEqual({ kind: "handoff", decision: "hand_off", targetProfileId: "backup" });
    expect(decideAction(grant, "handoff", req(limitPause({ proposedTarget: cand("other") })), settings(), "low")).toBeNull();
    expect(decideAction(grant, "wait", req(limitPause()), settings(), "low")).toEqual({ kind: "handoff", decision: "wait_for_reset" });
    expect(decideAction(grant, "wait", req(limitPause({ resetsAt: null })), settings(), "low")).toBeNull();
    expect(decideAction(grant, "wait", req(limitPause({ trigger: "budget" })), settings(), "low")).toBeNull();
    expect(decideAction(grant, "handoff", req(limitPause()), settings({ limitActions: false }), "low")).toBeNull();
    expect(decideAction(grant, "open", req(limitPause()), settings(), "low")).toBeNull();
  });

  it("round-trips activation strings and rejects anything malformed", () => {
    const target: ToastTarget = { screen: "inbox", projectId: "p-1", taskId: "t_1", requestId: "q1" };
    const token = "a".repeat(32);
    expect(parseActivation(activationArgs("approve", token, target))).toEqual({ action: "approve", token, target });
    expect(parseActivation(activationArgs("open", null, { ...target, requestId: null }))).toEqual({ action: "open", token: null, target: { ...target, requestId: null } });
    expect(parseActivation("crewyard://approve?r=q1")).toBeNull();
    expect(parseActivation("crewyard-toast?a=merge&s=inbox")).toBeNull();
    expect(parseActivation("crewyard-toast?a=approve&s=settings")).toBeNull();
    expect(parseActivation(undefined)).toBeNull();
    // A forged token shape is dropped; ids that are not plain ids are dropped.
    expect(parseActivation("crewyard-toast?a=approve&s=inbox&t=XYZ&p=..%5C..&r=q1")).toEqual({ action: "approve", token: null, target: { screen: "inbox", projectId: null, taskId: null, requestId: "q1" } });
  });
});

describe("toast XML", () => {
  it("escapes every text and attribute and drops control characters", () => {
    const xml = toastXml({
      title: 'Approve "rm" <now> & go',
      lines: ["task\u0007 one", "echo '<x>'"],
      launch: 'crewyard-toast?a=open&s=inbox"',
      buttons: [{ label: "Approve <once>", args: "crewyard-toast?a=approve&t=1" }],
    });
    expect(escapeXml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;");
    expect(xml).toContain("<text>Approve &quot;rm&quot; &lt;now&gt; &amp; go</text>");
    expect(xml).toContain("<text>task one</text>");
    expect(xml).toContain('launch="crewyard-toast?a=open&amp;s=inbox&quot;"');
    expect(xml).toContain('<action content="Approve &lt;once&gt;" arguments="crewyard-toast?a=approve&amp;t=1" activationType="foreground"/>');
    expect(xml.includes(String.fromCharCode(7))).toBe(false);
  });

  it("leaves out the actions element when there are no buttons, and keeps at most five", () => {
    expect(toastXml({ title: "t", lines: [], launch: "x", buttons: [] })).not.toContain("<actions>");
    const many = Array.from({ length: 7 }, (_, i) => ({ label: `b${i}`, args: `a${i}` }));
    expect(toastXml({ title: "t", lines: [], launch: "x", buttons: many }).match(/<action /g)).toHaveLength(5);
  });
});
