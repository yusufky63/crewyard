import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import {
  FOLLOWUP_TOOL,
  INBOX_REPORT_TYPES,
  parseFollowup,
  parseReport,
  REPORT_LIMITS,
  REPORT_TOOL,
  type CrewReportType,
  type CrewReportView,
  type McpTopics,
  type SessionSeen,
  type TaskDetail,
} from "@crewyard/core";
import type { Store } from "../store.ts";
import type { ToolOutcome } from "./session.ts";

// Reports and follow-up proposals from agents (feature scan A14). The agent's words are data: they
// are checked and capped by core (parseReport), stored as text, and land in the timeline, the
// inspector and, for needs_input, stuck and follow-ups, the Inbox. A follow-up becomes a task only
// when you click, and even then only a draft whose crew waits for your approval: no run ever
// creates a run (PLAN.md §9.1).

interface ReportRow {
  id: string;
  project_id: string;
  task_id: string;
  run_id: string;
  member_id: string;
  type: CrewReportType;
  text: string;
  title: string | null;
  artifacts: string;
  created_at: string;
  closed_at: string | null;
  closed_by: CrewReportView["closedBy"];
  task_created: string | null;
}

/** What the service needs from the orchestrator: run facts, a draft task, and a typed message. */
export interface ReportHost {
  run(runId: string): { id: string; task_id: string; member_id: string; role: string; cwd: string; ended_at: string | null; native_session_id: string | null } | null;
  task(taskId: string): { id: string; project_id: string; title: string; cancelled_at: string | null } | null;
  propose(p: { projectId: string; title: string; description?: string }): Promise<TaskDetail>;
  message(runId: string, text: string, seen?: SessionSeen): Promise<unknown>;
}

export interface ReportServiceOptions {
  store: Store;
  host: ReportHost;
  emit<K extends keyof McpTopics>(topic: K, payload: McpTopics[K]): void;
  now?: () => Date;
}

const sameFolder = process.platform === "win32" ? (a: string, b: string) => a.toLowerCase() === b.toLowerCase() : (a: string, b: string) => a === b;

/**
 * An artifact path as the report keeps it: relative to the run's working folder, with forward
 * slashes. Null for anything that leaves the folder (`..`, another drive, a UNC path) or names an
 * alternate data stream.
 */
export function artifactPath(cwd: string, p: string): string | null {
  if (/^\\\\|^\/\//.test(p)) return null;
  const abs = resolve(cwd, p);
  const rel = relative(cwd, abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  if (!sameFolder(resolve(cwd, rel), abs)) return null;
  // A colon after the drive letter is an NTFS stream (file.txt:hidden), never a plain file.
  if (rel.includes(":")) return null;
  return rel.replace(/\\/g, "/");
}

const OPEN_TYPES = INBOX_REPORT_TYPES.map((t) => `'${t}'`).join(", ");

export class ReportService {
  private readonly now: () => Date;

  constructor(private readonly opts: ReportServiceOptions) {
    this.now = opts.now ?? (() => new Date());
  }

  private get db() {
    return this.opts.store.db;
  }

  /** One tool call from the report server. Refusals are tool errors the agent can read. */
  async call(runId: string, tool: string, args: unknown): Promise<ToolOutcome> {
    const run = this.opts.host.run(runId);
    const task = run ? this.opts.host.task(run.task_id) : null;
    if (!run || !task || run.ended_at || task.cancelled_at) return { text: "Refused: this run is not active.", isError: true };
    if (tool === REPORT_TOOL) {
      const parsed = parseReport(args);
      if (!parsed.ok) return { text: `Refused: ${parsed.error}.`, isError: true };
      if (this.count(runId, false) >= REPORT_LIMITS.reportsPerRun) return { text: `Refused: this run already sent ${REPORT_LIMITS.reportsPerRun} reports.`, isError: true };
      const artifacts: string[] = [];
      for (const p of parsed.value.artifacts) {
        const rel = artifactPath(run.cwd, p);
        if (!rel) return { text: `Refused: artifact "${p.slice(0, 80)}" is not inside your working folder.`, isError: true };
        artifacts.push(rel);
      }
      this.insert(run, task.project_id, parsed.value.kind, parsed.value.text, null, artifacts);
      const asks = parsed.value.kind === "needs_input" || parsed.value.kind === "stuck";
      return {
        text: asks ? "Reported. It is in the person's Inbox; if they answer, the answer arrives as your next message. Carry on with anything that does not depend on it." : "Reported.",
        isError: false,
      };
    }
    if (tool === FOLLOWUP_TOOL) {
      const parsed = parseFollowup(args);
      if (!parsed.ok) return { text: `Refused: ${parsed.error}.`, isError: true };
      if (this.count(runId, true) >= REPORT_LIMITS.followupsPerRun) return { text: `Refused: this run already proposed ${REPORT_LIMITS.followupsPerRun} follow-ups.`, isError: true };
      this.insert(run, task.project_id, "followup", parsed.value.description, parsed.value.title, []);
      return { text: "Proposed. It waits in the person's Inbox; nothing starts unless they turn it into a task and approve its crew. Continue with your own task.", isError: false };
    }
    return { text: "Refused: unknown tool.", isError: true };
  }

  list(filter: { projectId?: string; taskId?: string; runId?: string; includeClosed?: boolean }): CrewReportView[] {
    const where = ["1 = 1"];
    const args: string[] = [];
    if (!filter.includeClosed) where.push(`closed_at is null and type in (${OPEN_TYPES})`);
    for (const [col, v] of [
      ["project_id", filter.projectId],
      ["task_id", filter.taskId],
      ["run_id", filter.runId],
    ] as const) {
      if (!v) continue;
      where.push(`${col} = ?`);
      args.push(v);
    }
    return (this.db.prepare(`select * from crew_reports where ${where.join(" and ")} order by created_at desc, rowid desc limit 500`).all(...args) as unknown as ReportRow[]).map(view);
  }

  get(id: string): CrewReportView {
    return view(this.row(id));
  }

  dismiss(id: string): CrewReportView {
    this.close(this.row(id), "dismissed");
    return this.get(id);
  }

  /** Sends your answer to the run like a typed message, then closes the item. */
  async reply(id: string, text: string, seen?: SessionSeen): Promise<CrewReportView> {
    const r = this.row(id);
    if (r.type !== "needs_input" && r.type !== "stuck") throw new Error("mcp.report_not_answerable");
    if (r.closed_at) throw new Error("mcp.report_closed");
    const answer = text.trim();
    if (!answer) throw new Error("mcp.reply_empty");
    await this.opts.host.message(r.run_id, answer, seen);
    this.close(r, "replied");
    return this.get(id);
  }

  /** A follow-up becomes a draft task: classified and given a proposed crew, nothing started. */
  async accept(id: string): Promise<{ report: CrewReportView; taskId: string }> {
    const r = this.row(id);
    if (r.type !== "followup") throw new Error("mcp.report_not_followup");
    if (r.task_created) return { report: view(r), taskId: r.task_created };
    if (r.closed_at) throw new Error("mcp.report_closed");
    const detail = await this.opts.host.propose({ projectId: r.project_id, title: r.title ?? "", description: r.text || undefined });
    this.db.prepare("update crew_reports set task_created = ? where id = ?").run(detail.id, id);
    this.close(this.row(id), "accepted");
    return { report: this.get(id), taskId: detail.id };
  }

  /** The run ended: its open questions and blockers have nobody left to answer them. Follow-ups stay. */
  runEnded(runId: string): void {
    const open = this.db.prepare("select * from crew_reports where run_id = ? and closed_at is null and type in ('needs_input', 'stuck')").all(runId) as unknown as ReportRow[];
    for (const r of open) this.close(r, "run_ended");
  }

  private count(runId: string, followups: boolean): number {
    const sql = `select count(*) as n from crew_reports where run_id = ? and type ${followups ? "=" : "<>"} 'followup'`;
    return Number((this.db.prepare(sql).get(runId) as { n: number }).n);
  }

  private insert(run: NonNullable<ReturnType<ReportHost["run"]>>, projectId: string, type: CrewReportType, text: string, title: string | null, artifacts: string[]): void {
    const id = randomUUID();
    const at = this.now().toISOString();
    this.db
      .prepare("insert into crew_reports (id, project_id, task_id, run_id, member_id, type, text, title, artifacts, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, projectId, run.task_id, run.id, run.member_id, type, text, title, JSON.stringify(artifacts), at);
    this.opts.store.appendEvent({ kind: "mcp.report", source: "mcp", payload: { reportId: id, type, text, title, artifacts }, projectId, taskId: run.task_id, runId: run.id });
    this.opts.emit("mcp.reports.changed", { reportId: id, taskId: run.task_id, projectId, open: INBOX_REPORT_TYPES.includes(type) });
  }

  private close(r: ReportRow, by: NonNullable<CrewReportView["closedBy"]>): void {
    const res = this.db.prepare("update crew_reports set closed_at = ?, closed_by = ? where id = ? and closed_at is null").run(this.now().toISOString(), by, r.id);
    if (Number(res.changes) > 0) this.opts.emit("mcp.reports.changed", { reportId: r.id, taskId: r.task_id, projectId: r.project_id, open: false });
  }

  private row(id: string): ReportRow {
    const r = this.db.prepare("select * from crew_reports where id = ?").get(id) as ReportRow | undefined;
    if (!r) throw new Error("mcp.report_not_found");
    return r;
  }
}

function view(r: ReportRow): CrewReportView {
  let artifacts: string[] = [];
  try {
    const a = JSON.parse(r.artifacts) as unknown;
    if (Array.isArray(a)) artifacts = a.filter((x): x is string => typeof x === "string");
  } catch {
    artifacts = [];
  }
  return {
    id: r.id,
    projectId: r.project_id,
    taskId: r.task_id,
    runId: r.run_id,
    memberId: r.member_id,
    type: r.type,
    text: r.text,
    title: r.title,
    artifacts,
    createdAt: r.created_at,
    closedAt: r.closed_at,
    closedBy: r.closed_by,
    taskCreated: r.task_created,
  };
}
