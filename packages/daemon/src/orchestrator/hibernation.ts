import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { HibernationSettings, RequestAnswer, RequestPayload, EndReason } from "@crewyard/core";
import { HIBERNATION_KEY, readHibernation } from "../settings/values.ts";
import { admit, DEFAULT_LIMITS } from "./admission.ts";
import type { OrchestratorContext, Live } from "./context.ts";
import { Part } from "./part.ts";
import { errorDetail } from "./errors.ts";

// Hibernation (orca agents/hibernation.mdx gave the idea; the rules are ours). A run keeps a live
// process only while it works or waits on you: at a turn boundary with nothing queued the runner
// exits and the run ends. So the process that sits idle is one waiting on your answer to a
// question or an approval, often overnight, holding memory and an admission slot. After the idle
// window its process is stopped; the run stays open (never "stopped"), its request stays open in
// the Inbox, and the run wakes by session id when you answer, send a message, or its step goes on.
// The answer goes to the resumed session as text, since the runner's own pending call died with
// its process; an approved command is allowed once more when the agent asks for it again.

export interface HibernationRow {
  id: string;
  run_id: string;
  hibernated_at: string;
  idle_since: string;
  request_id: string | null;
  /** The call you allowed once while asleep (GrantedCall as JSON), until it is used or expires. */
  approved_call: string | null;
  approved_until: string | null;
  woke_at: string | null;
  woke_by: string | null;
}

export type WakeCause = "message" | "answer" | "resume" | "ended" | "handoff";

/** The exact call an "allow once" answer covered: the agent's repeat must match every field. */
export interface GrantedCall {
  command: string;
  cwd: string | null;
  paths: string[];
  network: boolean;
}

/** A one-time grant lasts until the resumed turn ends, and never longer than this. */
export const GRANT_TTL_MS = 15 * 60_000;

/**
 * Runners whose resume by session id is proven (conformance and live runs). Gemini CLI and other
 * ACP agents hibernate only when the agent reported `loadSession` at its probe.
 */
export const PROVEN_RESUME = new Set(["claude-code", "codex", "opencode", "fake"]);
export const canHibernate = (runner: string, adapterResumes: boolean, probedResume: boolean) => adapterResumes && (PROVEN_RESUME.has(runner) || probedResume);

export interface IdleFacts {
  /** A turn is running in the process (and no request holds it). */
  inTurn: boolean;
  /** Our own work at a turn boundary: the test gate, a drain handoff, a stop in progress. */
  busy: boolean;
  paused: boolean;
  limited: boolean;
  resumable: boolean;
  lastActivityAt: string | null;
  startedAt: string;
  /** The open question or approval the run waits on, if any. */
  request: { id: string; createdAt: string; hibernatable: boolean } | null;
}

/**
 * When the run has been idle long enough, the moment its idle time started; otherwise null. Idle
 * means no turn working and nothing of ours running, or a turn held only by a question or an
 * approval waiting on you. Bootstrap approvals and limit questions have no live process to free.
 */
export function idleSince(f: IdleFacts, now: Date, minutes: number): string | null {
  if (!f.resumable || f.paused || f.limited || f.busy) return null;
  let since: string;
  if (f.request) {
    if (!f.request.hibernatable) return null;
    since = [f.request.createdAt, f.lastActivityAt ?? f.startedAt].sort().at(-1)!;
  } else {
    if (f.inTurn) return null;
    since = f.lastActivityAt ?? f.startedAt;
  }
  return now.getTime() - Date.parse(since) >= minutes * 60_000 ? since : null;
}

const quote = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 2_000);

/**
 * The next turn's text for a session that waited on a request while its process was stopped: what
 * it asked and what you answered, as data for the agent, never as new instructions from us.
 */
export function answerAfterSleep(payload: RequestPayload, answer: RequestAnswer): string {
  const head = "While you waited for this answer, Crewyard stopped your process to free memory and has now resumed your session. Your pending tool call did not return.";
  if (payload.kind === "question" && answer.kind === "question") {
    const lines = payload.questions.map((q, i) => {
      const a = answer.answers[i];
      const picked = [...(a?.selected ?? []), ...(a?.text ? [a.text] : [])].map(quote).join("; ") || "(no answer)";
      return `- ${quote(q.prompt)}\n  Answer: ${picked}`;
    });
    return `${head}\nYou asked:\n${lines.join("\n")}\nContinue the task with these answers.`;
  }
  if (payload.kind === "approval" && answer.kind === "approval") {
    const what = payload.command ? `run \`${quote(payload.command)}\`` : payload.paths.length > 0 ? `change ${payload.paths.slice(0, 5).map(quote).join(", ")}` : "use that tool";
    if (answer.decision === "deny") return `${head}\nYour request to ${what} was denied${answer.message ? `: ${quote(answer.message)}` : "."} Do not try it again; continue another way.`;
    return `${head}\nYour request to ${what} was approved. Make the same call again; it will be allowed once.`;
  }
  return `${head}\nThe request was cancelled. Continue the task without it.`;
}

export class HibernationStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => Date,
  ) {}

  settings(): HibernationSettings {
    const row = this.db.prepare("select value from settings where key = ?").get(HIBERNATION_KEY) as { value: string } | undefined;
    return readHibernation(row?.value);
  }

  asleep(runId: string): HibernationRow | null {
    return (this.db.prepare("select * from run_hibernation where run_id = ? and woke_at is null order by hibernated_at desc limit 1").get(runId) as HibernationRow | undefined) ?? null;
  }

  allAsleep(): HibernationRow[] {
    return this.db.prepare("select * from run_hibernation where woke_at is null").all() as unknown as HibernationRow[];
  }

  sleep(runId: string, idleSince: string, requestId: string | null): HibernationRow {
    const row: HibernationRow = { id: randomUUID(), run_id: runId, hibernated_at: this.now().toISOString(), idle_since: idleSince, request_id: requestId, approved_call: null, approved_until: null, woke_at: null, woke_by: null };
    this.db.prepare("insert into run_hibernation (id, run_id, hibernated_at, idle_since, request_id) values (?, ?, ?, ?, ?)").run(row.id, runId, row.hibernated_at, idleSince, requestId);
    return row;
  }

  wake(runId: string, by: WakeCause): boolean {
    const res = this.db.prepare("update run_hibernation set woke_at = ?, woke_by = ? where run_id = ? and woke_at is null").run(this.now().toISOString(), by, runId);
    return Number(res.changes) > 0;
  }

  /**
   * You allowed once the command the sleeping run asked for: its repeat in the resumed session is
   * allowed once more, for this run only. Only a command call qualifies; "allow always" goes through
   * the project allowlist instead, and a deny or cancel grants nothing.
   */
  grant(runId: string, call: GrantedCall): void {
    const until = new Date(this.now().getTime() + GRANT_TTL_MS).toISOString();
    const stored: GrantedCall = { command: call.command.trim(), cwd: call.cwd, paths: [...call.paths], network: call.network };
    this.db
      .prepare("update run_hibernation set approved_call = ?, approved_until = ? where run_id = ? and id = (select id from run_hibernation where run_id = ? order by hibernated_at desc limit 1)")
      .run(JSON.stringify(stored), until, runId, runId);
  }

  /**
   * Uses the grant if the agent's new request is exactly the granted call: the same command text
   * byte for byte apart from its ends, the same folder, the same paths and network flag. A miss
   * leaves the grant in place; a use or an expired grant clears it.
   */
  takeGrant(runId: string, call: { command: string | null; cwd?: string | null; paths?: string[]; network?: boolean }): boolean {
    const row = this.db.prepare("select id, approved_call, approved_until from run_hibernation where run_id = ? and approved_call is not null order by hibernated_at desc limit 1").get(runId) as
      | { id: string; approved_call: string; approved_until: string | null }
      | undefined;
    if (!row) return false;
    if (!row.approved_until || Date.parse(row.approved_until) <= this.now().getTime()) {
      this.dropGrant(runId);
      return false;
    }
    if (!call.command) return false;
    const g = JSON.parse(row.approved_call) as GrantedCall;
    const same = g.command === call.command.trim() && g.cwd === (call.cwd ?? null) && g.network === Boolean(call.network) && JSON.stringify(g.paths) === JSON.stringify(call.paths ?? []);
    if (!same) return false;
    this.db.prepare("update run_hibernation set approved_call = null, approved_until = null where id = ?").run(row.id);
    return true;
  }

  /** The resumed turn ended (or the run did): an unused grant goes with it. */
  dropGrant(runId: string): void {
    this.db.prepare("update run_hibernation set approved_call = null, approved_until = null where run_id = ? and approved_call is not null").run(runId);
  }
}

// Hibernation as an orchestrator part: the idle pass that stops processes, and the wake-up that
// resumes a session by id once an admission slot is free.

export interface HibernatorDeps {
  continueRun(runId: string, text: string): Promise<void>;
  endRun(runId: string, reason: EndReason, detail: string | null): void;
  onFailure(runId: string, detail: string | null): Promise<void>;
  tick(): Promise<void>;
}

export class Hibernator extends Part {
  constructor(ctx: OrchestratorContext, private readonly deps: HibernatorDeps) {
    super(ctx);
  }

  /**
   * One pass: every live run idle past the window, on a runner that resumes sessions, has its
   * process stopped. A failure (the store closing on exit) waits for the next pass.
   */
  async checkHibernation(): Promise<void> {
    if (this.closed) return;
    try {
      const s = this.hibernation.settings();
      if (!s.enabled) return;
      const now = this.now();
      for (const [runId, live] of [...this.live]) {
        const run = this.db.run(runId);
        if (run.ended_at) continue;
        const open = this.db.openRequestsForRun(runId)[0] ?? null;
        const payload = open ? (JSON.parse(open.payload) as RequestPayload) : null;
        const since = idleSince(
          {
            inTurn: live.inTurn,
            busy: Boolean(live.testing) || this.draining.has(runId) || this.drainRelease.has(runId) || this.stopping.has(runId) || this.hibernating.has(runId) || this.confirming.has(runId) || this.db.openHandoffs().some((h) => h.from_run_id === runId),
            paused: run.paused_at !== null,
            limited: run.limit_reached === 1,
            // Only runners whose resume by session id is proven, or an ACP agent that reported loadSession.
            resumable: Boolean(run.native_session_id) && canHibernate(run.runner, live.adapter.capabilities.resume, live.candidate.capabilities.resume),
            lastActivityAt: run.last_activity_at,
            startedAt: run.started_at,
            request: open && payload ? { id: open.id, createdAt: open.created_at, hibernatable: (payload.kind === "question" || (payload.kind === "approval" && !payload.bootstrap)) && open.native_id !== null } : null,
          },
          now,
          s.idleMinutes,
        );
        if (since) await this.hibernate(runId, live, since, open?.id ?? null);
      }
    } catch {
      // Same as a failed scheduling pass: the next timer tick tries again.
    }
  }

  private async hibernate(runId: string, live: Live, since: string, requestId: string | null): Promise<void> {
    const run = this.db.run(runId);
    this.hibernation.sleep(runId, since, requestId);
    this.hibernating.add(runId);
    await this.safe(() => live.adapter.stop(live.handle));
    if (!(await this.within(live.done, this.opts.stopTimeoutMs ?? 30_000)) && this.live.get(runId) === live) {
      // The process tree was killed; the stream may never close, so the run lets go of it here.
      this.live.delete(runId);
      this.hibernating.delete(runId);
    }
    this.turns.end(runId);
    this.db.exec("update runs set pid = null where id = ?", runId);
    this.audit(run.task_id, runId, "run.hibernated", { idleSince: since, requestId });
    this.emitTask(run.task_id, "hibernation");
    void this.deps.tick();
  }

  /**
   * Wakes a hibernated run by its session id, with what is queued for its step (your message, or
   * the answer to its request). It takes an admission slot again; without one it waits, and the
   * scheduler wakes it once a slot is free.
   */
  async wakeRun(runId: string, cause: WakeCause): Promise<void> {
    const run = this.db.run(runId);
    if (run.ended_at || this.live.has(runId) || run.paused_at || !this.hibernation.asleep(runId)) {
      this.pendingWake.delete(runId);
      return;
    }
    const task = this.db.task(run.task_id);
    const config = this.config(this.db.project(task.project_id)).config;
    const counts = this.db.activeCounts();
    const blocked = admit(
      {
        projectActive: counts.byProject.get(task.project_id) ?? 0,
        profileActive: counts.byProfile.get(run.profile_id) ?? 0,
        globalActive: counts.total,
        freeMb: this.freeMb(),
        worktreeBusy: false,
        profileId: run.profile_id,
      },
      { ...DEFAULT_LIMITS, ...this.opts.limits, projectSlots: config.rules.slots },
    );
    if (blocked) {
      this.pendingWake.set(runId, cause);
      this.blocked.set(run.member_id, blocked);
      return;
    }
    this.pendingWake.set(runId, cause);
    this.blocked.delete(run.member_id);
    try {
      await this.deps.continueRun(runId, this.turns.queue.pending(run.member_id).length > 0 ? "" : "Continue the task where you stopped.");
      this.emitTask(task.id, "hibernation");
    } catch (err) {
      this.pendingWake.delete(runId);
      // The runner could not resume the session: the run failed, and the usual handoff or retry follows.
      const detail = errorDetail(err, await this.secretsFor(run.profile_id));
      this.deps.endRun(runId, "failed", detail);
      await this.deps.onFailure(runId, detail);
    }
  }
}
