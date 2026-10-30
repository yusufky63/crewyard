import { utf8Length } from "./event-caps.ts";

// Crew reports over MCP (feature scan A14) and the MCP servers a run gets (docs/adr/0007).
// Everything an agent sends through these tools is untrusted data: it is checked and capped here,
// stored as plain text, and shown escaped. Nothing an agent sends can start a run (PLAN.md §9.1).

/** Server name of Crewyard's own report server in every runner's config; user servers may not take it. */
export const REPORT_SERVER = "crewyard";
export const REPORT_TOOL = "report";
export const FOLLOWUP_TOOL = "propose_followup";

export type CrewReportKind = "checkpoint" | "needs_input" | "stuck" | "done";
export const CREW_REPORT_KINDS: readonly CrewReportKind[] = ["checkpoint", "needs_input", "stuck", "done"];

/** What a stored report is: one of the report kinds, or a follow-up proposal. */
export type CrewReportType = CrewReportKind | "followup";

/** Kinds that become Inbox items; checkpoint and done only go to the timeline and the inspector. */
export const INBOX_REPORT_TYPES: readonly CrewReportType[] = ["needs_input", "stuck", "followup"];

export const REPORT_LIMITS = {
  /** A report's text and a follow-up's description. */
  textBytes: 2_000,
  titleBytes: 120,
  descriptionBytes: 4_000,
  artifacts: 10,
  artifactBytes: 260,
  /** Per run, so a looping agent cannot fill the Inbox or the database. */
  reportsPerRun: 100,
  followupsPerRun: 10,
  /** One JSON-RPC line on the pipe; anything longer is dropped and the connection closed. */
  lineBytes: 64 * 1024,
} as const;

export interface ReportInput {
  kind: CrewReportKind;
  text: string;
  /** Paths relative to the run's working folder, checked by the daemon to stay inside it. */
  artifacts: string[];
}

export interface FollowupInput {
  title: string;
  description: string;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

// C0/C1 controls (tab and newline kept) and bidirectional overrides, which could make a report read
// differently from what it says (a filename that renders reversed).
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F‎‏‪-‮⁦-⁩]/g;

/** Untrusted text as we store it: line breaks normalized, unsafe characters removed, trimmed. */
export function cleanText(s: string): string {
  return s.replace(/\r\n?/g, "\n").replace(UNSAFE, "").trim();
}

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

function text(v: unknown, field: string, max: number, required: boolean): Parsed<string> {
  if (v === undefined || v === null) return required ? { ok: false, error: `${field} is required` } : { ok: true, value: "" };
  if (typeof v !== "string") return { ok: false, error: `${field} must be a string` };
  const s = cleanText(v);
  if (required && !s) return { ok: false, error: `${field} must not be empty` };
  const n = utf8Length(s);
  // Refused rather than cut: the agent learns the limit and can say it shorter.
  if (n > max) return { ok: false, error: `${field} is ${n} bytes; the limit is ${max}` };
  return { ok: true, value: s };
}

/** Checks the arguments of a `report` call. Errors go back to the agent as the tool result. */
export function parseReport(args: unknown): Parsed<ReportInput> {
  const a = rec(args);
  if (!a) return { ok: false, error: "arguments must be an object" };
  if (typeof a.kind !== "string" || !CREW_REPORT_KINDS.includes(a.kind as CrewReportKind)) return { ok: false, error: `kind must be one of ${CREW_REPORT_KINDS.join(", ")}` };
  const t = text(a.text, "text", REPORT_LIMITS.textBytes, true);
  if (!t.ok) return t;
  const raw = a.artifacts ?? [];
  if (!Array.isArray(raw)) return { ok: false, error: "artifacts must be an array of paths" };
  if (raw.length > REPORT_LIMITS.artifacts) return { ok: false, error: `at most ${REPORT_LIMITS.artifacts} artifacts` };
  const artifacts: string[] = [];
  for (const p of raw) {
    const s = text(p, "artifact path", REPORT_LIMITS.artifactBytes, true);
    if (!s.ok) return s;
    if (/[\n\t]/.test(s.value)) return { ok: false, error: "an artifact path must be one line" };
    artifacts.push(s.value);
  }
  return { ok: true, value: { kind: a.kind as CrewReportKind, text: t.value, artifacts: [...new Set(artifacts)] } };
}

export function parseFollowup(args: unknown): Parsed<FollowupInput> {
  const a = rec(args);
  if (!a) return { ok: false, error: "arguments must be an object" };
  const title = text(a.title, "title", REPORT_LIMITS.titleBytes, true);
  if (!title.ok) return title;
  if (title.value.includes("\n")) return { ok: false, error: "title must be one line" };
  const description = text(a.description, "description", REPORT_LIMITS.descriptionBytes, false);
  if (!description.ok) return description;
  return { ok: true, value: { title: title.value, description: description.value } };
}

/**
 * The tool definitions the report server lists. Both are marked read-only (they change nothing in
 * the agent's environment), so read-only roles get them too.
 */
export const REPORT_TOOL_DEFS = [
  {
    name: REPORT_TOOL,
    title: "Report progress to Crewyard",
    description:
      "Tell the person supervising this run where you are. kind: checkpoint (a milestone reached), needs_input (you need an answer to continue; ask the question in text), stuck (you cannot make progress; say why), done (the task is finished). Keep text short. artifacts: optional paths of files you produced, relative to your working folder. A needs_input or stuck report is shown to the person; their answer, if any, arrives as your next message. This does not pause you.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: [...CREW_REPORT_KINDS] },
        text: { type: "string", maxLength: REPORT_LIMITS.textBytes },
        artifacts: { type: "array", items: { type: "string" }, maxItems: REPORT_LIMITS.artifacts },
      },
      required: ["kind", "text"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: FOLLOWUP_TOOL,
    title: "Propose a follow-up task",
    description:
      "Suggest work that is outside your current task. It goes to the person's Inbox as a proposal; nothing starts unless they turn it into a task and approve its crew. Do not use it for the work you were asked to do.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", maxLength: REPORT_LIMITS.titleBytes },
        description: { type: "string", maxLength: REPORT_LIMITS.descriptionBytes },
      },
      required: ["title"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
] as const;

// ------------------------------------------------------------------ user MCP servers

/** Server names end up in tool names (`mcp__<name>__<tool>`, `<name>_<tool>`), so they stay plain. */
export const MCP_SERVER_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
export const MCP_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** Names that hold a secret by their look: they must be stored as secrets (DPAPI), never as plain values. */
export const SECRET_ENV_NAME = /KEY|TOKEN|SECRET|PASSW|PASSPHRASE|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE/i;
/** Variables the runner or Crewyard sets for a server; a user entry may not override them. */
export const RESERVED_ENV_NAME = /^(CREWYARD_|ELECTRON_|NODE_OPTIONS$)/i;

export const MCP_LIMITS = { args: 32, argBytes: 1_024, env: 32, plainValueBytes: 4_096, secretValueBytes: 16_384, commandBytes: 1_024 } as const;

export type McpScope = "global" | "project";

/**
 * What a read-only role (planner, reviewer, researcher, security) gets from a user server:
 * `marked` only the tools the server itself marks `readOnlyHint` (needs a tools check),
 * `all` every tool (you vouch for the server), `none` the server is left out for those roles.
 */
export type McpReadOnlyAccess = "marked" | "all" | "none";

export interface McpEnvView {
  name: string;
  secret: boolean;
  /** Plain values only; a secret's value never leaves the daemon. */
  value: string | null;
  /** A secret with a stored (DPAPI) value. */
  stored: boolean;
}

export interface McpToolInfo {
  name: string;
  /** The server's own `readOnlyHint`; null when it did not say. */
  readOnly: boolean | null;
}

export type McpWarning =
  /** `npx pkg@latest` and other dist-tags: whatever is published at launch time runs. */
  | { code: "floating"; spec: string }
  /** A package runner with no exact version: same risk, quieter. */
  | { code: "unpinned"; spec: string }
  /** A .cmd/.bat shim: runners start it through cmd.exe, so arguments may not carry cmd syntax. */
  | { code: "shim" }
  /** The command was not found on PATH when last checked. */
  | { code: "not_found" };

export interface McpServerView {
  id: string;
  scope: McpScope;
  projectId: string | null;
  name: string;
  command: string;
  args: string[];
  env: McpEnvView[];
  enabled: boolean;
  readOnlyAccess: McpReadOnlyAccess;
  /** From the last tools check; null until one ran. */
  tools: McpToolInfo[] | null;
  checkedAt: string | null;
  /** Why the last check failed, in one line; never contains secret values. */
  checkError: string | null;
  warnings: McpWarning[];
  updatedAt: string;
}

export interface McpServerInput {
  /** Absent: a new server. */
  id?: string;
  scope: McpScope;
  /** Required for scope `project`. */
  projectId?: string | null;
  name: string;
  command: string;
  args: string[];
  /** A secret without `value` keeps its stored value; one with a value replaces it. */
  env: Array<{ name: string; secret: boolean; value?: string }>;
  enabled: boolean;
  readOnlyAccess: McpReadOnlyAccess;
}

/** The servers a run was given, recorded when it started ("which runs used which servers"). */
export interface McpRunUsage {
  runId: string;
  taskId: string;
  projectId: string;
  taskTitle: string;
  role: string;
  runner: string;
  startedAt: string;
  servers: Array<{ name: string; serverId: string | null; tools: string[] | null }>;
  /** User servers left out for this run, with why (`read_only`, `no_tool_filter`, `missing_secret`, `not_found`, `shell_syntax`). */
  skipped: Array<{ name: string; reason: string }>;
}

// ------------------------------------------------------------------ supply chain

const RUNNERS: Record<string, string[] | null> = {
  // runner -> subcommands that run a package (null: the runner itself does)
  npx: null,
  pnpx: null,
  bunx: null,
  uvx: null,
  pnpm: ["dlx", "exec"],
  yarn: ["dlx"],
  npm: ["exec", "x"],
  bun: ["x"],
  pipx: ["run"],
};

/** Flags of those runners that take the package spec as their value. */
const PACKAGE_FLAGS = new Set(["-p", "--package", "--from", "--with"]);
/** Flags that take some other value, which must not be read as the package. */
const VALUE_FLAGS = new Set(["-c", "--call", "--python", "--registry", "--cache", "--userconfig", "--index-url", "-i"]);

const EXACT = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** The version part of an npm or Python package spec, or null when there is none. */
function versionOf(spec: string): { version: string | null; python: boolean } {
  const py = /^[A-Za-z0-9_.[\]-]+\s*(==|===|>=|<=|~=|!=|>|<)\s*(.+)$/.exec(spec);
  if (py) return { version: py[1] === "==" || py[1] === "===" ? py[2]!.trim() : `${py[1]}${py[2]}`, python: true };
  const at = spec.lastIndexOf("@");
  if (at > 0) return { version: spec.slice(at + 1), python: false };
  return { version: null, python: false };
}

/** Local paths, URLs and git specs are not registry packages; what they run is up to you. */
const notRegistry = (spec: string) => /^(\.{0,2}[\\/]|[A-Za-z]:[\\/]|file:|https?:|git\+|github:)/.test(spec);

/** Package specs the command would download and run, read from the args of a known package runner. */
export function packageSpecs(command: string, args: readonly string[]): string[] {
  const base = (command.replace(/\\/g, "/").split("/").pop() ?? command).toLowerCase().replace(/\.(cmd|bat|exe|ps1)$/, "");
  if (!(base in RUNNERS)) return [];
  const subs = RUNNERS[base];
  let i = 0;
  if (subs) {
    while (i < args.length && args[i]!.startsWith("-")) i++;
    if (i >= args.length || !subs.includes(args[i]!)) return [];
    i++;
  }
  const specs: string[] = [];
  for (; i < args.length; i++) {
    const a = args[i]!;
    const eq = a.indexOf("=");
    const flag = a.startsWith("-") ? (eq > 0 ? a.slice(0, eq) : a) : null;
    if (flag && PACKAGE_FLAGS.has(flag)) {
      const v = eq > 0 ? a.slice(eq + 1) : args[++i];
      if (v) specs.push(v);
      continue;
    }
    if (flag) {
      if (VALUE_FLAGS.has(flag) && eq < 0) i++;
      continue;
    }
    // The first positional is the package (or, after --package, the binary name).
    if (specs.length === 0) specs.push(a);
    break;
  }
  return specs.filter((s) => !notRegistry(s));
}

/** Supply-chain warnings for a server command: floating tags and unpinned packages. */
export function commandWarnings(command: string, args: readonly string[]): McpWarning[] {
  const out: McpWarning[] = [];
  for (const spec of packageSpecs(command, args)) {
    const { version } = versionOf(spec);
    if (version !== null && EXACT.test(version)) continue;
    out.push(version !== null && /^[A-Za-z][\w.-]*$/.test(version) ? { code: "floating", spec } : { code: "unpinned", spec });
  }
  return out;
}

/** cmd.exe syntax that a shim would re-parse: such arguments are refused for .cmd/.bat commands. */
export const CMD_SYNTAX = /["%!^&|<>\r\n]/;

/** A check for a user server's fields; the first problem as an i18n code, or null. */
export function mcpInputProblem(input: McpServerInput): string | null {
  if (!MCP_SERVER_NAME.test(input.name)) return "mcp.name_invalid";
  if (input.name === REPORT_SERVER) return "mcp.name_reserved";
  if (input.scope === "project" && !input.projectId) return "mcp.project_required";
  const command = input.command.trim();
  if (!command || utf8Length(command) > MCP_LIMITS.commandBytes || /[\r\n]/.test(command)) return "mcp.command_invalid";
  if (input.args.length > MCP_LIMITS.args || input.args.some((a) => utf8Length(a) > MCP_LIMITS.argBytes || /[\r\n]/.test(a))) return "mcp.args_invalid";
  if (input.env.length > MCP_LIMITS.env) return "mcp.env_too_many";
  const seen = new Set<string>();
  for (const e of input.env) {
    if (!MCP_ENV_NAME.test(e.name) || RESERVED_ENV_NAME.test(e.name)) return "mcp.env_name_invalid";
    const key = e.name.toUpperCase();
    if (seen.has(key)) return "mcp.env_duplicate";
    seen.add(key);
    if (!e.secret && SECRET_ENV_NAME.test(e.name)) return "mcp.env_must_be_secret";
    if (e.value !== undefined && utf8Length(e.value) > (e.secret ? MCP_LIMITS.secretValueBytes : MCP_LIMITS.plainValueBytes)) return "mcp.env_value_too_long";
    if (e.value !== undefined && /[\r\n\0]/.test(e.value)) return "mcp.env_value_invalid";
  }
  return null;
}

// ------------------------------------------------------------------ what adapters receive

/**
 * One stdio MCP server for one run, already resolved by the daemon: an absolute command, the env
 * the server needs (secrets decrypted for this run only; adapters never log it).
 */
export interface McpServerSpec {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Tool names the run may call; null: every tool the server lists. */
  tools: string[] | null;
  /** Crewyard's own report server: its tools run without an approval in every role. */
  builtin: boolean;
}
