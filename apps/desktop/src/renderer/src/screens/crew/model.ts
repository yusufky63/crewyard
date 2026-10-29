import type { CandidateView, CrewMemberView, FallbackMode, Provenance, Reason, RoleId, RunnerId, RunView, TaskDetail, TaskStatus } from "@crewyard/core";

// Turns a TaskDetail into the graph the Crew screen draws: one task node, one node per crew
// member and one dashed node for the first standby candidate of each member. Everything the user
// reads is a code plus params; the components translate them.

export const NODE_W = 180;
export const NODE_H = 100;
export const SNAP = 12;
const COL = 228; // node width + 48, a multiple of SNAP
const ROW = 168; // node height + 68, a multiple of SNAP
const PAD = 24;

export type NodeKind = "task" | "member" | "standby";

/** Status shown on a member or standby node; task nodes use the task's TaskStatus. */
export type MemberStatus =
  | "proposed"
  | "queued"
  | "running"
  | "needs_answer"
  | "needs_approval"
  | "limited"
  | "paused"
  | "handing_off"
  | "done"
  | "failed"
  | "stopped"
  | "interrupted"
  | "cancelled"
  | "standby";

export type Fact =
  | { code: "usage"; tokens: number; usd: number | null; provenance: Provenance }
  | { code: "blocked"; reason: Reason }
  | { code: "after"; steps: string }
  | { code: "estimate"; usd: number | null; provenance: Provenance }
  | { code: "no_candidate" }
  | { code: "standby_for"; step: string; more: number }
  | { code: "branch"; base: string; branch: string }
  | { code: "kind"; kind: TaskDetail["kind"]; size: TaskDetail["size"] }
  | { code: "queued_messages"; count: number };

export interface GraphNodeModel {
  id: string;
  kind: NodeKind;
  /** Two-digit step number of the member ("02"); also used on its standby node. */
  step: string | null;
  role: RoleId | null;
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
}

export type EdgeKind = "reports" | "depends" | "fallback";

export interface GraphEdgeModel {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
}

export interface GraphModel {
  nodes: GraphNodeModel[];
  edges: GraphEdgeModel[];
  fallback: FallbackMode;
}

export const TASK_NODE = "task";
export const memberNodeId = (memberId: string) => `m:${memberId}`;
export const standbyNodeId = (memberId: string) => `s:${memberId}`;

const pad2 = (n: number) => String(n).padStart(2, "0");

/** The run that represents a step now: the newest one, since resumes and handoffs add runs. */
export function latestRun(runs: RunView[], memberId: string): RunView | null {
  let best: RunView | null = null;
  for (const r of runs) if (r.memberId === memberId && (!best || r.startedAt > best.startedAt)) best = r;
  return best;
}

export function memberStatus(run: RunView | null, approved: boolean, cancelled: boolean): MemberStatus {
  if (!run) return cancelled ? "cancelled" : approved ? "queued" : "proposed";
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

function memberFact(member: CrewMemberView, run: RunView | null, stepOf: Map<string, string>, finished: Set<string>): Fact {
  if (run) {
    if (run.queuedMessages > 0 && run.state !== "ended") return { code: "queued_messages", count: run.queuedMessages };
    return { code: "usage", tokens: run.tokensIn + run.tokensOut, usd: run.cost.usd, provenance: run.cost.provenance };
  }
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
      memberId: null,
      runner: null,
      model: null,
      account: null,
      run: null,
      status: null,
      taskStatus: task.status,
      fact: task.worktree ? { code: "branch", base: task.baseBranch ?? "", branch: task.worktree.branch } : { code: "kind", kind: task.kind, size: task.size },
      limit: null,
    },
  ];
  const edges: GraphEdgeModel[] = [];
  const members = crew?.members ?? [];
  // dependsOn names DAG steps, not member ids.
  const byStep = new Map(members.map((m) => [m.step, m]));
  const stepOf = new Map(members.map((m, i) => [m.step, pad2(i + 1)]));
  const finished = new Set(members.filter((m) => latestRun(task.runs, m.id)?.endReason === "completed").map((m) => m.step));

  members.forEach((m, i) => {
    const run = latestRun(task.runs, m.id);
    const chosen: CandidateView | null = m.chosen;
    const status = memberStatus(run, approved, cancelled);
    nodes.push({
      id: memberNodeId(m.id),
      kind: "member",
      step: pad2(i + 1),
      role: m.role,
      memberId: m.id,
      runner: run?.runner ?? chosen?.runner ?? null,
      model: run ? run.model : (chosen?.model ?? null),
      account: chosen?.alias ?? null,
      run,
      status,
      taskStatus: null,
      fact: memberFact(m, run, stepOf, finished),
      limit: run && (run.limitReached || run.state === "rate_limited") && run.state !== "ended" ? { resumeAt: run.resumeAt } : null,
    });
    const deps = m.dependsOn.filter((d) => byStep.has(d));
    if (deps.length === 0) edges.push({ id: `e:${TASK_NODE}>${memberNodeId(m.id)}`, from: TASK_NODE, to: memberNodeId(m.id), kind: "reports" });
    deps.forEach((d, k) => {
      const from = memberNodeId(byStep.get(d)!.id);
      // The first dependency is the step this one builds on; the rest only gate its start.
      edges.push({ id: `e:${from}>${memberNodeId(m.id)}`, from, to: memberNodeId(m.id), kind: k === 0 ? "reports" : "depends" });
    });

    const next = m.standby[0];
    if (next) {
      nodes.push({
        id: standbyNodeId(m.id),
        kind: "standby",
        step: pad2(i + 1),
        role: m.role,
        memberId: m.id,
        runner: next.runner,
        model: next.model,
        account: next.alias,
        run: null,
        status: "standby",
        taskStatus: null,
        fact: { code: "standby_for", step: pad2(i + 1), more: m.standby.length - 1 },
        limit: null,
      });
      edges.push({ id: `e:${memberNodeId(m.id)}>${standbyNodeId(m.id)}`, from: memberNodeId(m.id), to: standbyNodeId(m.id), kind: "fallback" });
    }
  });

  return { nodes, edges, fallback: task.fallback };
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Columns by dependency depth (task first), each member followed by its standby, columns centred
 * on the tallest one. Every coordinate is on the 12 px grid.
 */
export function defaultLayout(model: GraphModel): Record<string, Point> {
  const incoming = new Map<string, string[]>();
  for (const e of model.edges) if (e.kind !== "fallback") incoming.set(e.to, [...(incoming.get(e.to) ?? []), e.from]);
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
    if (n.kind === "standby") continue;
    const d = n.kind === "task" ? 0 : depthOf(n.id, new Set());
    (columns[d] ??= []).push(n.id);
    if (n.kind === "member" && n.memberId && model.nodes.some((s) => s.id === standbyNodeId(n.memberId!))) columns[d].push(standbyNodeId(n.memberId));
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
