import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { ATTACHMENT_LIMITS, attachmentLimit, classifyAttachment, cleanAttachmentName, type Attachment, type AttachmentView } from "@crewyard/core";
import { OrchestratorError } from "./errors.ts";
import { writeFileAtomic } from "./git.ts";

// Images and files attached to a task description or a queued message (PLAN.md §5.3). An upload
// lands in `<data>/attachments/staged/<id>/<name>` before its task or message exists, then moves
// to `<data>/tasks/<task>/attachments/<id>/<name>` when the task is proposed or the message sent.
// Keeping the name lets an agent that gets the path read a file called what you called it. Only
// ids go into events; the bytes stay on disk (MAX_EVENT_JSON).

interface Row {
  id: string;
  task_id: string | null;
  outbox_id: string | null;
  name: string;
  kind: Attachment["kind"];
  mime: string;
  bytes: number;
  file: string;
  created_at: string;
}

/** Uploads no task or message took are removed after this long. */
export const STAGED_TTL_MS = 24 * 60 * 60 * 1000;

/** Base64 of the largest allowed file, plus padding; anything longer is refused before decoding. */
const MAX_BASE64 = Math.ceil((Math.max(ATTACHMENT_LIMITS.imageBytes, ATTACHMENT_LIMITS.fileBytes) * 4) / 3) + 4;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export class AttachmentStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly dataDir: string,
    private readonly now: () => Date,
  ) {}

  /** Checks type and size, then writes the upload atomically to the staging folder. */
  add(name: string, data: string): AttachmentView {
    const clean = cleanAttachmentName(name);
    const b64 = data.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
    if (b64.length === 0) throw new OrchestratorError("attachment.empty");
    if (b64.length > MAX_BASE64) throw new OrchestratorError("attachment.too_large", { kind: "file", max: ATTACHMENT_LIMITS.fileBytes });
    if (!BASE64.test(b64)) throw new OrchestratorError("attachment.type");
    const bytes = Buffer.from(b64, "base64");
    const type = classifyAttachment(clean, bytes);
    if ("problem" in type) throw new OrchestratorError(type.problem);
    const max = attachmentLimit(type.kind);
    if (bytes.length > max) throw new OrchestratorError("attachment.too_large", { kind: type.kind, max });
    const id = randomUUID();
    const file = join("attachments", "staged", id, clean);
    writeFileAtomic(join(this.dataDir, file), bytes);
    const at = this.now().toISOString();
    this.db.prepare("insert into attachments (id, name, kind, mime, bytes, file, created_at) values (?, ?, ?, ?, ?, ?, ?)").run(id, clean, type.kind, type.mime, bytes.length, file, at);
    return { id, kind: type.kind, name: clean, mime: type.mime, bytes: bytes.length, createdAt: at };
  }

  /** Removes an upload nothing uses yet; one that belongs to a task or message is refused. */
  discard(id: string): void {
    const row = this.row(id);
    if (row.task_id) throw new OrchestratorError("attachment.claimed", { attachmentId: id });
    this.remove(row);
  }

  /** An image as a data URL for its thumbnail. */
  preview(id: string): string {
    const row = this.row(id);
    if (row.kind !== "image") throw new OrchestratorError("attachment.type");
    return `data:${row.mime};base64,${readFileSync(join(this.dataDir, row.file)).toString("base64")}`;
  }

  /**
   * Checks that every id is an unused upload, within the per-message count. Called before the
   * task or message is written, so a bad id refuses the whole request.
   */
  check(ids: readonly string[]): void {
    if (ids.length > ATTACHMENT_LIMITS.perMessage) throw new OrchestratorError("attachment.too_many", { max: ATTACHMENT_LIMITS.perMessage });
    if (new Set(ids).size !== ids.length) throw new OrchestratorError("attachment.claimed", { attachmentId: ids.find((x, i) => ids.indexOf(x) !== i)! });
    for (const id of ids) {
      const row = this.row(id);
      if (row.task_id) throw new OrchestratorError("attachment.claimed", { attachmentId: id });
      if (!existsSync(join(this.dataDir, row.file))) throw new OrchestratorError("attachment.not_found", { attachmentId: id });
    }
  }

  /** Moves checked uploads into the task folder; `outboxId` null means the task description. */
  claim(ids: readonly string[], taskId: string, outboxId: string | null): Attachment[] {
    const at = this.now().toISOString();
    const out: Attachment[] = [];
    for (const id of ids) {
      const row = this.row(id);
      const file = join("tasks", taskId, "attachments", id, row.name);
      moveWithRetry(join(this.dataDir, dirname(row.file)), join(this.dataDir, dirname(file)));
      this.db.prepare("update attachments set task_id = ?, outbox_id = ?, file = ?, claimed_at = ? where id = ?").run(taskId, outboxId, file, at, id);
      out.push(this.toAttachment({ ...row, file }));
    }
    return out;
  }

  /** The description's attachments, in the order you added them. */
  forTask(taskId: string): Attachment[] {
    return this.rows("select * from attachments where task_id = ? and outbox_id is null order by created_at, id", taskId).map((r) => this.toAttachment(r));
  }

  forMessage(outboxId: string): Attachment[] {
    return this.rows("select * from attachments where outbox_id = ? order by created_at, id", outboxId).map((r) => this.toAttachment(r));
  }

  /** Several messages' attachments, in message order, for one turn. */
  forMessages(outboxIds: readonly string[]): Attachment[] {
    return outboxIds.flatMap((id) => this.forMessage(id));
  }

  /** A queued message was deleted: its attachments go with it. */
  removeForMessage(outboxId: string): void {
    for (const r of this.rows("select * from attachments where outbox_id = ?", outboxId)) this.remove(r);
  }

  /** Drops uploads older than STAGED_TTL_MS that nothing took, and staged folders with no row. */
  sweep(): number {
    const cutoff = new Date(this.now().getTime() - STAGED_TTL_MS).toISOString();
    const old = this.rows("select * from attachments where task_id is null and created_at < ?", cutoff);
    for (const r of old) this.remove(r);
    const staged = join(this.dataDir, "attachments", "staged");
    if (existsSync(staged)) {
      const known = new Set(this.rows("select * from attachments where task_id is null").map((r) => r.id));
      for (const dir of readdirSync(staged)) {
        const path = join(staged, dir);
        if (!known.has(dir) && statSync(path).mtimeMs < Date.parse(cutoff)) rmSync(path, { recursive: true, force: true });
      }
    }
    return old.length;
  }

  /** What the renderer shows for the description. */
  taskViews(taskId: string): AttachmentView[] {
    return this.rows("select * from attachments where task_id = ? and outbox_id is null order by created_at, id", taskId).map(toView);
  }

  messageViews(outboxId: string): AttachmentView[] {
    return this.rows("select * from attachments where outbox_id = ? order by created_at, id", outboxId).map(toView);
  }

  private toAttachment(r: Row): Attachment {
    return { id: r.id, kind: r.kind, name: r.name, mime: r.mime, bytes: r.bytes, path: join(this.dataDir, r.file) };
  }

  private remove(r: Row): void {
    const dir = join(this.dataDir, dirname(r.file));
    // Only ever a folder of ours under the data folder, named by the attachment id.
    const rel = relative(this.dataDir, dir);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) rmSync(dir, { recursive: true, force: true });
    this.db.prepare("delete from attachments where id = ?").run(r.id);
  }

  private row(id: string): Row {
    const row = this.db.prepare("select * from attachments where id = ?").get(id) as Row | undefined;
    if (!row) throw new OrchestratorError("attachment.not_found", { attachmentId: id });
    return row;
  }

  private rows(sql: string, ...params: string[]): Row[] {
    return this.db.prepare(sql).all(...params) as unknown as Row[];
  }
}

function toView(r: Row): AttachmentView {
  return { id: r.id, kind: r.kind, name: r.name, mime: r.mime, bytes: r.bytes, createdAt: r.created_at };
}

/** Renames a folder, retrying while antivirus or the indexer holds a file in it (Windows). */
function moveWithRetry(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1));
    }
  }
}
