import type { Answer, RolePolicy } from "./adapter.ts";
import type { AgentEvent } from "./events.ts";
import { utf8Length } from "./event-caps.ts";
import type { TaskKind, TaskSize } from "./ipc/tasks.ts";
import { cleanText } from "./mcp.ts";

// The task assistant (docs/adr/0014): a read-only runner session that turns a conversation into
// task drafts. Everything the agent sends is untrusted data: drafts are checked and capped here,
// stored as text and shown as text, and a draft becomes a task only when you add it, as a draft
// whose crew still waits for your approval (PLAN.md D8, §9.3).

export const ASSISTANT_TOOL = "propose_task";

export const ASSISTANT_KINDS: readonly TaskKind[] = ["code", "research", "review", "docs"];
export const ASSISTANT_SIZES: readonly TaskSize[] = ["S", "M", "L"];

export const ASSISTANT_LIMITS = {
  titleBytes: 120,
  descriptionBytes: 4_000,
  criteria: 12,
  criterionBytes: 300,
  /** Per conversation, so a looping agent cannot flood the panel or the database. */
  draftsPerConversation: 20,
  /** One message you type. */
  messageBytes: 8_000,
  /** One assistant reply as stored and shown; the rest is cut with a marker. */
  replyBytes: 32_000,
  /** One tool line (the runner's title for a read, a search). */
  toolLineBytes: 200,
  /** Lines the view returns, newest last. */
  viewMessages: 200,
  /** How much of the earlier conversation a fresh session (no native resume) gets quoted. */
  recapBytes: 12_000,
} as const;

/**
 * The assistant's role policy: the reviewer's shape with nothing allowed, so every adapter puts its
 * runner in its read-only mode. Enforced by the runner's engine and by `assistantAnswer`, never by
 * the prompt (PLAN.md §9.1).
 */
export const assistantPolicy = (): RolePolicy => ({ writes: "none", allowCommands: [], network: "denied" });

export const READ_ONLY_DENIAL = "The task assistant is read-only: it may read the project but never edits files, runs commands or uses the network. Describe the work as a task draft instead.";
export const QUESTION_DENIAL = "Ask the person in your reply text instead; they answer in their next message.";

/**
 * Our answer to a request from the assistant's runner: every approval is denied (reads that need
 * none still work), every question is cancelled so the agent asks in text. Null for any other event.
 */
export function assistantAnswer(ev: AgentEvent): Answer | null {
  if (ev.type === "request.approval") return { kind: "approval", decision: "deny", message: READ_ONLY_DENIAL };
  if (ev.type === "request.question") return { kind: "cancel" };
  return null;
}

export interface TaskDraftInput {
  title: string;
  description: string;
  kind: TaskKind;
  /** One line each; research questions go here too. */
  acceptance: string[];
  size: TaskSize | null;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

function text(v: unknown, field: string, max: number, required: boolean): Parsed<string> {
  if (v === undefined || v === null) return required ? { ok: false, error: `${field} is required` } : { ok: true, value: "" };
  if (typeof v !== "string") return { ok: false, error: `${field} must be a string` };
  const s = cleanText(v);
  if (required && !s) return { ok: false, error: `${field} must not be empty` };
  const n = utf8Length(s);
  // Refused rather than cut, like the report tools: the agent learns the limit and says it shorter.
  if (n > max) return { ok: false, error: `${field} is ${n} bytes; the limit is ${max}` };
  return { ok: true, value: s };
}

/**
 * Checks a draft, from the agent's `propose_task` call (snake_case `acceptance_criteria`) or from
 * your edited card (`acceptance`). Errors go back to the agent as the tool result, or to the panel.
 */
export function parseTaskDraft(args: unknown): Parsed<TaskDraftInput> {
  const a = rec(args);
  if (!a) return { ok: false, error: "arguments must be an object" };
  const title = text(a.title, "title", ASSISTANT_LIMITS.titleBytes, true);
  if (!title.ok) return title;
  if (title.value.includes("\n")) return { ok: false, error: "title must be one line" };
  const description = text(a.description, "description", ASSISTANT_LIMITS.descriptionBytes, false);
  if (!description.ok) return description;
  if (typeof a.kind !== "string" || !ASSISTANT_KINDS.includes(a.kind as TaskKind)) return { ok: false, error: `kind must be one of ${ASSISTANT_KINDS.join(", ")}` };
  let size: TaskSize | null = null;
  if (a.size !== undefined && a.size !== null && a.size !== "") {
    if (typeof a.size !== "string" || !ASSISTANT_SIZES.includes(a.size as TaskSize)) return { ok: false, error: `size must be one of ${ASSISTANT_SIZES.join(", ")}` };
    size = a.size as TaskSize;
  }
  const raw = a.acceptance_criteria ?? a.acceptance ?? [];
  if (!Array.isArray(raw)) return { ok: false, error: "acceptance_criteria must be an array of strings" };
  const acceptance: string[] = [];
  for (const c of raw) {
    const s = text(c, "acceptance criterion", ASSISTANT_LIMITS.criterionBytes, false);
    if (!s.ok) return s;
    if (!s.value) continue;
    if (s.value.includes("\n")) return { ok: false, error: "each acceptance criterion must be one line" };
    if (!acceptance.includes(s.value)) acceptance.push(s.value);
  }
  if (acceptance.length > ASSISTANT_LIMITS.criteria) return { ok: false, error: `at most ${ASSISTANT_LIMITS.criteria} acceptance criteria` };
  return { ok: true, value: { title: title.value, description: description.value, kind: a.kind as TaskKind, acceptance, size } };
}

/** The task description a draft becomes: its text, then the criteria as a list the crew reads. */
export function draftDescription(d: Pick<TaskDraftInput, "description" | "acceptance">): string {
  const parts: string[] = [];
  if (d.description) parts.push(d.description);
  if (d.acceptance.length > 0) parts.push(["Acceptance criteria:", ...d.acceptance.map((c) => `- ${c}`)].join("\n"));
  return parts.join("\n\n");
}

/** The tool only assistant connections list. Read-only: it changes nothing in the agent's world. */
export const ASSISTANT_TOOL_DEFS = [
  {
    name: ASSISTANT_TOOL,
    title: "Propose a task draft",
    description:
      "Propose one task for the person to review. It appears as an editable card; nothing starts unless they add it and approve its crew. Call it once per task. kind: code (change code), research (find something out; put the questions to answer in acceptance_criteria), review (read and judge existing work), docs (write documentation). acceptance_criteria: short, checkable lines. size: S, M or L, your estimate of the work.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", maxLength: ASSISTANT_LIMITS.titleBytes },
        description: { type: "string", maxLength: ASSISTANT_LIMITS.descriptionBytes },
        kind: { type: "string", enum: [...ASSISTANT_KINDS] },
        acceptance_criteria: { type: "array", items: { type: "string", maxLength: ASSISTANT_LIMITS.criterionBytes }, maxItems: ASSISTANT_LIMITS.criteria },
        size: { type: "string", enum: [...ASSISTANT_SIZES] },
      },
      required: ["title", "kind"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
] as const;

/** What the panel shows as the spend label; `plan` is a plan sign-in or local model, priced in tokens only. */
export type AssistantSpendLabel = "estimated" | "reported" | "unknown" | "plan";
