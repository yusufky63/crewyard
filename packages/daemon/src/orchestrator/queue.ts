import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { QueuedMessageView } from "@crewyard/core";
import { OrchestratorError } from "./errors.ts";

// The step's follow-up queue (feature scan A13), on top of the outbox that runs.message already
// used: a message typed while the agent works waits here, persisted and editable, until a turn
// boundary takes it (StartRequest.nextTurn) or you steer it in. A message is either queued or
// delivered, never both; delivered ones are history and refuse every edit.

/** `note`: written by Crewyard (after an undo the conversation could not forget), not typed by you. */
export type QueueKind = "user" | "note";

interface Row {
  id: string;
  text: string;
  created_at: string;
  edited_at: string | null;
  kind: QueueKind | null;
}

/** Longest message we keep; a pasted log belongs in a file the agent can read. */
export const MAX_MESSAGE = 32_000;

export class StepQueue {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => Date,
  ) {}

  /** Queued messages of a step in the order they will be sent. Older outbox rows without a queue row come first. */
  pending(memberId: string): Array<QueuedMessageView & { kind: QueueKind }> {
    const rows = this.db
      .prepare(
        `select o.id, o.text, o.created_at, q.edited_at, q.kind from outbox o left join outbox_queue q on q.outbox_id = o.id
         where o.member_id = ? and o.delivered_at is null order by coalesce(q.position, 0), o.created_at, o.id`,
      )
      .all(memberId) as unknown as Row[];
    return rows.map((r) => ({ id: r.id, text: r.text, createdAt: r.created_at, editedAt: r.edited_at, kind: r.kind ?? "user" }));
  }

  add(taskId: string, memberId: string, text: string, kind: QueueKind = "user"): string {
    const id = randomUUID();
    const at = this.now().toISOString();
    const last = this.db.prepare("select max(q.position) as p from outbox o join outbox_queue q on q.outbox_id = o.id where o.member_id = ? and o.delivered_at is null").get(memberId) as { p: number | null };
    this.db.prepare("insert into outbox (id, task_id, member_id, text, created_at) values (?, ?, ?, ?, ?)").run(id, taskId, memberId, text.slice(0, MAX_MESSAGE), at);
    this.db.prepare("insert into outbox_queue (outbox_id, position, kind) values (?, ?, ?)").run(id, (last.p ?? 0) + 1, kind);
    return id;
  }

  edit(memberId: string, id: string, text: string): void {
    const trimmed = text.trim();
    if (!trimmed) throw new OrchestratorError("queue.empty_text");
    this.mustBeQueued(memberId, id);
    const at = this.now().toISOString();
    this.db.prepare("update outbox set text = ? where id = ? and delivered_at is null").run(trimmed.slice(0, MAX_MESSAGE), id);
    this.db.prepare("insert into outbox_queue (outbox_id, position, edited_at) values (?, 0, ?) on conflict(outbox_id) do update set edited_at = excluded.edited_at").run(id, at);
  }

  remove(memberId: string, id: string): void {
    this.mustBeQueued(memberId, id);
    this.db.prepare("delete from outbox_queue where outbox_id = ?").run(id);
    this.db.prepare("delete from outbox where id = ? and delivered_at is null").run(id);
  }

  /** Moves a message to `index` among the queued ones (0 = sent first), renumbering the rest. */
  move(memberId: string, id: string, index: number): void {
    this.mustBeQueued(memberId, id);
    const order = this.pending(memberId).map((m) => m.id).filter((x) => x !== id);
    order.splice(Math.max(0, Math.min(order.length, Math.trunc(index))), 0, id);
    const upsert = this.db.prepare("insert into outbox_queue (outbox_id, position) values (?, ?) on conflict(outbox_id) do update set position = excluded.position");
    order.forEach((x, i) => upsert.run(x, i + 1));
  }

  /** Takes every queued message for a run, in order, and marks them delivered to it. */
  take(memberId: string, runId: string): Array<{ id: string; text: string; kind: QueueKind }> {
    const all = this.pending(memberId);
    for (const m of all) this.deliver(m.id, runId);
    return all.map((m) => ({ id: m.id, text: m.text, kind: m.kind }));
  }

  /** One message handed over outside a turn boundary ("Steer now"). */
  deliver(id: string, runId: string, steered = false): void {
    const at = this.now().toISOString();
    this.db.prepare("update outbox set delivered_at = ?, delivered_run_id = ? where id = ? and delivered_at is null").run(at, runId, id);
    if (steered) this.db.prepare("insert into outbox_queue (outbox_id, position, steered_at) values (?, 0, ?) on conflict(outbox_id) do update set steered_at = excluded.steered_at").run(id, at);
  }

  get(memberId: string, id: string): { id: string; text: string } {
    return this.mustBeQueued(memberId, id);
  }

  private mustBeQueued(memberId: string, id: string): { id: string; text: string } {
    const row = this.db.prepare("select id, text, delivered_at from outbox where id = ? and member_id = ?").get(id, memberId) as { id: string; text: string; delivered_at: string | null } | undefined;
    if (!row) throw new OrchestratorError("queue.not_found", { messageId: id });
    if (row.delivered_at) throw new OrchestratorError("queue.delivered", { messageId: id });
    return row;
  }
}

/** One turn's text from several follow-ups: in order, each its own paragraph. */
export function joinMessages(texts: string[]): string {
  return texts.map((t) => t.trim()).filter(Boolean).join("\n\n");
}
