import type { AgentEvent, Answer, RolePolicy } from "@crewyard/core";
import type { PermissionResult, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import type { AskUserQuestionInput } from "@anthropic-ai/claude-agent-sdk/sdk-tools";

// Tool names come from BUILTIN_TOOL_NAMES in the SDK's sdk.d.ts (0.3.312). MCP tools are "mcp__*".

type ToolKind = Extract<AgentEvent, { type: "tool.call" }>["kind"];
type Question = Extract<AgentEvent, { type: "request.question" }>["questions"][number];

/** Tools that change files. Denied outright for read-only roles. */
export const WRITE_TOOLS = ["Edit", "MultiEdit", "Write", "NotebookEdit"];
const SHELL_TOOLS = ["Bash", "PowerShell"];
const NETWORK_TOOLS = ["WebFetch", "WebSearch"];

/**
 * Tools that start the CLI's own subagents or workflows. Their work would bypass the crew's DAG,
 * spend and approvals, so every role runs without them. Tool denial is used rather than
 * CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: depth 1 was reported not to stop nesting (claude-code
 * #84974) and the variable does not cap the first level at all.
 */
export const SUBAGENT_TOOLS = ["Agent", "Workflow"];

const KINDS: Record<string, ToolKind> = {
  Read: "read",
  NotebookRead: "read",
  Edit: "edit",
  MultiEdit: "edit",
  Write: "edit",
  NotebookEdit: "edit",
  Bash: "execute",
  PowerShell: "execute",
  Monitor: "execute",
  Glob: "search",
  Grep: "search",
  ToolSearch: "search",
  WebFetch: "fetch",
  WebSearch: "fetch",
};

export function toolKind(name: string): ToolKind {
  return KINDS[name] ?? "other";
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** Short human title for a tool call, e.g. "Bash: pnpm test" or "Read src/index.ts". */
export function toolTitle(name: string, input: unknown): string {
  const i = rec(input);
  const detail = str(i.description) ?? str(i.command) ?? str(i.file_path) ?? str(i.notebook_path) ?? str(i.pattern) ?? str(i.url) ?? str(i.query);
  if (!detail) return name;
  const oneLine = detail.replace(/\s+/g, " ").trim();
  return `${name}: ${oneLine.length > 120 ? `${oneLine.slice(0, 117)}...` : oneLine}`;
}

/** The fields of request.approval that describe what the tool will touch. */
export function approvalScope(name: string, input: unknown, blockedPath: string | undefined): { command: string | null; paths: string[]; network: boolean } {
  const i = rec(input);
  const paths = [str(i.file_path), str(i.notebook_path), str(i.path), str(blockedPath)].filter((p): p is string => p !== null);
  return {
    command: SHELL_TOOLS.includes(name) ? str(i.command) : null,
    paths: [...new Set(paths)],
    network: NETWORK_TOOLS.includes(name),
  };
}

/**
 * Decisions the role policy makes without asking anyone. Read-only roles are enforced here and
 * by disallowedTools, never by the prompt. Returns null when the user has to decide.
 */
export function policyDecision(name: string, policy: RolePolicy): PermissionResult | null {
  if (SUBAGENT_TOOLS.includes(name)) {
    return { behavior: "deny", message: `${name} is not allowed: Crewyard runs every agent of the crew itself.` };
  }
  if (policy.writes === "none" && WRITE_TOOLS.includes(name)) {
    return { behavior: "deny", message: `${name} is not allowed: this role is read-only.` };
  }
  if (policy.network === "denied" && NETWORK_TOOLS.includes(name)) {
    return { behavior: "deny", message: `${name} is not allowed: network access is off for this role.` };
  }
  return null;
}

/**
 * The CLI leaves its task-list tools out in SDK mode unless allowedTools names them (checked on
 * 2.1.306: default init lists only Task and TaskStop). They only edit the session's own plan,
 * which is where plan.update comes from, so they are named and pre-approved for every role.
 * TodoWrite covers CLI versions that still use it.
 */
export const PLAN_TOOLS = ["TodoWrite", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate"];

/**
 * Tools the CLI should never offer to the model for this policy. Read-only roles run in
 * "dontAsk" mode, where AskUserQuestion is always denied, so it is not offered either.
 */
export function disallowedFor(policy: RolePolicy): string[] {
  return [
    ...SUBAGENT_TOOLS,
    ...(policy.writes === "none" ? [...WRITE_TOOLS, "AskUserQuestion"] : []),
    ...(policy.network === "denied" ? NETWORK_TOOLS : []),
  ];
}

/**
 * Read-only roles run in the CLI's "dontAsk" permission mode: the engine itself denies every call
 * that would need an approval, and only reads, the CLI's own read-only commands and these rules
 * run. They pre-approve the role's allowlisted commands (the project's test and build commands),
 * which in "default" mode the daemon would have approved through the Inbox.
 */
export function readOnlyAllowRules(policy: RolePolicy): string[] {
  return policy.allowCommands.flatMap((cmd) => SHELL_TOOLS.flatMap((tool) => [`${tool}(${cmd})`, `${tool}(${cmd} *)`]));
}

export function permissionModeFor(policy: RolePolicy): "dontAsk" | "default" {
  // "default", not unset: the CLI may otherwise start in "auto" and approve tools without asking us.
  return policy.writes === "none" ? "dontAsk" : "default";
}

/**
 * "Allow always" keeps the CLI's suggested rules for this session only. Suggestions can point
 * at localSettings, which would write into the user's repository; we never want that.
 */
function sessionOnly(suggestions: PermissionUpdate[] | undefined): PermissionUpdate[] | undefined {
  return suggestions?.map((s) => ({ ...s, destination: "session" }) as PermissionUpdate);
}

export function approvalResult(answer: Answer, input: Record<string, unknown>, opts: { suggestions?: PermissionUpdate[]; suppressAlwaysAllowRule?: boolean }): PermissionResult {
  if (answer.kind === "cancel") return { behavior: "deny", message: "The user cancelled this request.", interrupt: true };
  if (answer.kind !== "approval") return { behavior: "deny", message: "The answer did not match the request." };
  if (answer.decision === "deny") return { behavior: "deny", message: answer.message?.trim() || "The user denied this tool call." };
  const updatedPermissions = answer.decision === "allow_always" && !opts.suppressAlwaysAllowRule ? sessionOnly(opts.suggestions) : undefined;
  return { behavior: "allow", updatedInput: input, ...(updatedPermissions?.length ? { updatedPermissions } : {}) };
}

export function questionsFrom(input: Record<string, unknown>): Question[] {
  const qs = (input as Partial<AskUserQuestionInput>).questions ?? [];
  return qs.map((q) => ({
    prompt: q.question,
    options: q.options.map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })),
    // AskUserQuestion always offers a free-text "Other" (see its schema: "There should be no 'Other' option").
    allowFreeText: true,
  }));
}

/**
 * AskUserQuestion is answered by allowing the tool with `answers` filled in, keyed by question
 * text. Several selected labels are joined with ", " (the form the CLI's own picker sends).
 */
export function questionResult(answer: Answer, input: Record<string, unknown>): PermissionResult {
  if (answer.kind === "cancel") return { behavior: "deny", message: "The user dismissed the question." };
  if (answer.kind !== "question") return { behavior: "deny", message: "The answer did not match the request." };
  const qs = (input as Partial<AskUserQuestionInput>).questions ?? [];
  const answers: Record<string, string> = {};
  const annotations: Record<string, { notes: string }> = {};
  qs.forEach((q, i) => {
    const a = answer.answers[i];
    if (!a) return;
    const text = a.text?.trim();
    const picked = a.selected.join(", ");
    answers[q.question] = picked || text || "";
    if (picked && text) annotations[q.question] = { notes: text };
  });
  return { behavior: "allow", updatedInput: { ...input, answers, ...(Object.keys(annotations).length ? { annotations } : {}) } };
}
