import type { DatabaseSync } from "node:sqlite";
import {
  ASSISTANT_LIMITS,
  cleanText,
  parseTaskDraft,
  PlannerPlan,
  ResearchFindings,
  ReviewVerdict,
  utf8Length,
  type ReportSeverity,
  type TaskDraftInput,
  type TaskReport,
  type TaskReportFinding,
} from "@crewyard/core";
import { classifyTask } from "../orchestrator/classify.ts";

// A finished analysis, made visible (docs/adr/0014). The owner typed "projeyi incele", a reviewer
// ran, and the row said only "Done": the verdict sat in the event log. This reads what a finished
// task produced, newest first: the researcher's checked findings, a reviewer's verdict, a
// planner's plan, or else the last run's final message, rebuilt from its streamed text. Everything
// is agent text: cleaned, capped and shown as text. Each finding's suggested task, and every open
// follow-up the agent proposed, become suggestions you can add as drafts.

export interface ReadReport {
  report: Omit<TaskReport, "drafts" | "taskId">;
  /** Draft suggestions, keyed so each is created once per task. */
  suggestions: Array<{ key: string; source: "finding" | "followup"; draft: TaskDraftInput; followupId?: string }>;
}

const RESULT_KINDS = ["research.findings", "review.verdict", "plan.result"] as const;

/** Cuts untrusted text to `max` UTF-8 bytes after cleaning it; says whether it cut. */
function capped(s: string, max: number): { text: string; cut: boolean } {
  const clean = cleanText(s);
  if (utf8Length(clean) <= max) return { text: clean, cut: false };
  return { text: `${Buffer.from(clean, "utf8").subarray(0, max).toString("utf8").replace(/�+$/, "")}…`, cut: true };
}

const oneLine = (s: string, max: number) => capped(s.replace(/\s+/g, " "), max).text;

/** A reviewer's comment severity in the findings scale. */
const COMMENT_SEVERITY: Record<string, ReportSeverity> = { blocker: "critical", major: "high", minor: "medium", nit: "low" };

function parse(payload: string): unknown {
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return null;
  }
}

export function readTaskReport(db: DatabaseSync, taskId: string): ReadReport | null {
  const row = db.prepare(`select kind, payload, at from events where task_id = ? and kind in (${RESULT_KINDS.map(() => "?").join(", ")}) order by seq desc limit 1`).get(taskId, ...RESULT_KINDS) as
    | { kind: (typeof RESULT_KINDS)[number]; payload: string; at: string }
    | undefined;
  let truncated = false;
  const cut = (s: string, max: number) => {
    const c = capped(s, max);
    truncated ||= c.cut;
    return c.text;
  };
  const suggestions: ReadReport["suggestions"] = [];
  let report: ReadReport["report"] | null = null;

  if (row?.kind === "research.findings") {
    const res = ResearchFindings.safeParse(parse(row.payload));
    if (res.success) {
      const list = res.data.findings.slice(0, ASSISTANT_LIMITS.reportFindings);
      truncated ||= res.data.findings.length > list.length;
      const findings: TaskReportFinding[] = list.map((f) => ({
        title: oneLine(f.title, 200),
        severity: f.severity,
        file: f.file ? oneLine(f.file, 260) : null,
        line: f.line !== null && Number.isFinite(f.line) ? Math.max(0, Math.trunc(f.line)) : null,
        detail: cut(f.detail, ASSISTANT_LIMITS.findingBytes),
      }));
      list.forEach((f, i) => {
        if (!f.suggestedTask) return;
        const where = f.file ? ` (${f.file}${f.line !== null ? `:${f.line}` : ""})` : "";
        const context = `From finding "${oneLine(f.title, 200)}", ${f.severity}${where}.`;
        const draft = parseTaskDraft({
          title: oneLine(f.suggestedTask.title, ASSISTANT_LIMITS.titleBytes - 1),
          description: capped([f.suggestedTask.description, context].filter(Boolean).join("\n\n"), ASSISTANT_LIMITS.descriptionBytes - 4).text,
          kind: f.suggestedTask.kind,
          acceptance: f.suggestedTask.acceptanceCriteria.slice(0, ASSISTANT_LIMITS.criteria).map((c) => oneLine(c, ASSISTANT_LIMITS.criterionBytes - 4)),
        });
        if (draft.ok) suggestions.push({ key: `finding:${i}`, source: "finding", draft: draft.value });
      });
      report = { source: "findings", verdict: null, summary: cut(res.data.summary, ASSISTANT_LIMITS.reportBytes), findings, truncated: false, at: row.at };
    }
  } else if (row?.kind === "review.verdict") {
    const res = ReviewVerdict.safeParse(parse(row.payload));
    if (res.success) {
      const list = res.data.comments.slice(0, ASSISTANT_LIMITS.reportFindings);
      truncated ||= res.data.comments.length > list.length;
      const findings = list.map((c) => ({ title: oneLine(c.body, 200), severity: COMMENT_SEVERITY[c.severity] ?? "info", file: c.file ? oneLine(c.file, 260) : null, line: c.line, detail: cut(c.body, ASSISTANT_LIMITS.findingBytes) }));
      report = { source: "verdict", verdict: res.data.verdict, summary: cut(res.data.summary, ASSISTANT_LIMITS.reportBytes), findings, truncated: false, at: row.at };
    }
  } else if (row?.kind === "plan.result") {
    const res = PlannerPlan.safeParse((parse(row.payload) as { plan?: unknown } | null)?.plan);
    if (res.success) {
      const p = res.data;
      const text = [p.summary, ...p.steps.map((s, i) => `${i + 1}. ${s.title}${s.detail ? `: ${s.detail}` : ""}`), ...(p.acceptanceCriteria.length ? ["Acceptance criteria:", ...p.acceptanceCriteria.map((c) => `- ${c}`)] : []), ...(p.risks.length ? ["Risks:", ...p.risks.map((r) => `- ${r}`)] : [])].join("\n");
      report = { source: "plan", verdict: null, summary: cut(text, ASSISTANT_LIMITS.reportBytes), findings: [], truncated: false, at: row.at };
    }
  }

  // No checked result: the last completed run's final message, from its streamed text.
  if (!report) {
    const last = db.prepare("select run_id, at from events where task_id = ? and kind = 'run.run.ended' order by seq desc limit 1").get(taskId) as { run_id: string; at: string } | undefined;
    if (last) {
      const turn = db.prepare("select coalesce(max(seq), 0) as seq from events where run_id = ? and kind = 'run.turn.started'").get(last.run_id) as { seq: number };
      const deltas = db.prepare("select payload from events where run_id = ? and kind = 'run.message.delta' and seq > ? order by seq").all(last.run_id, turn.seq) as Array<{ payload: string }>;
      const text = deltas.map((d) => (parse(d.payload) as { text?: unknown } | null)?.text).filter((t): t is string => typeof t === "string").join("");
      if (text.trim()) report = { source: "text", verdict: null, summary: cut(text, ASSISTANT_LIMITS.reportBytes), findings: [], truncated: false, at: last.at };
    }
  }

  // The agent's own follow-up proposals for this task that are still open in the Inbox.
  const followups = db.prepare("select id, title, text from crew_reports where task_id = ? and type = 'followup' and closed_at is null and task_created is null order by created_at").all(taskId) as Array<{ id: string; title: string | null; text: string }>;
  for (const f of followups) {
    const title = oneLine(f.title ?? "", ASSISTANT_LIMITS.titleBytes - 1);
    const description = capped(f.text, ASSISTANT_LIMITS.descriptionBytes - 4).text;
    const draft = parseTaskDraft({ title, description, kind: classifyTask(title, description).kind });
    if (draft.ok) suggestions.push({ key: `followup:${f.id}`, source: "followup", draft: draft.value, followupId: f.id });
  }

  if (!report && suggestions.length === 0) return null;
  return { report: report ? { ...report, truncated } : { source: "text", verdict: null, summary: "", findings: [], truncated, at: "" }, suggestions };
}
