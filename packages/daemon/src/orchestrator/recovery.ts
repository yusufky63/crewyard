import type { HandoffTrigger, FallbackMode } from "@crewyard/core";
import type { OrchestratorContext, HandoffInfo } from "./context.ts";
import { Part } from "./part.ts";
import { settleReservation } from "./spend.ts";
import type { RequestRow, RunRow, TaskRow } from "./db.ts";

// Recovery at start (PLAN.md §4): what the last daemon left open has no process we own any more.
// Runs become interrupted (hibernated ones keep waiting), pending retries are dropped, open
// handoffs close with the phase they died in and ask you, and stale review checkouts go.

export interface RecoveryDeps {
  closeRequest(q: RequestRow, by: "system" | "policy"): void;
  closeHandoff(id: string, outcome: "completed" | "failed" | "cancelled" | "interrupted", detail: string | null): void;
  offerHandoff(run: RunRow, task: TaskRow, mode: FallbackMode, info: HandoffInfo, detail: string | null): Promise<void>;
  dropCheckout(runId: string): Promise<void>;
}

export class Recovery extends Part {
  constructor(ctx: OrchestratorContext, private readonly deps: RecoveryDeps) {
    super(ctx);
  }

  /** Runs left open by the last daemon have no process we own any more: they become interrupted. */
  recover(): void {
    const alive = this.opts.isAlive ?? pidAlive;
    const tasks = new Set<string>();
    for (const r of this.db.openRuns()) {
      // A hibernated run has no process to lose; it stays open and waits to wake as before.
      if (this.hibernation.asleep(r.id)) {
        tasks.add(r.task_id);
        continue;
      }
      // We never kill a recorded pid: Windows reuses pids, and the number may belong to something else now.
      const detail = r.pid !== null && alive(r.pid) ? "process_orphaned" : "process_gone";
      this.db.exec("update runs set ended_at = ?, end_reason = 'interrupted', end_detail = ?, resume_at = null where id = ?", this.iso(), detail, r.id);
      settleReservation(this.opts.store.db, r.id, this.now());
      for (const q of this.db.openRequestsForRun(r.id)) this.deps.closeRequest(q, "system");
      this.audit(r.task_id, r.id, "run.recovered", { detail });
      tasks.add(r.task_id);
    }
    // Same-profile retries were timers of the last daemon; the failed run is offered for Retry instead.
    for (const r of this.db.pendingRetries()) {
      this.db.exec("update runs set resume_at = null where id = ?", r.id);
      tasks.add(r.task_id);
    }
    for (const h of this.db.openHandoffs()) {
      // The phase it died in tells you how far it got (e.g. a WIP commit exists after "checkpoint").
      this.deps.closeHandoff(h.id, "interrupted", h.phase);
      this.audit(h.task_id, h.from_run_id, "handoff.reconciled", { handoffId: h.id, phase: h.phase });
      tasks.add(h.task_id);
      // The target never confirmed, so the source still holds the step: ask what to do with it.
      this.track(this.reconcileHandoff(h.from_run_id, h.trigger_kind));
    }
    // Review checkouts of runs the last daemon left behind.
    for (const c of this.loops.openCheckouts()) if (this.db.run(c.run_id).ended_at) this.track(this.deps.dropCheckout(c.run_id));
    tasks.forEach((t) => this.emitTask(t, "recovered"));
  }

  private async reconcileHandoff(sourceRunId: string, trigger: HandoffTrigger): Promise<void> {
    const source = this.db.run(sourceRunId);
    const task = this.db.task(source.task_id);
    if (task.cancelled_at || this.superseded(source) || source.end_reason === "completed") return;
    if (this.db.openRequestsForRun(source.id).some((q) => q.kind === "handoff")) return;
    await this.deps.offerHandoff(source, task, "manual", { trigger, window: null, resetsAt: null }, "handoff_interrupted");
    this.emitTask(task.id, "recovered");
  }
}

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
