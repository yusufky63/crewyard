import {
  estimateCost,
  peakFactor,
  requestCost,
  type AgentEvent,
  type Provenance,
  type Reason,
  type RequestPayload,
  type SpendCap,
  type UnpricedSpend,
} from "@crewyard/core";
import type { OrchestratorContext } from "./context.ts";
import type { HandoffInfo } from "./context.ts";
import { Part } from "./part.ts";
import { estimateFor } from "./crew.ts";
import type { MemberRow, RunRow, TaskRow } from "./db.ts";
import type { Candidate } from "./directory.ts";
import { capResetsAt, capWindow, credentialCaps, overCap, reachedCaps, recordRunSpend, reservedUsd, spendCredential } from "./spend.ts";

// What runs spend and the caps that hold them (PLAN.md §6, feature scan F3, F4): usage reports
// become ledger entries, a paid run or step stops at the first spend cap it may not pass, and
// spend nobody can price needs your click on a capped task. The cap math is in spend.ts.

export interface BudgetDeps {
  onLimitReached(runId: string, info: HandoffInfo): Promise<void>;
}

export class Budget extends Part {
  constructor(ctx: OrchestratorContext, private readonly deps: BudgetDeps) {
    super(ctx);
  }

  async onUsage(run: RunRow, task: TaskRow, ev: Extract<AgentEvent, { type: "usage.update" }>): Promise<void> {
    // Runners report running totals for the native session, and a resumed session starts from the
    // totals of the run before it. So a run adds only the growth since the last total seen for
    // that session; a total that went down means the session counter restarted.
    const session = run.native_session_id ?? `run:${run.id}`;
    const seen = this.db.nativeUsage(run.runner, session) ?? { tokensIn: 0, tokensOut: 0, cacheRead: 0, reasoning: 0, costUsd: null, webSearchRequests: 0, webFetchRequests: 0 };
    const restarted = ev.tokensIn < seen.tokensIn || ev.tokensOut < seen.tokensOut;
    const grow = (now: number, before: number) => (restarted ? now : Math.max(0, now - before));
    const dIn = grow(ev.tokensIn, seen.tokensIn);
    const dOut = grow(ev.tokensOut, seen.tokensOut);
    const dCache = grow(ev.cacheRead, seen.cacheRead);
    const dReasoning = grow(ev.reasoning, seen.reasoning);
    // A request total below the last one restarted on its own (a resumed Codex thread whose
    // rollout could not be read), so its requests count in full; a runner that cannot see
    // requests reports none and adds none.
    const growRequests = (now: number | undefined, before: number) => (now === undefined ? 0 : restarted || now < before ? now : now - before);
    const dSearch = growRequests(ev.webSearchRequests, seen.webSearchRequests);
    const dFetch = growRequests(ev.webFetchRequests, seen.webFetchRequests);
    const requests = ev.webSearchRequests !== undefined || ev.webFetchRequests !== undefined ? { webSearchRequests: ev.webSearchRequests ?? seen.webSearchRequests, webFetchRequests: ev.webFetchRequests ?? seen.webFetchRequests } : {};
    this.db.setNativeUsage(run.runner, session, { tokensIn: ev.tokensIn, tokensOut: ev.tokensOut, cacheRead: ev.cacheRead, reasoning: ev.reasoning, costUsd: ev.costUsd, ...requests }, ev.at);

    const live = this.live.get(run.id);
    const model = live?.candidate.model ?? null;
    // Catalog prices, and OpenCode's own estimate (it prices from models.dev too), are the standard
    // rate; DeepSeek bills twice that in its weekday peak hours.
    const peak = peakFactor(live?.candidate.peak, this.now());
    // DeepSeek bills the searches and fetches its server runs per request, at one rate all day and
    // only from its billing start. No runner's own estimate on DeepSeek includes them.
    const requestUsd = live?.candidate.profile.credential.kind === "api_key" ? requestCost(live.candidate.requests, dSearch, dFetch, this.now()) : 0;
    let dCost: number | null;
    let provenance: Provenance;
    if (ev.costUsd !== null) {
      dCost = restarted ? ev.costUsd : Math.max(0, ev.costUsd - (seen.costUsd ?? 0));
      provenance = ev.costProvenance;
      // A billed cost already holds every request.
      if (provenance === "estimated") dCost = dCost * peak + requestUsd;
    } else if (live && live.candidate.profile.credential.kind !== "api_key") {
      [dCost, provenance] = [0, "estimated"];
    } else {
      // The runner could not price these tokens (e.g. Claude Code on DeepSeek): price them from the catalog.
      const usd = model ? estimateCost(model, dIn, dOut, dCache) : null;
      dCost = usd === null ? null : usd * peak + requestUsd;
      provenance = dCost === null ? "unknown" : "estimated";
    }
    if (live && dCost !== null) {
      recordRunSpend(
        this.opts.store.db,
        live.candidate,
        {
          // A Best of N variant spends on its parent's budget and per-task caps.
          taskId: this.budgetTask(task.id),
          runId: run.id,
          profileId: run.profile_id,
          model: run.model ?? model?.id ?? null,
          tokensIn: dIn,
          tokensOut: dOut,
          tokensCache: dCache,
          tokensReasoning: dReasoning,
          costUsd: dCost,
          billed: ev.costUsd !== null && ev.costProvenance === "reported",
          fromCatalog: ev.costUsd === null,
        },
        this.now(),
      );
    }
    const fresh = run.tokens_in + run.tokens_out === 0;
    const cost = dCost !== null && (fresh || run.cost_usd !== null) ? (run.cost_usd ?? 0) + dCost : null;
    const label: Provenance = cost === null ? "unknown" : fresh ? provenance : weakest(run.cost_provenance, provenance);
    this.db.exec(
      "update runs set tokens_in = ?, tokens_out = ?, cost_usd = ?, cost_provenance = ? where id = ?",
      run.tokens_in + dIn,
      run.tokens_out + dOut,
      cost === null ? null : Math.round(cost * 1_000_000) / 1_000_000,
      label,
      run.id,
    );
    if (ev.contextUsed !== null && ev.contextSize !== null) {
      this.limits.ingest(
        { profileId: run.profile_id, window: "context", usedPct: Math.min(100, (100 * ev.contextUsed) / ev.contextSize), resetsAt: null, provenance: "reported", observedAt: ev.at },
        { runId: run.id, taskId: task.id },
      );
    }
    if (run.limit_reached === 0) {
      // Tokens nobody could price count against no cap, so a capped task stops and asks (F4).
      const unpriced = dCost === null && dIn + dOut + dCache > 0 ? this.unpricedFor(task, run.id, live?.candidate, run.model, true) : null;
      const cap = unpriced ? null : this.capFor(task.id, run.id, live?.candidate);
      if (unpriced) await this.deps.onLimitReached(run.id, { trigger: "unpriced", window: null, resetsAt: null, unpriced });
      else if (cap) await this.pauseForCap(run.id, cap, ev.at);
    }
  }

  /**
   * The first spend limit this run may not pass: the key's daily cap, its per-task cap, then the
   * task's own budget. Committed spend counts what other unfinished runs still hold, and `addUsd`
   * (a step's estimate before it starts) must fit too. Caps you approved for this run with
   * "continue" are skipped; plans and local models never spend, so only paid keys are held.
   */
  capFor(taskId: string, runId: string | null, candidate: Candidate | undefined, addUsd = 0, alsoApproved: Set<string> = new Set()): SpendCap | null {
    if (candidate?.profile.credential.kind !== "api_key") return null;
    const approved = new Set([...(runId ? this.approvalsFor(runId) : []), ...alsoApproved]);
    const db = this.opts.store.db;
    // A Best of N variant counts against its parent: one budget, one per-task cap for the group.
    const root = this.budgetTask(taskId);
    const caps = reachedCaps(db, spendCredential(candidate), root, this.now(), { addUsd, excludeRunId: runId });
    const task = this.db.task(root);
    if (task.budget_usd !== null) {
      const spent = this.db.spend(this.budgetRuns(root)).usd;
      const held = reservedUsd(db, { taskId: root, excludeRunId: runId });
      if (spent !== null && overCap(spent, held, addUsd, task.budget_usd)) {
        caps.push({ kind: "task_budget", spentUsd: spent, capUsd: task.budget_usd, credentialId: null, ...(held > 0 ? { reservedUsd: held } : {}), ...(addUsd > 0 ? { estimateUsd: addUsd } : {}) });
      }
    }
    return caps.find((c) => !approved.has(c.kind)) ?? null;
  }

  /**
   * Feature scan F4: spend on a model without a price (no catalog price, and the runner gave none)
   * counts against no cap. So on a paid key, a task with any cap (its budget, the key's daily or
   * per-task cap) needs your "continue" in the Inbox first. Without any cap there is nothing to protect.
   */
  unpricedFor(task: TaskRow, runId: string, candidate: Candidate | undefined, model: string | null, unknownPrice: boolean): UnpricedSpend | null {
    if (!unknownPrice || candidate?.profile.credential.kind !== "api_key") return null;
    if (this.db.approvedCaps(runId).has("unpriced")) return null;
    const keyCaps = credentialCaps(this.opts.store.db, spendCredential(candidate));
    const caps: UnpricedSpend["caps"] = [];
    if (keyCaps?.dailyUsd != null) caps.push("daily_cap");
    if (keyCaps?.taskUsd != null) caps.push("task_cap");
    if (this.db.task(this.budgetTask(task.id)).budget_usd !== null) caps.push("task_budget");
    return caps.length > 0 ? { model: model ?? candidate.model?.id ?? candidate.profile.defaultModel, caps } : null;
  }

  /**
   * Caps you approved for this run, plus a "continue" past the task's own budget given to the run
   * a manual handoff ("Change AI") continues: that budget belongs to the step, and moving the step
   * is your own click. Key caps stay with their key, and a resume or retry still asks again.
   */
  approvalsFor(runId: string): Set<string> {
    const out = this.db.approvedCaps(runId);
    for (const k of this.stepApprovals(this.db.run(runId))) out.add(k);
    return out;
  }

  private stepApprovals(run: RunRow): Set<string> {
    const out = new Set<string>();
    let r = run;
    for (let guard = 0; guard < 50; guard++) {
      const h = this.db.handoffInto(r.id);
      if (h?.trigger_kind !== "manual") break;
      r = this.db.run(h.from_run_id);
      if (this.db.approvedCaps(r.id).has("task_budget")) out.add("task_budget");
    }
    return out;
  }

  /** The run waits on an unanswered unknown-price request; only that answer lets it go on. */
  unpricedOpen(runId: string): boolean {
    return this.db.openRequestsForRun(runId).some((q) => q.kind === "handoff" && (JSON.parse(q.payload) as Extract<RequestPayload, { kind: "handoff" }>).trigger === "unpriced");
  }

  async pauseForCap(runId: string, cap: SpendCap, at: string): Promise<void> {
    const run = this.db.run(runId);
    const resetsAt = capResetsAt(cap, this.now());
    this.limits.ingest({ profileId: run.profile_id, window: capWindow(cap), usedPct: 100, resetsAt, provenance: "estimated", observedAt: at }, { runId, taskId: run.task_id, reached: true });
    await this.deps.onLimitReached(runId, { trigger: "budget", window: capWindow(cap), resetsAt, cap });
  }

  /**
   * A paid step waits in the queue while other unfinished runs hold the part of a cap it needs
   * (feature scan F3). If it would not fit even once they finish, it is not held here: it starts
   * and pauses with a cap request in the Inbox, as before.
   */
  budgetHold(task: TaskRow, m: MemberRow, candidate: Candidate | undefined): Reason | null {
    if (candidate?.profile.credential.kind !== "api_key") return null;
    const amount = this.reservationFor(task, m, candidate);
    const cap = this.capFor(task.id, null, candidate, amount);
    if (!cap?.reservedUsd || overCap(cap.spentUsd, 0, amount, cap.capUsd)) return null;
    return { code: "admission.budget_reserved", params: { reservedUsd: cap.reservedUsd, capUsd: cap.capUsd, cap: cap.kind } };
  }

  /** What a paid step holds before it starts: its estimate less what earlier runs of the step already spent. */
  reservationFor(task: TaskRow, m: MemberRow, candidate: Candidate): number {
    const usd = estimateFor(candidate, this.tpl(m), task.size, this.now()).usd ?? 0;
    const spent = this.db.runs(task.id).filter((r) => r.member_id === m.id).reduce((n, r) => n + (r.cost_usd ?? 0), 0);
    return Math.max(0, usd - spent);
  }
}

const RANK: Record<Provenance, number> = { reported: 2, estimated: 1, unknown: 0 };
const weakest = (a: Provenance, b: Provenance): Provenance => (RANK[a] <= RANK[b] ? a : b);
