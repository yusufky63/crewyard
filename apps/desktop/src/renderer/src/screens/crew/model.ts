import type { CandidateView, CrewMemberView, FallbackMode, Provenance, Reason, RoleId, RunnerId, RunView, TaskDetail, TaskLoopView, TaskStatus } from "@crewyard/core";

// Turns a TaskDetail into the graph the Crew screen draws: one task node and one node per crew
// member. A member's standby chain is a badge on its tile, not a node of its own; the owner,
// 2026-11-01: "fallback kartlarını crew graph da büyük göstermeye hatta card olarak göstermeye
// gerek var mı" (is there any need to show fallback cards big, or even as cards?). Only a handoff
// that happened draws a second tile, for the run that took over, joined by the fallback edge.
// Everything the user reads is a code plus params; the components translate them.

export const NODE_W = 180;
export const NODE_H = 100;
/** A node with a loop line (fix attempt, verdict) gets one more row, so the line sits inside its frame. */
export const NODE_H_LOOP = 120;
export const SNAP = 12;
const COL = 228; // node width + 48, a multiple of SNAP
// Node height + 92, a multiple of SNAP: room under a 120 px loop tile for its standby badge and
// above the next tile for a two-line limit annotation.
const ROW = 192;
const PAD = 24;

export type NodeKind = "task" | "member";

/** Status shown on a member node or a standby row of the list; task nodes use the task's TaskStatus. */
export type MemberStatus =
  | "proposed"
  | "queued"
  | "running"
  | "needs_answer"
  | "needs_approval"
  | "limited"
  | "paused"
  | "hibernated"
  | "handing_off"
  | "done"
  | "failed"
  | "stopped"
  | "interrupted"
  | "cancelled"
  | "skipped"
  | "standby";

export type Fact =
  | { code: "usage"; tokens: number; usd: number | null; provenance: Provenance }
  | { code: "blocked"; reason: Reason }
  | { code: "after"; steps: string }
  | { code: "estimate"; usd: number | null; provenance: Provenance }
  | { code: "no_candidate" }
  /** A standby row of the list view: its place in the step's chain. */
  | { code: "standby_order"; step: string; place: number }
  | { code: "branch"; base: string; branch: string }
  | { code: "kind"; kind: TaskDetail["kind"]; size: TaskDetail["size"] }
  | { code: "queued_messages"; count: number }
  | { code: "skipped" }
  | { code: "pending_approval" };

/**
 * The crew loop on a node: the step that writes code shows its fix attempts and why the loop last
 * went on or stopped; a reviewer shows its latest verdict, pinned to the commit it read.
 */
export type NodeLoop =
  | { code: "attempts"; attempt: number; max: number; tone: "wait" | "ok" | "bad"; last: Reason | null }
  | { code: "verdict"; verdict: "pass" | "changes"; sha: string | null; stale: boolean };

/** One profile of a step's standby chain, as its tile's badge and popover show it. */
export interface StandbyEntry {
  profileId: string;
  runner: RunnerId;
  model: string | null;
  alias: string;
}

export interface GraphNodeModel {
  id: string;
  kind: NodeKind;
  /** Two-digit step number of the member ("02"); also on the tile of the run that took it over. */
  step: string | null;
  role: RoleId | null;
  /** The role file's title, for a custom role. */
  roleTitle: string | null;
  memberId: string | null;
  runner: RunnerId | null;
  model: string | null;
  account: string | null;
  run: RunView | null;
  status: MemberStatus | null;
  taskStatus: TaskStatus | null;
  fact: Fact;
  /** Shown above the node as a leader-line annotation (limit reached, resumes at). */
  limit: { resumeAt: string | null } | null;
  loop: NodeLoop | null;
  /** A step added to an approved crew that waits for its own approval. */
  pending: boolean;
  /** Who takes over next, in order; empty when nobody stands by, and on the task node. */
  standby: StandbyEntry[];
  /** The tile of the run a handoff moved the step to; the member's own tile keeps the run it replaced. */
  takeover: boolean;
}

export type EdgeKind = "reports" | "depends" | "fallback";

export interface GraphEdgeModel {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  /** Set on an edge between two steps: the dependency it draws, which an edit may remove. */
  dep?: { memberId: string; dependsOn: string };
}

export interface GraphModel {
  nodes: GraphNodeModel[];
  edges: GraphEdgeModel[];
  fallback: FallbackMode;
  /** The crew is still a proposal, so its steps and dependencies can be edited before approval. */
  proposal: boolean;
}

export const TASK_NODE = "task";
export const memberNodeId = (memberId: string) => `m:${memberId}`;
/** The tile of the run that took a step over after a handoff. */
export const takeoverNodeId = (memberId: string) => `h:${memberId}`;

const pad2 = (n: number) => String(n).padStart(2, "0");

/** The run that represents a step now: the newest one, since resumes and handoffs add runs. */
export function latestRun(runs: RunView[], memberId: string): RunView | null {
  let best: RunView | null = null;
  for (const r of runs) if (r.memberId === memberId && (!best || r.startedAt > best.startedAt)) best = r;
  return best;
}

export function memberStatus(run: RunView | null, approved: boolean, cancelled: boolean, member?: Pick<CrewMemberView, "pendingApproval" | "skippedAt">): MemberStatus {
  if (!run && member?.skippedAt) return "skipped";
  if (!run) return cancelled ? "cancelled" : approved && !member?.pendingApproval ? "queued" : "proposed";
  // Hibernated: the process is stopped while the run waits; the run still holds its step.
  if (run.hibernatedAt && !run.endedAt && run.state !== "paused") return "hibernated";
  switch (run.state) {
    case "starting":
    case "running":
      return "running";
    case "waiting_input":
      return "needs_answer";
    case "waiting_approval":
      return "needs_approval";
    case "rate_limited":
      return "limited";
    case "paused":
      return "paused";
    case "hibernated":
      return "hibernated";
    case "handing_off":
      return "handing_off";
    case "ended":
      switch (run.endReason) {
        case "completed":
          return "done";
        case "failed":
          return "failed";
        case "stopped":
          return "stopped";
        case "limit":
          return "limited";
        default:
          return "interrupted";
      }
  }
}

const SHORT_SHA = 7;

/** Whether the node draws a loop line: a fix attempt so far, or a reviewer's verdict. */
export const hasLoopLine = (loop: NodeLoop | null): boolean => !!loop && (loop.code === "verdict" || loop.attempt > 0);
export const nodeHeight = (n: Pick<GraphNodeModel, "loop">): number => (hasLoopLine(n.loop) ? NODE_H_LOOP : NODE_H);

/** Loop state for one member, or null when the loop never touched it. */
export function memberLoop(loop: TaskLoopView, memberId: string): NodeLoop | null {
  const latest = <T extends { at: string }>(xs: T[]) => xs.reduce<T | null>((best, x) => (!best || x.at >= best.at ? x : best), null);
  const verdict = latest(loop.verdicts.filter((v) => v.memberId === memberId));
  if (verdict) return { code: "verdict", verdict: verdict.verdict, sha: verdict.headSha?.slice(0, SHORT_SHA) ?? null, stale: verdict.stale };
  const decisions = loop.decisions.filter((d) => d.memberId === memberId);
  const last = latest(decisions);
  if (!last) return null;
  const attempt = Math.max(...decisions.map((d) => d.iteration));
  // A stop rule ended the loop; a pass ended it well; anything else is a try still under way.
  const tone = last.kind.startsWith("stop_") || last.kind === "review_invalid" ? "bad" : last.kind === "review_passed" || last.kind === "tests_passed" ? "ok" : "wait";
  return { code: "attempts", attempt, max: last.maxIterations || loop.maxIterations, tone, last: last.reason };
}

function memberFact(member: CrewMemberView, run: RunView | null, stepOf: Map<string, string>, finished: Set<string>): Fact {
  if (run) {
    if (run.queuedMessages > 0 && run.state !== "ended") return { code: "queued_messages", count: run.queuedMessages };
    return { code: "usage", tokens: run.tokensIn + run.tokensOut, usd: run.cost.usd, provenance: run.cost.provenance };
  }
  if (member.skippedAt) return { code: "skipped" };
  if (member.pendingApproval) return { code: "pending_approval" };
  if (member.blockedBy) return { code: "blocked", reason: member.blockedBy };
  const waiting = member.dependsOn.filter((d) => !finished.has(d)).map((d) => stepOf.get(d) ?? d);
  if (waiting.length > 0) return { code: "after", steps: waiting.join(", ") };
  if (!member.chosen) return { code: "no_candidate" };
  return { code: "estimate", usd: member.chosen.estimate.usd, provenance: member.chosen.estimate.provenance };
}

export function buildGraph(task: TaskDetail): GraphModel {
  const crew = task.crew;
  const approved = !!crew?.approvedAt;
  const cancelled = !!task.cancelledAt;
  const nodes: GraphNodeModel[] = [
    {
      id: TASK_NODE,
      kind: "task",
      step: null,
      role: null,
      roleTitle: null,
      memberId: null,
      runner: null,
      model: null,
      account: null,
      run: null,
      status: null,
      taskStatus: task.status,
      fact: task.worktree ? { code: "branch", base: task.baseBranch ?? "", branch: task.worktree.branch } : { code: "kind", kind: task.kind, size: task.size },
      limit: null,
      loop: null,
      pending: false,
      standby: [],
      takeover: false,
    },
  ];
  const edges: GraphEdgeModel[] = [];
  const members = crew?.members ?? [];
  // dependsOn names DAG steps, not member ids.
  const byStep = new Map(members.map((m) => [m.step, m]));
  const stepOf = new Map(members.map((m, i) => [m.step, pad2(i + 1)]));
  const finished = new Set(members.filter((m) => latestRun(task.runs, m.id)?.endReason === "completed").map((m) => m.step));

  // A run's account name, from any step's candidates: a handoff may pick an account outside the chain.
  const aliases = new Map(members.flatMap((m) => [m.chosen, ...m.standby]).flatMap((c) => (c ? [[c.profileId, c.alias] as const] : [])));
  // Where a step's result comes from: the run that took it over, once a handoff happened.
  const takeovers = new Map(members.flatMap((m) => {
    const t = takeoverOf(task, m.id);
    return t ? [[m.id, t] as const] : [];
  }));
  const outOf = (memberId: string) => (takeovers.has(memberId) ? takeoverNodeId(memberId) : memberNodeId(memberId));
  const limitOf = (run: RunView | null) => (run && (run.limitReached || run.state === "rate_limited") && run.state !== "ended" ? { resumeAt: run.resumeAt } : null);

  members.forEach((m, i) => {
    const took = takeovers.get(m.id) ?? null;
    // After a handoff the member's tile keeps the run it replaced; the new tile below carries on.
    const run = took ? took.from : latestRun(task.runs, m.id);
    const chosen: CandidateView | null = m.chosen;
    const used = new Set(took ? [took.from.profileId, took.to.profileId] : []);
    const standby = m.standby.filter((c) => !used.has(c.profileId)).map((c) => ({ profileId: c.profileId, runner: c.runner, model: c.model, alias: c.alias }));
    nodes.push({
      id: memberNodeId(m.id),
      kind: "member",
      step: pad2(i + 1),
      role: m.role,
      roleTitle: m.roleTitle ?? null,
      memberId: m.id,
      runner: run?.runner ?? chosen?.runner ?? null,
      model: run ? run.model : (chosen?.model ?? null),
      account: run ? (aliases.get(run.profileId) ?? null) : (chosen?.alias ?? null),
      run,
      status: memberStatus(run, approved, cancelled, m),
      taskStatus: null,
      fact: memberFact(m, run, stepOf, finished),
      limit: limitOf(run),
      loop: took ? null : memberLoop(task.loop, m.id),
      pending: !!m.pendingApproval,
      // The chain moves to the tile that carries on; the replaced run has nobody left to hand to.
      standby: took ? [] : standby,
      takeover: false,
    });
    const deps = m.dependsOn.filter((d) => byStep.has(d));
    if (deps.length === 0) edges.push({ id: `e:${TASK_NODE}>${memberNodeId(m.id)}`, from: TASK_NODE, to: memberNodeId(m.id), kind: "reports" });
    deps.forEach((d, k) => {
      const from = outOf(byStep.get(d)!.id);
      // The first dependency is the step this one builds on; the rest only gate its start.
      edges.push({ id: `e:${from}>${memberNodeId(m.id)}`, from, to: memberNodeId(m.id), kind: k === 0 ? "reports" : "depends", dep: { memberId: m.id, dependsOn: d } });
    });

    if (took) {
      const to = took.to;
      nodes.push({
        id: takeoverNodeId(m.id),
        kind: "member",
        step: pad2(i + 1),
        role: m.role,
        roleTitle: m.roleTitle ?? null,
        memberId: m.id,
        runner: to.runner,
        model: to.model,
        account: aliases.get(to.profileId) ?? null,
        run: to,
        status: memberStatus(to, approved, cancelled, m),
        taskStatus: null,
        fact: memberFact(m, to, stepOf, finished),
        limit: limitOf(to),
        loop: memberLoop(task.loop, m.id),
        pending: false,
        standby,
        takeover: true,
      });
      edges.push({ id: `e:${memberNodeId(m.id)}>${takeoverNodeId(m.id)}`, from: memberNodeId(m.id), to: takeoverNodeId(m.id), kind: "fallback" });
    }
  });

  return { nodes, edges, fallback: task.fallback, proposal: !!crew && !approved && !cancelled };
}

/**
 * The handoff that moved a step to another AI: the run it replaced and the step's newest run,
 * which continues the one that took over (a resume after the handoff keeps the takeover). A
 * handoff back to the same profile (a native resume) is not a takeover.
 */
export function takeoverOf(task: Pick<TaskDetail, "runs" | "handoffs">, memberId: string): { from: RunView; to: RunView } | null {
  const latest = latestRun(task.runs, memberId);
  const byId = new Map(task.runs.map((r) => [r.id, r]));
  let r: RunView | undefined = latest ?? undefined;
  // The resume chain is short; the bound only guards against a damaged one that loops.
  for (let hops = 0; r && hops < 64; hops++) {
    const into = r.id;
    const h = (task.handoffs ?? []).find((x) => x.toRunId === into);
    const from = h ? byId.get(h.fromRunId) : undefined;
    if (from && latest && from.profileId !== r.profileId) return { from, to: latest };
    r = r.resumedFrom ? byId.get(r.resumedFrom) : undefined;
  }
  return null;
}

/** A row of the list view: a graph node, or one standby profile of the step above it. */
export type ListRow = { kind: "node"; node: GraphNodeModel } | { kind: "standby"; node: GraphNodeModel; entry: StandbyEntry; place: number; fact: Fact };

/** The graph as the list view reads it: every node, each followed by its whole standby chain. */
export function listRows(model: GraphModel): ListRow[] {
  return model.nodes.flatMap((node): ListRow[] => [
    { kind: "node", node },
    ...node.standby.map((entry, i) => ({ kind: "standby" as const, node, entry, place: i + 1, fact: { code: "standby_order" as const, step: node.step ?? "", place: i + 1 } })),
  ]);
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Columns by dependency depth (task first), each member followed by the tile of the run that took
 * it over, if a handoff happened; columns centred on the tallest one. Every coordinate is on the
 * 12 px grid.
 */
export function defaultLayout(model: GraphModel): Record<string, Point> {
  const incoming = new Map<string, string[]>();
  // A takeover tile sits in its member's column, so what waits for it is placed by the member.
  const placedBy = (id: string) => (id.startsWith("h:") ? memberNodeId(id.slice(2)) : id);
  for (const e of model.edges) if (e.kind !== "fallback") incoming.set(e.to, [...(incoming.get(e.to) ?? []), placedBy(e.from)]);
  const depth = new Map<string, number>([[TASK_NODE, 0]]);
  const depthOf = (id: string, seen: Set<string>): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    // A cycle would be a broken crew; place it next to the task instead of recursing forever.
    if (seen.has(id)) return 1;
    seen.add(id);
    const d = 1 + Math.max(0, ...(incoming.get(id) ?? [TASK_NODE]).map((p) => depthOf(p, seen)));
    depth.set(id, d);
    return d;
  };

  const columns: string[][] = [];
  for (const n of model.nodes) {
    if (n.takeover) continue;
    const d = n.kind === "task" ? 0 : depthOf(n.id, new Set());
    (columns[d] ??= []).push(n.id);
    if (n.memberId && model.nodes.some((s) => s.id === takeoverNodeId(n.memberId!))) columns[d].push(takeoverNodeId(n.memberId));
  }
  const tallest = Math.max(1, ...columns.map((c) => c?.length ?? 0));
  const out: Record<string, Point> = {};
  columns.forEach((col, c) => {
    if (!col) return;
    const offset = snap(((tallest - col.length) * ROW) / 2);
    col.forEach((id, r) => (out[id] = { x: PAD + c * COL, y: PAD + offset + r * ROW }));
  });
  return out;
}

export const snap = (v: number, grid = SNAP) => Math.round(v / grid) * grid;

/** Saved positions win for nodes that still exist; new nodes take their default place. */
export function mergeLayout(defaults: Record<string, Point>, saved: Record<string, Point>): Record<string, Point> {
  const out: Record<string, Point> = {};
  for (const [id, p] of Object.entries(defaults)) out[id] = saved[id] ?? p;
  return out;
}

const KEY_STEP: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/** Alt + arrow moves a node by one grid step (WCAG 2.5.7 alternative to dragging). */
export function nudge(p: Point, key: string, alt: boolean): Point | null {
  const d = KEY_STEP[key];
  if (!alt || !d) return null;
  return { x: snap(p.x) + d[0] * SNAP, y: snap(p.y) + d[1] * SNAP };
}

/** Nodes and edges on the way from the task to `selected`, drawn in accent. */
export function selectedPath(model: GraphModel, selected: string | null): { nodes: Set<string>; edges: Set<string> } {
  const nodes = new Set<string>();
  const edges = new Set<string>();
  if (!selected || !model.nodes.some((n) => n.id === selected)) return { nodes, edges };
  const stack = [selected];
  while (stack.length) {
    const id = stack.pop()!;
    if (nodes.has(id)) continue;
    nodes.add(id);
    for (const e of model.edges) {
      if (e.to !== id) continue;
      edges.add(e.id);
      stack.push(e.from);
    }
  }
  return { nodes, edges };
}
