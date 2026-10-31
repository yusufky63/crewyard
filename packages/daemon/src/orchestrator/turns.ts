import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { attachControls, type AgentAdapter, type ControlReason, type ControlState, type Profile, type RewindResult, type RunControls, type RunnerId, type UndoPreview } from "@crewyard/core";
import type { Store } from "../store.ts";
import { commitsSince, restore, restorePlan, snapshot } from "./checkpoints.ts";
import type { OrchestratorDb, RunRow } from "./db.ts";
import { errorCode, OrchestratorError } from "./errors.ts";
import { StepQueue } from "./queue.ts";

// Turns of a run, for "Steer now" and "Undo last turn" (feature scan A10, A13). A turn starts
// when we hand the runner a prompt (the first one, a resume, or follow-ups at a turn boundary) and
// ends at the next boundary. Before each turn in a task worktree the worktree is checkpointed
// (checkpoints.ts), so undo works the same for every runner and git stays the source of truth;
// the runner's own rewind runs first where it has one, for its own files and history.

export interface TurnRow {
  id: string;
  run_id: string;
  task_id: string;
  member_id: string;
  started_at: string;
  ended_at: string | null;
  worktree_path: string | null;
  checkpoint_sha: string | null;
  head_sha: string | null;
  turn_ref: string | null;
  undone_at: string | null;
  backup_sha: string | null;
}

export interface TurnHost {
  store: Store;
  db: OrchestratorDb;
  now(): Date;
  gitBin?: string;
  /** The live process of a run, if any, whether a turn is running in it, and whether the runner has begun it. */
  live(runId: string): { adapter: AgentAdapter; inTurn: boolean; turnBegun: boolean } | undefined;
  adapter(runner: RunnerId): AgentAdapter | undefined;
  /** Profile and secrets to talk to a runner about a session without starting a turn. */
  session(run: RunRow): Promise<{ profile: Profile; env: Record<string, string> } | null>;
  audit(taskId: string, runId: string | null, kind: string, payload: unknown): void;
}

/** What the agent reads next when its conversation could not forget the undone turn. */
export const UNDO_NOTE =
  "Note from Crewyard: the user undid your last turn. Every file in the worktree is back to how it was before that turn started. Treat whatever you did in that turn as not having happened, and check `git status` before you continue.";

const ok = (): ControlState => ({ ok: true, reason: null });
const no = (reason: ControlReason): ControlState => ({ ok: false, reason });
const sameDir = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase();

export class TurnControl {
  readonly queue: StepQueue;
  /** Tasks with an undo in progress; nothing may start a turn in their worktree meanwhile. */
  private readonly undoing = new Map<string, Promise<unknown>>();

  constructor(private readonly host: TurnHost) {
    this.queue = new StepQueue(host.store.db, host.now);
  }

  /**
   * A turn starts. In a task worktree it is checkpointed first; a checkpoint that fails (git
   * missing, a broken repo) leaves the turn without one, so it cannot be undone, but the run goes on.
   */
  async begin(runId: string): Promise<string> {
    const run = this.host.db.run(runId);
    await this.idle(run.task_id);
    const id = randomUUID();
    let snap: { sha: string; head: string | null } | null = null;
    // A read-only role changes no files, so its turns need no checkpoint (and save the git time).
    if (run.worktree_id && this.host.db.roleTemplate(run.member_id, run.role).policy.writes !== "none") {
      try {
        snap = await snapshot(run.cwd, `refs/crewyard/turns/${id}`, this.host.gitBin);
      } catch (err) {
        this.host.audit(run.task_id, runId, "turn.checkpoint_failed", { code: errorCode(err) });
      }
    }
    this.host.store.db
      .prepare("insert into turns (id, run_id, task_id, member_id, started_at, worktree_path, checkpoint_sha, head_sha) values (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, runId, run.task_id, run.member_id, this.host.now().toISOString(), run.worktree_id ? run.cwd : null, snap?.sha ?? null, snap?.head ?? null);
    return id;
  }

  /** The runner named the turn (turn.started); kept for its own rewind. */
  ref(runId: string, turnRef: string | null): void {
    if (!turnRef) return;
    const open = this.open(runId);
    if (open && !open.turn_ref) this.host.store.db.prepare("update turns set turn_ref = ? where id = ?").run(turnRef, open.id);
  }

  end(runId: string): void {
    this.host.store.db.prepare("update turns set ended_at = ? where run_id = ? and ended_at is null").run(this.host.now().toISOString(), runId);
  }

  /** Waits for an undo in the task's worktree to finish before a new turn may checkpoint it. */
  async idle(taskId: string): Promise<void> {
    await this.undoing.get(taskId)?.catch(() => undefined);
  }

  busy(taskId: string): boolean {
    return this.undoing.has(taskId);
  }

  controls(run: RunRow): RunControls {
    return { steer: this.steerState(run), undo: this.undoState(run), attach: attachControls(this.host.adapter(run.runner)?.capabilities) };
  }

  steerState(run: RunRow): ControlState {
    const adapter = this.host.adapter(run.runner);
    if (!adapter?.capabilities.steer || !adapter.steer) return no("steer.unsupported");
    if (run.paused_at) return no("steer.paused");
    const live = this.host.live(run.id);
    // Until the runner reports its turn (Codex turn/started) there is nothing to steer into: in the
    // live run of 2026-10-30 a steer sent while the run was still starting was refused.
    if (run.ended_at || !live?.inTurn || !live.turnBegun) return no("steer.no_turn");
    return ok();
  }

  undoState(run: RunRow): ControlState & { turnId: string | null } {
    const state = (s: ControlState, turnId: string | null = null) => ({ ...s, turnId });
    const db = this.host.db;
    if (db.task(run.task_id).cancelled_at) return state(no("undo.cancelled"));
    const adapter = this.host.adapter(run.runner);
    if (!adapter?.capabilities.undo || !adapter.rewind) return state(no("undo.unsupported"));
    if (!run.worktree_id) return state(no("undo.no_worktree"));
    if (db.roleTemplate(run.member_id, run.role).policy.writes === "none") return state(no("undo.read_only"));
    if (db.runs(run.task_id).some((r) => r.resumed_from === run.id)) return state(no("undo.superseded"));
    if (this.host.live(run.id) || this.busy(run.task_id)) return state(no("undo.turn_running"));
    const others = db.runs(run.task_id).filter((r) => r.id !== run.id && !r.ended_at && this.host.live(r.id) && sameDir(r.cwd, run.cwd));
    if (others.length > 0) return state(no("undo.other_run"));
    const turn = this.lastUndoable(run.id);
    if (!turn) return state(no("undo.no_turn"));
    return state(ok(), turn.id);
  }

  async preview(runId: string): Promise<UndoPreview> {
    const run = this.host.db.run(runId);
    const { turn } = this.check(run, null);
    const now = await snapshot(run.cwd, null, this.host.gitBin);
    const native = this.native(run.runner);
    return {
      runId,
      turnId: turn.id,
      turnStartedAt: turn.started_at,
      files: await restorePlan(run.cwd, now.sha, turn.checkpoint_sha!, this.host.gitBin),
      commits: await commitsSince(run.cwd, turn.head_sha, now.head, this.host.gitBin),
      native,
      noteQueued: !native.history,
    };
  }

  /** Undoes the turn the preview named; refuses with `undo.changed` if the step moved on. */
  async undo(runId: string, turnId: string): Promise<void> {
    const run = this.host.db.run(runId);
    const { turn } = this.check(run, turnId);
    const work = this.perform(run, turn);
    this.undoing.set(run.task_id, work);
    try {
      await work;
    } finally {
      this.undoing.delete(run.task_id);
    }
  }

  private async perform(run: RunRow, turn: TurnRow): Promise<void> {
    const adapter = this.host.adapter(run.runner)!;
    let result: RewindResult = { files: false, history: false, detail: null };
    // The runner's own rewind first, so its files and history agree; git then makes the worktree exact.
    const session = run.native_session_id ? await this.host.session(run) : null;
    if (session && adapter.rewind) {
      try {
        result = await adapter.rewind({ ...session, cwd: run.cwd, session: { runner: run.runner, sessionId: run.native_session_id! }, turnRef: turn.turn_ref });
      } catch (err) {
        result = { files: false, history: false, detail: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
      }
    }
    const { backup, unrestored } = await restore(run.cwd, { sha: turn.checkpoint_sha!, head: turn.head_sha }, `refs/crewyard/undo/${turn.id}`, this.host.gitBin);
    this.host.store.db.prepare("update turns set undone_at = ?, backup_sha = ? where id = ?").run(this.host.now().toISOString(), backup.sha, turn.id);
    // One note says it for any number of undos before the agent next hears from us.
    if (!result.history && !this.queue.pending(run.member_id).some((m) => m.kind === "note")) this.queue.add(run.task_id, run.member_id, UNDO_NOTE, "note");
    this.host.audit(run.task_id, run.id, "run.undone", { turnId: turn.id, native: { files: result.files, history: result.history, detail: result.detail }, backup: backup.sha, unrestored: unrestored.length });
    if (unrestored.length > 0) throw new OrchestratorError("undo.partial", { files: unrestored.slice(0, 20).join(", ") });
  }

  private check(run: RunRow, turnId: string | null): { turn: TurnRow } {
    const s = this.undoState(run);
    if (!s.ok) throw new OrchestratorError("undo.unavailable", { reason: s.reason ?? "" });
    const turn = this.lastUndoable(run.id)!;
    if (turnId !== null && turn.id !== turnId) throw new OrchestratorError("undo.changed");
    return { turn };
  }

  private native(runner: RunnerId): { files: boolean; history: boolean } {
    const u = this.host.adapter(runner)?.capabilities.undo;
    return { files: u?.files ?? false, history: u?.history ?? false };
  }

  private open(runId: string): TurnRow | undefined {
    return this.host.store.db.prepare("select * from turns where run_id = ? and ended_at is null order by started_at desc, rowid desc limit 1").get(runId) as TurnRow | undefined;
  }

  /**
   * The run's newest turn not undone yet, if it has a checkpoint. One without (the checkpoint
   * failed) blocks undo: restoring an older one would also throw away that turn's work.
   */
  lastUndoable(runId: string): TurnRow | undefined {
    const turn = this.host.store.db.prepare("select * from turns where run_id = ? and undone_at is null order by started_at desc, rowid desc limit 1").get(runId) as TurnRow | undefined;
    return turn?.checkpoint_sha ? turn : undefined;
  }
}
