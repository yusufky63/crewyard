import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { HibernationSettings, RequestAnswer, RequestPayload } from "@crewyard/core";
import { HIBERNATION_KEY, readHibernation } from "../settings/values.ts";

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
