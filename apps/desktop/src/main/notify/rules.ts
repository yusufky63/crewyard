import { randomBytes } from "node:crypto";
import { EMPTY_ALERT, evaluate, inQuietHours, type AlertState, type GoalChangeCause, type GoalNeedsReason, type GoalOutcome, type GoalStatus, type LimitNoticePayload, type NotificationSettings, type RequestAnswer, type RequestView, type TasksTopics } from "@crewyard/core";

// What becomes a Windows toast, which buttons it carries, and whether a button press may act
// (PLAN.md §7.3, §11). Pure, so every rule has a test; toaster.ts does the Electron part.

// ---------------------------------------------------------------------------------------------
// Dedup and hysteresis. Limit notices go through the same `evaluate` as the daemon: one toast per
// crossing of warn and of critical, re-armed only after the window resets or drops under the
// re-arm line. A repeated or replayed notice never toasts twice. Requests toast once, when they open.

export interface ToastState {
  alerts: Map<string, AlertState>;
  requests: Set<string>;
  /** Goal toasts already raised, per goal (see goalToast). */
  goals: Map<string, Set<GoalToastKind>>;
}

export const emptyToastState = (): ToastState => ({ alerts: new Map(), requests: new Set(), goals: new Map() });

/** The context window belongs to one run; plan windows belong to the account. */
const alertKey = (n: LimitNoticePayload) => `${n.profileId}|${n.window}|${n.window === "context" ? (n.runId ?? "") : ""}`;

export function limitToast(state: ToastState, n: LimitNoticePayload): "warn" | "critical" | null {
  if (n.kind !== "warn" && n.kind !== "critical") return null;
  const key = alertKey(n);
  const { state: next, notices } = evaluate(state.alerts.get(key) ?? EMPTY_ALERT, {
    profileId: n.profileId,
    window: n.window,
    usedPct: n.usedPct,
    resetsAt: n.resetsAt,
    provenance: n.provenance,
    observedAt: n.observedAt,
  });
  state.alerts.set(key, next);
  return notices.find((x) => x.kind === n.kind)?.kind ?? null;
}

export function requestToast(state: ToastState, ev: TasksTopics["requests.changed"]): boolean {
  if (!ev.open || state.requests.has(ev.requestId)) return false;
  state.requests.add(ev.requestId);
  return true;
}

// ---------------------------------------------------------------------------------------------
// Autopilot (docs/adr/0017). Its calls come in bursts (create, approve, queue), so they are batched:
// the first action in a project opens a window, and one toast at its end counts what happened. A
// refusal is in the log, not a toast. A halt toasts at once: Autopilot stopped and waits for you.

export const AUTOPILOT_BATCH_MS = 30_000;

export class AutopilotBatches {
  private readonly open = new Map<string, number>();

  /** Counts an allowed action; true when it opened a new window (the caller schedules the flush). */
  add(projectId: string): boolean {
    const n = this.open.get(projectId);
    this.open.set(projectId, (n ?? 0) + 1);
    return n === undefined;
  }

  /** Ends the project's window; the number of actions in it. */
  flush(projectId: string): number {
    const n = this.open.get(projectId) ?? 0;
    this.open.delete(projectId);
    return n;
  }
}

// ---------------------------------------------------------------------------------------------
// Orchestra goals (docs/adr/0019, design §3.6). A goal toasts at most once for each of: the first
// time it needs you, its last review passing ("ready for a pull request"), a halt, and finishing.
// Its tasks raise no toast of their own when they finish (Orca #30058): Crewyard has no per-task
// "done" toast at all, and `toastTopic` keeps it so, since `tasks.changed` never toasts. A goal
// task's Inbox request still toasts as any request does, labelled with its goal, so a goal that
// needs you because of a request leaves the request's toast to say it.

export type GoalToastKind = "needs_you" | "ready" | "halted" | "finished";

/** The topics that may raise a toast; every other daemon event, task changes included, never does. */
export type ToastTopic = "request" | "limit" | "autopilot" | "goal";

export function toastTopic(topic: string): ToastTopic | null {
  switch (topic) {
    case "requests.changed":
      return "request";
    case "limits.notice":
      return "limit";
    case "autopilot.changed":
      return "autopilot";
    case "goals.changed":
      return "goal";
    default:
      return null;
  }
}

/** A goal change worth reading the goal for: only these statuses can toast, and only once each. */
export function goalMayToast(state: ToastState, ev: { goalId: string; status: GoalStatus; cause: GoalChangeCause }): boolean {
  if (ev.cause === "collapsed") return false;
  const fired = state.goals.get(ev.goalId);
  // A halt may still come after the first "needs you"; goalToast decides on the goal as it is.
  if (ev.status === "needs_you") return !(fired?.has("needs_you") && fired.has("halted"));
  if (ev.status === "ready_for_review") return !fired?.has("ready");
  if (ev.status === "finished") return !fired?.has("finished");
  return false;
}

/** Most goals a toast state remembers; the oldest are dropped first, as the grants are. */
const MAX_GOALS = 500;

/**
 * Which toast a goal raises now, recording it so it never raises the same kind twice. Reads the
 * goal as the daemon has it now (status, reason, outcome), never the event's word alone.
 */
export function goalToast(state: ToastState, goalId: string, g: { status: GoalStatus; reason: GoalNeedsReason | null; outcome: GoalOutcome | null }): GoalToastKind | null {
  const fired = state.goals.get(goalId) ?? new Set<GoalToastKind>();
  let kind: GoalToastKind | null = null;
  if (g.status === "needs_you") {
    if (g.reason === "halted") kind = fired.has("halted") ? null : "halted";
    // The request toasts on its own; the goal's first "needs you" stays for something only the goal says.
    else if (g.reason !== "request") kind = fired.has("needs_you") ? null : "needs_you";
  } else if (g.status === "ready_for_review") kind = fired.has("ready") ? null : "ready";
  else if (g.status === "finished" && g.outcome !== "collapsed") kind = fired.has("finished") ? null : "finished";
  if (kind === null) return null;
  fired.add(kind);
  // A halt is the goal needing you; it is its first time too.
  if (kind === "halted") fired.add("needs_you");
  state.goals.delete(goalId);
  state.goals.set(goalId, fired);
  while (state.goals.size > MAX_GOALS) state.goals.delete(state.goals.keys().next().value as string);
  return kind;
}

/** "01": a goal task's number as the toast's goal label shows it ("Passkeys · 02 Server"). */
export const goalTaskNumber = (n: number) => String(n).padStart(2, "0");

// ---------------------------------------------------------------------------------------------
// Quiet hours (inQuietHours, in core) and mute. Suppressed toasts are dropped, not queued: the Inbox and the tray count
// still show everything, and a burst of stale toasts at 08:00 helps nobody.

export type Suppression = "disabled" | "quiet" | "muted" | null;

/** Why a toast for this project must not show now, or null when it may. */
export function suppression(s: NotificationSettings, projectId: string | null, now: Date): Suppression {
  if (!s.enabled) return "disabled";
  if (projectId !== null && s.mutedProjects.includes(projectId)) return "muted";
  if (inQuietHours(s.quietHours, now)) return "quiet";
  return null;
}

// ---------------------------------------------------------------------------------------------
// Buttons per request. `Approve once` only for Low risk, and only while both the app setting and
// the project's own rule (`rules.toastApprovals` in .crewyard/project.json) allow it; Medium, High
// and unclassified approvals open the Inbox. A limit pause offers `Hand off` (only with a proposed target) and `Wait for
// reset` (only with a known reset time). The toast body always opens the item.

export type ToastAction = "open" | "approve" | "handoff" | "wait";
export type ToastKind = "approval" | "question" | "limit" | "budget" | "handoff";

export interface ToastPlan {
  kind: ToastKind;
  /** Buttons in order; `open` is always last. */
  actions: ToastAction[];
  /** For `handoff`: the profile the button would hand off to, bound into the toast's grant. */
  targetProfileId: string | null;
}

export type ProjectToastRule = "low" | "none";

export function requestToastPlan(req: RequestView, s: NotificationSettings, project: ProjectToastRule): ToastPlan {
  const p = req.payload;
  if (p.kind === "approval") {
    const quick = s.approveFromToast && project === "low" && req.risk === "low";
    return { kind: "approval", actions: quick ? ["approve", "open"] : ["open"], targetProfileId: null };
  }
  if (p.kind === "question") return { kind: "question", actions: ["open"], targetProfileId: null };
  if (p.trigger === "limit") {
    const target = s.limitActions ? (p.proposedTarget?.profileId ?? null) : null;
    const actions: ToastAction[] = [];
    if (target) actions.push("handoff");
    if (s.limitActions && p.resetsAt) actions.push("wait");
    actions.push("open");
    return { kind: "limit", actions, targetProfileId: target };
  }
  return { kind: p.trigger === "budget" ? "budget" : "handoff", actions: ["open"], targetProfileId: null };
}

// ---------------------------------------------------------------------------------------------
// One-time grants. Every toast with an acting button gets a random token bound to its request,
// the buttons it showed and (for a handoff) the target. The activation string is never trusted
// on its own: the token must exist, be unused and unexpired, and offer that action.

export interface ToastGrant {
  token: string;
  requestId: string;
  /** The run and native session the toast showed; the answer carries them so a handoff in between is refused. */
  runId: string | null;
  sessionId: string | null;
  taskId: string;
  projectId: string;
  actions: ToastAction[];
  targetProfileId: string | null;
  expiresAt: number;
}

/** Toasts sit in the Action Center for a while; a press after this only opens the item. */
export const GRANT_TTL_MS = 12 * 60 * 60_000;
const MAX_GRANTS = 500;

export class ToastGrants {
  private readonly grants = new Map<string, ToastGrant>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly token: () => string = () => randomBytes(16).toString("hex"),
  ) {}

  issue(g: Omit<ToastGrant, "token" | "expiresAt">, ttlMs = GRANT_TTL_MS): ToastGrant {
    const grant: ToastGrant = { ...g, token: this.token(), expiresAt: this.now() + ttlMs };
    this.grants.set(grant.token, grant);
    // Oldest first: a Map keeps insertion order.
    while (this.grants.size > MAX_GRANTS) this.grants.delete(this.grants.keys().next().value as string);
    return grant;
  }

  /** Spends the token whatever the outcome, so a second press of any button never acts. */
  redeem(token: string, action: ToastAction): ToastGrant | null {
    const grant = this.grants.get(token);
    if (!grant) return null;
    this.grants.delete(token);
    if (grant.expiresAt <= this.now() || !grant.actions.includes(action)) return null;
    return grant;
  }

  /** The request was answered elsewhere; its toast buttons must not act any more. */
  revokeRequest(requestId: string): void {
    for (const [token, g] of this.grants) if (g.requestId === requestId) this.grants.delete(token);
  }

  get size(): number {
    return this.grants.size;
  }
}

/**
 * Re-checks a granted button against the request as the daemon has it now. Returns the answer to
 * send, or null when the press must only open the item.
 */
export function decideAction(grant: ToastGrant, action: ToastAction, req: RequestView | undefined, s: NotificationSettings, project: ProjectToastRule): RequestAnswer | null {
  if (!req || req.id !== grant.requestId || req.answeredAt !== null) return null;
  const p = req.payload;
  if (action === "approve") {
    if (p.kind !== "approval" || req.risk !== "low" || !s.approveFromToast || project !== "low") return null;
    return { kind: "approval", decision: "allow_once" };
  }
  if (p.kind !== "handoff" || p.trigger !== "limit" || !s.limitActions) return null;
  if (action === "handoff") {
    const target = p.proposedTarget?.profileId ?? null;
    if (target === null || target !== grant.targetProfileId) return null;
    return { kind: "handoff", decision: "hand_off", targetProfileId: target };
  }
  if (action === "wait") return p.resetsAt ? { kind: "handoff", decision: "wait_for_reset" } : null;
  return null;
}

// ---------------------------------------------------------------------------------------------
// Activation strings. Windows hands back the `launch` or `arguments` attribute of what was pressed.

const PREFIX = "crewyard-toast?";
const TOKEN = /^[0-9a-f]{32}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const ACTIONS = new Set<ToastAction>(["open", "approve", "handoff", "wait"]);

/** Where a toast leads. Display only: opening a screen is harmless, so it needs no token. */
export interface ToastTarget {
  screen: "inbox" | "tasks" | "limits";
  projectId: string | null;
  taskId: string | null;
  requestId: string | null;
}

export function activationArgs(action: ToastAction, token: string | null, target: ToastTarget): string {
  const q = new URLSearchParams({ a: action, s: target.screen });
  if (token) q.set("t", token);
  if (target.projectId) q.set("p", target.projectId);
  if (target.taskId) q.set("k", target.taskId);
  if (target.requestId) q.set("r", target.requestId);
  return PREFIX + q.toString();
}

export interface Activation {
  action: ToastAction;
  token: string | null;
  target: ToastTarget;
}

/** Strict parse; anything malformed is null and only brings the window forward. */
export function parseActivation(raw: unknown): Activation | null {
  if (typeof raw !== "string" || !raw.startsWith(PREFIX) || raw.length > 600) return null;
  const q = new URLSearchParams(raw.slice(PREFIX.length));
  const action = q.get("a") as ToastAction | null;
  if (!action || !ACTIONS.has(action)) return null;
  const screen = q.get("s");
  if (screen !== "inbox" && screen !== "tasks" && screen !== "limits") return null;
  const id = (k: string) => {
    const v = q.get(k);
    return v !== null && ID.test(v) ? v : null;
  };
  const t = q.get("t");
  return { action, token: t !== null && TOKEN.test(t) ? t : null, target: { screen, projectId: id("p"), taskId: id("k"), requestId: id("r") } };
}

// ---------------------------------------------------------------------------------------------
// Toast XML. Task titles come from the user and commands from an agent, so every attribute and
// text node is escaped; nothing is ever concatenated into markup unescaped.

const XML: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
export const escapeXml = (s: string) => s.replace(/[&<>"']/g, (c) => XML[c] ?? c);

/** Control characters other than tab and newlines are not allowed in XML 1.0 and would make the toast fail to show. */
const xmlChar = (ch: string) => {
  const c = ch.codePointAt(0) ?? 0;
  return c === 0x09 || c === 0x0a || c === 0x0d || (c >= 0x20 && c !== 0x7f);
};
const clean = (s: string, max: number) => {
  const flat = [...s].filter(xmlChar).join("").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export interface ToastContent {
  title: string;
  lines: string[];
  launch: string;
  buttons: Array<{ label: string; args: string }>;
}

export function toastXml(c: ToastContent): string {
  const texts = [clean(c.title, 120), ...c.lines.slice(0, 2).map((l) => clean(l, 200))].map((t) => `<text>${escapeXml(t)}</text>`).join("");
  const buttons = c.buttons
    .slice(0, 5)
    .map((b) => `<action content="${escapeXml(clean(b.label, 40))}" arguments="${escapeXml(b.args)}" activationType="foreground"/>`)
    .join("");
  return `<toast launch="${escapeXml(c.launch)}" activationType="foreground"><visual><binding template="ToastGeneric">${texts}</binding></visual>${buttons ? `<actions>${buttons}</actions>` : ""}</toast>`;
}
