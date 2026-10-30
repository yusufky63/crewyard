import { EMPTY_ALERT, evaluate, minutesUntilFull, type AlertState, type LimitNoticePayload, type LimitSample } from "@crewyard/core";
import type { OrchestratorDb } from "./db.ts";

// Every limit sample is stored, run through `evaluate` (warn and critical once per window) and
// `minutesUntilFull` (ahead of pace, once per run), then emitted as `limits.notice` (PLAN.md §7.3).

export class LimitMonitor {
  private readonly alerts = new Map<string, AlertState>();
  private readonly paced = new Set<string>();

  constructor(
    private readonly db: OrchestratorDb,
    private readonly emit: (notice: LimitNoticePayload) => void,
    private readonly now: () => Date,
  ) {}

  /** Records a sample and emits its notices. `reached` comes from the runner, not from a threshold. */
  ingest(sample: LimitSample, ctx: { runId: string | null; taskId: string | null; reached?: boolean }): LimitNoticePayload[] {
    this.db.insertSample(sample, ctx.runId);
    // The context window belongs to one run, so its alert state does too. Each bucket of an
    // account is its own limit: its 80/95% notices arm and re-arm on their own.
    const bucket = sample.bucket ?? null;
    const key = `${sample.profileId}|${sample.window}|${bucket ?? ""}|${sample.window === "context" ? (ctx.runId ?? "") : ""}`;
    const { state, notices } = evaluate(this.alerts.get(key) ?? EMPTY_ALERT, sample);
    this.alerts.set(key, state);
    const base = { profileId: sample.profileId, window: sample.window, ...(bucket ? { bucket } : {}), usedPct: sample.usedPct, resetsAt: sample.resetsAt, provenance: sample.provenance, runId: ctx.runId, taskId: ctx.taskId, observedAt: sample.observedAt };
    const out: LimitNoticePayload[] = notices.map((n) => ({ ...base, kind: n.kind, minutesUntilFull: null }));

    const paceKey = `${ctx.runId}|${sample.window}|${bucket ?? ""}`;
    if (ctx.runId && sample.window !== "context" && !this.paced.has(paceKey) && !ctx.reached) {
      const minutes = minutesUntilFull(this.db.samples(sample.profileId, sample.window, sample.resetsAt, 50, bucket), this.now());
      if (minutes !== null) {
        this.paced.add(paceKey);
        out.push({ ...base, kind: "ahead_of_pace", minutesUntilFull: minutes });
      }
    }
    if (ctx.reached) out.push({ ...base, kind: "reached", minutesUntilFull: null });
    out.forEach((n) => this.emit(n));
    return out;
  }
}
