import { join } from "node:path";
import { createAdapter as createAcp } from "@crewyard/adapter-acp";
import { createAdapter as createClaude } from "@crewyard/adapter-claude";
import { createAdapter as createCodex } from "@crewyard/adapter-codex";
import { createAdapter as createOpenCode } from "@crewyard/adapter-opencode";
import type { AgentAdapter, CatalogProvider, Profile, RunnerId } from "@crewyard/core";
import { writeCodexConfig } from "../providers/directory.ts";

// How each runner is pointed at the fake model, with the documented knob for a custom endpoint
// (opened 2026-10-31):
//   Codex        [model_providers.<id>] base_url / env_key / wire_api = "responses" in CODEX_HOME's
//                config.toml (learn.chatgpt.com/docs/config-file/config-reference), written by
//                the daemon's own writeCodexConfig, as for a real provider
//   Claude Code  ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN, Anthropic Messages format
//                (code.claude.com/docs/en/llm-gateway-protocol), set by the adapter's buildEnv
//   OpenCode     an inline provider with "@ai-sdk/openai-compatible" and options.baseURL
//                (opencode.ai/docs/providers), set by the adapter for a profile with a base URL
//   Gemini CLI   GOOGLE_GEMINI_BASE_URL, plain http allowed for 127.0.0.1
//                (google-gemini/gemini-cli docs/reference/configuration.md; honoured since PR
//                #25357, merged 2026-04-15)
//
// Tool names and argument shapes are each CLI's own; they are the facts a version bump may change.

/** A placeholder the runners need to see as "a key"; it is not a credential anywhere. */
export const DUMMY_KEY = "cf-dummy-key-not-a-secret";

export interface ToolShape {
  name: string;
  args: Record<string, unknown>;
}

export interface Prepared {
  profile: Profile;
  env: Record<string, string>;
  model: string;
}

export interface RunnerSpec {
  runner: Exclude<RunnerId, "acp" | "fake">;
  label: string;
  /** Command looked up on PATH; the runner is skipped when it is missing. */
  command: string;
  adapter(): AgentAdapter;
  prepare(root: string, url: string): Prepared;
  /** A shell call that needs the user's approval (it writes a file in the worktree). */
  shell(tools: string[], command: string): ToolShape | null;
  /** The runner's own plan / todo tool, after whatever call makes it available; empty when it has none. */
  plan(tools: string[], transcript: string): ToolShape[];
  /** The runner's own question tool. */
  question(tools: string[]): ToolShape | null;
  /** Scenarios the CLI itself cannot pass, with the source that shows it; the adapter's capabilities say so too. */
  gaps?: { plan?: string };
}

const PLAN_STEPS = [
  { title: "Read the task", status: "completed" },
  { title: "Write the change", status: "in_progress" },
  { title: "Run the tests", status: "pending" },
] as const;

export const QUESTION = { prompt: "Which colour should the conformance check use?", options: ["Blue", "Green"] } as const;

const has = (tools: string[], name: string) => tools.includes(name);

function profile(runner: Profile["runner"], configDir: string, providerId: string, model: string, baseUrl: string | null): Profile {
  return { id: `cf-${runner}`, alias: `conformance-${runner}`, runner, providerId, credential: { kind: "api_key", secretRef: "conformance" }, defaultModel: model, configDir, baseUrl };
}

/** The catalog entry a custom OpenAI-compatible provider would have; only what writeCodexConfig reads. */
function fakeProvider(openaiBase: string): CatalogProvider {
  return {
    id: "conformance",
    name: "Conformance fake model",
    group: "local",
    env: ["CONFORMANCE_API_KEY"],
    docs: null,
    openaiBase,
    anthropicBase: null,
    runners: { claudeCode: "none", codex: "config", geminiCli: "none", opencode: "config" },
    balance: null,
    quota: null,
    ref: null,
    note: null,
    modelCount: 0,
    models: [],
  };
}

export const codex: RunnerSpec = {
  runner: "codex",
  label: "Codex",
  command: "codex",
  adapter: () => createCodex(),
  prepare(root, url) {
    const configDir = join(root, "codex home");
    writeCodexConfig(configDir, fakeProvider(`${url}/v1`));
    const model = "gpt-5.4";
    return { profile: profile("codex", configDir, "conformance", model, null), env: { CONFORMANCE_API_KEY: DUMMY_KEY }, model };
  },
  shell(tools, command) {
    // codex asks before leaving the sandbox only when the model requests escalation.
    if (has(tools, "shell_command")) return { name: "shell_command", args: { command, sandbox_permissions: "require_escalated", justification: "Conformance approval check" } };
    if (has(tools, "exec_command")) return { name: "exec_command", args: { cmd: command, sandbox_permissions: "require_escalated", justification: "Conformance approval check" } };
    if (has(tools, "shell")) return { name: "shell", args: { command: ["powershell.exe", "-NoProfile", "-Command", command], sandbox_permissions: "require_escalated", justification: "Conformance approval check" } };
    return null;
  },
  plan: (tools) => (has(tools, "update_plan") ? [{ name: "update_plan", args: { explanation: "Conformance plan", plan: PLAN_STEPS.map((s) => ({ step: s.title, status: s.status })) } }] : []),
  question: (tools) =>
    has(tools, "request_user_input")
      ? { name: "request_user_input", args: { questions: [{ id: "colour", header: "Colour", question: QUESTION.prompt, options: QUESTION.options.map((label) => ({ label, description: `Use ${label}.` })) }] } }
      : null,
};

export const claude: RunnerSpec = {
  runner: "claude-code",
  label: "Claude Code",
  command: "claude",
  adapter: () => createClaude(),
  prepare(root, url) {
    const configDir = join(root, "claude config");
    const model = "claude-sonnet-4-5";
    // No telemetry, update checks or feature-flag calls to Anthropic while it runs against the fake.
    return { profile: profile("claude-code", configDir, "conformance", model, url), env: { ANTHROPIC_AUTH_TOKEN: DUMMY_KEY, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }, model };
  },
  shell: (tools, command) => (has(tools, "Bash") ? { name: "Bash", args: { command, description: "Conformance approval check" } } : null),
  plan(tools, transcript) {
    if (has(tools, "TodoWrite")) return [{ name: "TodoWrite", args: { todos: PLAN_STEPS.map((s) => ({ content: s.title, activeForm: s.title, status: s.status })) } }];
    const create = { name: "TaskCreate", args: { subject: PLAN_STEPS[0].title, description: "Conformance plan", activeForm: PLAN_STEPS[0].title } };
    // 2.1.314 defers its task tools: the model loads TaskCreate's schema through ToolSearch first.
    // The deferred list stays in the conversation, so the second request still takes this branch.
    if (has(tools, "ToolSearch") && /deferred tools[\s\S]*\bTaskCreate\b/.test(transcript)) return [{ name: "ToolSearch", args: { query: "select:TaskCreate", max_results: 1 } }, create];
    return has(tools, "TaskCreate") ? [create] : [];
  },
  question: (tools) =>
    has(tools, "AskUserQuestion")
      ? { name: "AskUserQuestion", args: { questions: [{ question: QUESTION.prompt, header: "Colour", multiSelect: false, options: QUESTION.options.map((label) => ({ label, description: `Use ${label}.` })) }] } }
      : null,
};

export const opencode: RunnerSpec = {
  runner: "opencode",
  label: "OpenCode",
  command: "opencode",
  adapter: () => createOpenCode(),
  prepare(root, url) {
    const configDir = join(root, "opencode profile");
    const model = "cf-model";
    // The models.dev list is not needed for an inline provider; keep the run off the network.
    return { profile: profile("opencode", configDir, "conformance", model, `${url}/v1`), env: { OPENCODE_DISABLE_MODELS_FETCH: "1" }, model };
  },
  shell: (tools, command) => (has(tools, "bash") ? { name: "bash", args: { command } } : null),
  plan: (tools) => (has(tools, "todowrite") ? [{ name: "todowrite", args: { todos: PLAN_STEPS.map((s) => ({ content: s.title, status: s.status, priority: "medium" })) } }] : []),
  question: (tools) =>
    has(tools, "question") ? { name: "question", args: { questions: [{ question: QUESTION.prompt, header: "Colour", options: QUESTION.options.map((label) => ({ label, description: `Use ${label}.` })) }] } } : null,
};

export const gemini: RunnerSpec = {
  runner: "gemini-cli",
  label: "Gemini CLI",
  command: "gemini",
  adapter: () => createAcp(),
  prepare(root, url) {
    const configDir = join(root, "gemini home");
    const model = "gemini-2.5-flash";
    return { profile: profile("gemini-cli", configDir, "google", model, null), env: { GEMINI_API_KEY: DUMMY_KEY, GOOGLE_GEMINI_BASE_URL: url }, model };
  },
  shell: (tools, command) => (has(tools, "run_shell_command") ? { name: "run_shell_command", args: { command, description: "Conformance approval check" } } : null),
  plan: (tools) => (has(tools, "write_todos") ? [{ name: "write_todos", args: { todos: PLAN_STEPS.map((s) => ({ description: s.title, status: s.status })) } }] : []),
  question: (tools) =>
    has(tools, "ask_user") ? { name: "ask_user", args: { questions: [{ question: QUESTION.prompt, header: "Colour", type: "choice", options: QUESTION.options.map((label) => ({ label, description: `Use ${label}.` })) }] } } : null,
  gaps: { plan: "Gemini CLI's ACP session sends no plan session update, write_todos is a plain tool call (google-gemini/gemini-cli packages/cli/src/acp/acpSession.ts, v0.66.0)" },
};

export const RUNNERS: RunnerSpec[] = [codex, claude, opencode, gemini];
