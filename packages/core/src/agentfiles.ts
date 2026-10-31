import type { ProfileRunner } from "./ipc/providers.ts";

// Your own agent files (docs/adr/0015): instruction files, skills, custom commands and subagents
// you wrote for Claude Code, Codex, Gemini CLI, OpenCode and other AI tools. Each Crewyard profile
// runs its CLI in a config folder of its own (PLAN.md D4), so none of your personal setup reaches a
// run unless you share it. This module is pure: where each tool keeps what, which names may ever be
// opened, how a file is converted for another runner, and what a project bridge asks of each runner.
// The daemon (packages/daemon/src/agentfiles) does the reading and the copying.
//
// Everything found here is untrusted instruction text. It never grants a permission: role
// enforcement, approvals, the allowlist and spend caps stay as they are (PLAN.md §9.1).

/** The tool whose format a file is in. `agents` is the cross-tool AGENTS.md (agents.md). */
export type AgentTool = "claude" | "codex" | "gemini" | "opencode" | "cursor" | "windsurf" | "copilot" | "cline" | "agents";
export const AGENT_TOOLS: readonly AgentTool[] = ["claude", "codex", "gemini", "opencode", "agents", "cursor", "windsurf", "copilot", "cline"];

/**
 * - `instructions`: a memory or rules file read into every session (CLAUDE.md, AGENTS.md, GEMINI.md,
 *   Cursor, Windsurf, Copilot and Cline rules).
 * - `skill`: a folder with SKILL.md and whatever files it ships.
 * - `command`: a custom slash command or prompt (Markdown, or TOML for Gemini CLI).
 * - `agent`: a subagent definition. Crewyard runs every runner without subagents, so these are listed
 *   and never shared.
 */
export type AgentFileKind = "instructions" | "skill" | "command" | "agent";
export type AgentFileScope = "user" | "project";

/** Where a tool keeps something, relative to the user's home or to the project folder. */
export interface AgentFileLocation {
  tool: AgentTool;
  scope: AgentFileScope;
  kind: AgentFileKind;
  /**
   * Path segments under the base. For the user scope the base is the home folder unless `base` says
   * otherwise; the daemon replaces it with the tool's own override variable where it has one.
   */
  path: string[];
  /** `file`: one file. `dir`: every entry of the folder with `ext` (a skill is a sub-folder with SKILL.md). */
  shape: "file" | "dir";
  /** File extensions taken from a `dir` location; skills ignore it. */
  ext?: string[];
  /** The user-scope base: the home folder, or a tool's own folder named by an environment variable. */
  base?: "home" | "claude" | "codex" | "gemini" | "opencode" | "documents";
}

// Every location here is an allowlist entry: nothing outside them is ever listed or opened. Sources
// for each, with the date checked, are in docs/adr/0015.
export const AGENT_FILE_LOCATIONS: readonly AgentFileLocation[] = [
  // Claude Code (code.claude.com/docs/en/memory, /skills, /sub-agents). Commands are merged into skills.
  { tool: "claude", scope: "user", kind: "instructions", base: "claude", path: ["CLAUDE.md"], shape: "file" },
  { tool: "claude", scope: "user", kind: "instructions", base: "claude", path: ["rules"], shape: "dir", ext: [".md"] },
  { tool: "claude", scope: "user", kind: "skill", base: "claude", path: ["skills"], shape: "dir" },
  { tool: "claude", scope: "user", kind: "command", base: "claude", path: ["commands"], shape: "dir", ext: [".md"] },
  { tool: "claude", scope: "user", kind: "agent", base: "claude", path: ["agents"], shape: "dir", ext: [".md"] },
  { tool: "claude", scope: "project", kind: "instructions", path: ["CLAUDE.md"], shape: "file" },
  { tool: "claude", scope: "project", kind: "instructions", path: [".claude", "CLAUDE.md"], shape: "file" },
  { tool: "claude", scope: "project", kind: "instructions", path: [".claude", "rules"], shape: "dir", ext: [".md"] },
  { tool: "claude", scope: "project", kind: "skill", path: [".claude", "skills"], shape: "dir" },
  { tool: "claude", scope: "project", kind: "command", path: [".claude", "commands"], shape: "dir", ext: [".md"] },
  { tool: "claude", scope: "project", kind: "agent", path: [".claude", "agents"], shape: "dir", ext: [".md"] },
  // Codex (learn.chatgpt.com/docs: agents-md, build-skills, custom-prompts, subagents). `$CODEX_HOME/skills`
  // is still read for backward compatibility (codex-rs/ext/skills/src/host_roots.rs); prompts are deprecated.
  { tool: "codex", scope: "user", kind: "instructions", base: "codex", path: ["AGENTS.md"], shape: "file" },
  { tool: "codex", scope: "user", kind: "instructions", base: "codex", path: ["AGENTS.override.md"], shape: "file" },
  { tool: "codex", scope: "user", kind: "skill", base: "codex", path: ["skills"], shape: "dir" },
  { tool: "codex", scope: "user", kind: "command", base: "codex", path: ["prompts"], shape: "dir", ext: [".md"] },
  { tool: "codex", scope: "user", kind: "agent", base: "codex", path: ["agents"], shape: "dir", ext: [".toml"] },
  { tool: "codex", scope: "project", kind: "agent", path: [".codex", "agents"], shape: "dir", ext: [".toml"] },
  // Gemini CLI (geminicli.com/docs: gemini-md, custom-commands, skills, subagents)
  { tool: "gemini", scope: "user", kind: "instructions", base: "gemini", path: ["GEMINI.md"], shape: "file" },
  { tool: "gemini", scope: "user", kind: "skill", base: "gemini", path: ["skills"], shape: "dir" },
  { tool: "gemini", scope: "user", kind: "command", base: "gemini", path: ["commands"], shape: "dir", ext: [".toml"] },
  { tool: "gemini", scope: "user", kind: "agent", base: "gemini", path: ["agents"], shape: "dir", ext: [".md"] },
  { tool: "gemini", scope: "project", kind: "instructions", path: ["GEMINI.md"], shape: "file" },
  { tool: "gemini", scope: "project", kind: "skill", path: [".gemini", "skills"], shape: "dir" },
  { tool: "gemini", scope: "project", kind: "command", path: [".gemini", "commands"], shape: "dir", ext: [".toml"] },
  { tool: "gemini", scope: "project", kind: "agent", path: [".gemini", "agents"], shape: "dir", ext: [".md"] },
  // OpenCode (opencode.ai/docs: rules, skills, commands, agents; 2.x takes singular and plural folder names)
  { tool: "opencode", scope: "user", kind: "instructions", base: "opencode", path: ["AGENTS.md"], shape: "file" },
  { tool: "opencode", scope: "user", kind: "skill", base: "opencode", path: ["skills"], shape: "dir" },
  { tool: "opencode", scope: "user", kind: "skill", base: "opencode", path: ["skill"], shape: "dir" },
  { tool: "opencode", scope: "user", kind: "command", base: "opencode", path: ["commands"], shape: "dir", ext: [".md"] },
  { tool: "opencode", scope: "user", kind: "command", base: "opencode", path: ["command"], shape: "dir", ext: [".md"] },
  { tool: "opencode", scope: "user", kind: "agent", base: "opencode", path: ["agents"], shape: "dir", ext: [".md"] },
  { tool: "opencode", scope: "user", kind: "agent", base: "opencode", path: ["agent"], shape: "dir", ext: [".md"] },
  { tool: "opencode", scope: "project", kind: "skill", path: [".opencode", "skills"], shape: "dir" },
  { tool: "opencode", scope: "project", kind: "skill", path: [".opencode", "skill"], shape: "dir" },
  { tool: "opencode", scope: "project", kind: "command", path: [".opencode", "commands"], shape: "dir", ext: [".md"] },
  { tool: "opencode", scope: "project", kind: "command", path: [".opencode", "command"], shape: "dir", ext: [".md"] },
  { tool: "opencode", scope: "project", kind: "agent", path: [".opencode", "agents"], shape: "dir", ext: [".md"] },
  { tool: "opencode", scope: "project", kind: "agent", path: [".opencode", "agent"], shape: "dir", ext: [".md"] },
  // Cross-tool: AGENTS.md (agents.md) and the `.agents/skills` folder Codex, Gemini CLI and OpenCode read.
  { tool: "agents", scope: "user", kind: "skill", base: "home", path: [".agents", "skills"], shape: "dir" },
  { tool: "agents", scope: "project", kind: "instructions", path: ["AGENTS.md"], shape: "file" },
  { tool: "agents", scope: "project", kind: "skill", path: [".agents", "skills"], shape: "dir" },
  // Cursor (cursor.com/docs/context/rules). User rules live in Cursor's settings, not in a file; the
  // legacy `.cursorrules` is still read by Cline (docs.cline.bot) and is offered for bridging.
  { tool: "cursor", scope: "project", kind: "instructions", path: [".cursorrules"], shape: "file" },
  { tool: "cursor", scope: "project", kind: "instructions", path: [".cursor", "rules"], shape: "dir", ext: [".mdc"] },
  // Windsurf, now Devin Local (docs.devin.ai/desktop/cascade/memories); the legacy files are still imported.
  { tool: "windsurf", scope: "user", kind: "instructions", base: "home", path: [".devin", "global_rules.md"], shape: "file" },
  { tool: "windsurf", scope: "user", kind: "instructions", base: "home", path: [".devin", "rules"], shape: "dir", ext: [".md"] },
  { tool: "windsurf", scope: "project", kind: "instructions", path: [".devin", "rules"], shape: "dir", ext: [".md"] },
  { tool: "windsurf", scope: "project", kind: "instructions", path: [".windsurfrules"], shape: "file" },
  { tool: "windsurf", scope: "project", kind: "instructions", path: [".windsurf", "rules"], shape: "dir", ext: [".md"] },
  // GitHub Copilot (docs.github.com: repository custom instructions; code.visualstudio.com: prompt files)
  { tool: "copilot", scope: "project", kind: "instructions", path: [".github", "copilot-instructions.md"], shape: "file" },
  { tool: "copilot", scope: "project", kind: "instructions", path: [".github", "instructions"], shape: "dir", ext: [".instructions.md"] },
  { tool: "copilot", scope: "project", kind: "command", path: [".github", "prompts"], shape: "dir", ext: [".prompt.md"] },
  // Cline (docs.cline.bot/features/cline-rules)
  { tool: "cline", scope: "user", kind: "instructions", base: "documents", path: ["Cline", "Rules"], shape: "dir", ext: [".md", ".txt"] },
  { tool: "cline", scope: "user", kind: "instructions", base: "home", path: [".cline", "rules"], shape: "dir", ext: [".md", ".txt"] },
  { tool: "cline", scope: "project", kind: "instructions", path: [".clinerules"], shape: "dir", ext: [".md", ".txt"] },
  { tool: "cline", scope: "project", kind: "instructions", path: [".cline", "rules"], shape: "dir", ext: [".md", ".txt"] },
];

/** Caps on what discovery opens. Anything over them is listed as skipped with the reason, never read. */
export const AGENT_FILE_LIMITS = {
  /** One instruction, command or agent file, and SKILL.md. */
  fileBytes: 256 * 1024,
  /** Everything one skill folder holds. */
  skillBytes: 5 * 1024 * 1024,
  skillFiles: 200,
  skillDepth: 4,
  /** Entries taken from one folder location; the rest are reported as `too_many`. */
  perFolder: 200,
  /** Characters of a file shown as its preview. */
  previewChars: 4_000,
  descriptionChars: 200,
  /** One bridged file handed to a runner that reads its contents (Claude Code, through the system prompt). */
  bridgeBytes: 64 * 1024,
} as const;

/**
 * Names never opened, listed or copied, wherever they sit (also inside a skill folder): credential
 * and token stores, env files, keys and every runner's settings file, which can carry env, hooks,
 * API key helpers and MCP commands. Compared without case.
 */
const DENIED_NAMES = new Set([
  ".credentials.json",
  "credentials.json",
  "auth.json",
  "oauth_creds.json",
  "google_accounts.json",
  "mcp-oauth-tokens.json",
  "mcp-oauth.json",
  "installation_id",
  "settings.json",
  "settings.local.json",
  "config.toml",
  "config.json",
  "opencode.json",
  "opencode.jsonc",
  ".mcp.json",
  "mcp.json",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "id_rsa",
  "id_ed25519",
  "hooks.json",
  ".claude.json",
  "remote-settings.json",
  "policy-limits.json",
  "trustedfolders.json",
  "mcp-auth.json",
]);

const DENIED_PATTERNS = [/^\.env(\..*)?$/i, /token/i, /secret/i, /credential/i, /\.(pem|key|p12|pfx|crt|cer|keychain|kdbx|sqlite|db)$/i, /^oauth/i, /^auth[._-]/i];

/** True for a file or folder name that discovery must never open. */
export function isDeniedName(name: string): boolean {
  const lower = name.toLowerCase();
  return DENIED_NAMES.has(lower) || DENIED_PATTERNS.some((re) => re.test(lower));
}

/**
 * Files that run rather than instruct. A skill that ships one is copied only with an explicit tick;
 * a file with no extension counts when it starts with `#!`, which the daemon checks.
 */
const SCRIPT_EXT = new Set([
  ".py", ".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".sh", ".bash", ".zsh", ".fish", ".ps1", ".psm1", ".psd1",
  ".bat", ".cmd", ".com", ".exe", ".dll", ".so", ".dylib", ".msi", ".vbs", ".wsf", ".rb", ".pl", ".php", ".lua",
  ".jar", ".go", ".rs", ".swift", ".scpt", ".applescript", ".r", ".jl",
]);

export function isScriptName(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot > 0 && SCRIPT_EXT.has(name.slice(dot).toLowerCase());
}

/**
 * A command or skill body that runs a shell command when it is used: Claude Code's and OpenCode's
 * "!`cmd`" and Gemini CLI's "!{cmd}". Flagged like a script file.
 */
export function hasInlineShell(text: string): boolean {
  // Claude Code skills also run a fenced block opened with ```! (code.claude.com/docs/en/skills).
  return /!`[^`\n]+`/.test(text) || /!\{[^}]*\}/.test(text) || /^\s*```!/m.test(text);
}

// ---------------------------------------------------------------- front matter

export interface FrontMatter {
  /** Top-level keys in their order of appearance. */
  keys: string[];
  /** Plain one-line scalar values of top-level keys. */
  values: Record<string, string>;
  /** The text after the closing `---`, or the whole text when there is no front matter. */
  body: string;
  /** The front matter lines without the fences; empty when there is none. */
  lines: string[];
}

/** Line-based reading of a Markdown file's YAML front matter; enough for names, descriptions and keys to drop. */
export function readFrontMatter(text: string): FrontMatter {
  const src = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const empty: FrontMatter = { keys: [], values: {}, body: src, lines: [] };
  if (!src.startsWith("---\n")) return empty;
  const end = src.indexOf("\n---", 3);
  if (end < 0) return empty;
  const after = src.indexOf("\n", end + 4);
  const lines = src.slice(4, end).split("\n");
  const keys: string[] = [];
  const values: Record<string, string> = {};
  for (const line of lines) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    keys.push(m[1]!);
    const v = m[2]!.trim();
    if (v && !/^[|>]/.test(v)) values[m[1]!] = unquote(v);
  }
  return { keys, values, body: after < 0 ? "" : src.slice(after + 1), lines };
}

function unquote(v: string): string {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

/**
 * Front matter keys that would let a file change what a run may do or spend: pre-approved tools,
 * hooks, permissions, a model of its own, subtasks that start subagents. They are removed from every
 * copy, so Crewyard's approvals, role policy and crew choice still decide.
 */
export const STRIPPED_KEYS = ["allowed-tools", "allowedtools", "allowed_tools", "disallowed-tools", "hooks", "permission", "permissions", "permissionmode", "permission-mode", "tools", "model", "subtask", "agent", "mcp", "mcpservers", "mcp-servers", "context"];

/** The keys of `fm` that copying removes. */
export function strippedKeysOf(fm: FrontMatter): string[] {
  return fm.keys.filter((k) => STRIPPED_KEYS.includes(k.toLowerCase()));
}

/** Markdown with the stripped keys (and their indented values) taken out of the front matter. */
export function stripFrontMatter(text: string): string {
  const fm = readFrontMatter(text);
  if (fm.lines.length === 0) return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const kept: string[] = [];
  let dropping = false;
  for (const line of fm.lines) {
    const key = /^([A-Za-z_][\w-]*)\s*:/.exec(line)?.[1];
    if (key !== undefined) dropping = STRIPPED_KEYS.includes(key.toLowerCase());
    else if (!/^\s/.test(line) && line.trim() !== "") dropping = false;
    if (!dropping) kept.push(line);
  }
  const head = kept.length > 0 ? `---\n${kept.join("\n")}\n---\n` : "";
  return `${head}${fm.body}`;
}

/** Lines of a memory file that import another file (`@path`, Claude Code and Gemini CLI). Never followed. */
export function importsOf(text: string): string[] {
  const out: string[] = [];
  let fence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    const m = /^\s*@([^\s@`][^\s`]*)\s*$/.exec(line);
    if (m) out.push(m[1]!);
  }
  return out;
}

// ---------------------------------------------------------------- commands

/** A command reduced to what every runner's format can carry. */
export interface PortableCommand {
  description: string | null;
  /** The prompt with arguments written as `$ARGUMENTS`. */
  prompt: string;
}

/** Reads a command file: Markdown with optional front matter, or Gemini CLI's TOML (`prompt`, `description`). */
export function parseCommand(text: string, format: "md" | "toml"): PortableCommand | null {
  if (format === "md") {
    const fm = readFrontMatter(text);
    return { description: fm.values.description ?? null, prompt: fm.body.replace(/^\n+/, "") };
  }
  const prompt = tomlString(text, "prompt");
  if (prompt === null) return null;
  return { description: tomlString(text, "description"), prompt: prompt.replace(/\{\{args\}\}/g, "$ARGUMENTS") };
}

/**
 * One string value of a top-level TOML key: basic, literal, or either multi-line form. Enough for
 * Gemini CLI command files; anything else returns null and the file is listed as unreadable.
 */
export function tomlString(text: string, key: string): string | null {
  const src = text.replace(/\r\n?/g, "\n");
  const re = new RegExp(`^${key}\\s*=\\s*`, "m");
  const m = re.exec(src);
  if (!m) return null;
  const rest = src.slice(m.index + m[0].length);
  for (const q of ['"""', "'''"]) {
    if (rest.startsWith(q)) {
      const end = rest.indexOf(q, 3);
      if (end < 0) return null;
      const raw = rest.slice(3, end).replace(/^\n/, "");
      return q === '"""' ? unescapeBasic(raw.replace(/\\\n\s*/g, "")) : raw;
    }
  }
  if (rest.startsWith('"')) {
    const m2 = /^"((?:[^"\\\n]|\\.)*)"/.exec(rest);
    return m2 ? unescapeBasic(m2[1]!) : null;
  }
  if (rest.startsWith("'")) {
    const m2 = /^'([^'\n]*)'/.exec(rest);
    return m2 ? m2[1]! : null;
  }
  return null;
}

function unescapeBasic(s: string): string {
  return s.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, e: string) => {
    if (e[0] === "u" || e[0] === "U") return String.fromCodePoint(parseInt(e.slice(1), 16));
    return ({ n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", b: "\b", f: "\f" } as Record<string, string>)[e] ?? e;
  });
}

/** TOML basic multi-line string body: backslashes and runs of quotes escaped. */
function tomlMultiline(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"""/g, '""\\"');
}

/** A command as Markdown with only a `description` in its front matter (Claude Code, Codex, OpenCode). */
export function commandMarkdown(c: PortableCommand): string {
  const desc = c.description ? `---\ndescription: ${JSON.stringify(c.description.replace(/\s+/g, " ").trim())}\n---\n` : "";
  return `${desc}${c.prompt.endsWith("\n") ? c.prompt : `${c.prompt}\n`}`;
}

/** A command as Gemini CLI TOML: `description` and `prompt`, arguments as `{{args}}`. */
export function commandToml(c: PortableCommand): string {
  const lines = ["# Copied by Crewyard; edit the original and press Sync."];
  if (c.description) lines.push(`description = ${JSON.stringify(c.description.replace(/\s+/g, " ").trim())}`);
  lines.push(`prompt = """\n${tomlMultiline(c.prompt.replace(/\$ARGUMENTS/g, "{{args}}"))}"""`, "");
  return lines.join("\n");
}

// ---------------------------------------------------------------- sharing

/** How a kind reaches a runner's profile folder: as it is, converted, or not at all (with the reason). */
export type ShareSupport = { how: "native" | "converted" } | { how: "none"; reason: "subagents_off" | "no_skills" | "no_commands" | "not_shareable" };

/** What each runner reads from its own config folder, so what sharing can copy there (docs/adr/0015). */
export function shareSupport(runner: ProfileRunner, kind: AgentFileKind, tool: AgentTool): ShareSupport {
  if (kind === "agent") return { how: "none", reason: "subagents_off" };
  if (kind === "instructions") return { how: nativeInstructionTool(runner).includes(tool) ? "native" : "converted" };
  if (kind === "skill") return { how: "native" };
  // Codex custom prompts are deprecated in favour of skills and expand only in its own terminal UI,
  // never in the app-server threads Crewyard drives.
  if (runner === "codex") return { how: "none", reason: "no_commands" };
  // Commands: Gemini CLI takes TOML, the others Markdown.
  const toml = tool === "gemini";
  if (runner === "gemini-cli") return { how: toml ? "native" : "converted" };
  return { how: toml ? "converted" : "native" };
}

function nativeInstructionTool(runner: ProfileRunner): AgentTool[] {
  if (runner === "claude-code") return ["claude"];
  if (runner === "gemini-cli") return ["gemini"];
  return ["codex", "opencode", "agents"];
}

/**
 * Where a shared item lands inside a profile folder, relative to it. Instruction files of every
 * shared item are joined into the runner's one user memory file; a skill keeps its folder name, a
 * command its file name in the runner's own extension.
 */
export function shareTarget(runner: ProfileRunner, kind: Exclude<AgentFileKind, "agent">, name: string): string[] {
  const root = USER_ROOT[runner];
  if (kind === "instructions") return [...root, MEMORY_FILE[runner]];
  if (kind === "skill") return [...root, "skills", name];
  return [...root, COMMAND_DIR[runner], `${name}${runner === "gemini-cli" ? ".toml" : ".md"}`];
}

/** The runner's user-level folder inside a profile folder (PLAN.md §5.2 "Account folder"). */
const USER_ROOT: Record<ProfileRunner, string[]> = {
  "claude-code": [],
  codex: [],
  "gemini-cli": [".gemini"],
  opencode: ["config", "opencode"],
};

export const MEMORY_FILE: Record<ProfileRunner, string> = {
  "claude-code": "CLAUDE.md",
  codex: "AGENTS.md",
  "gemini-cli": "GEMINI.md",
  opencode: "AGENTS.md",
};

const COMMAND_DIR: Record<ProfileRunner, string> = {
  "claude-code": "commands",
  codex: "prompts",
  "gemini-cli": "commands",
  opencode: "commands",
};

/** First line of a memory file Crewyard composed; a file without it is someone else's and is never overwritten. */
export const MEMORY_MARKER = "<!-- Written by Crewyard from the instruction files you shared. Edit the originals and press Sync; changes here are overwritten. -->";

export interface MemorySection {
  itemId: string;
  source: string;
  text: string;
}

/** The composed memory file: the marker, then each shared file as a section that names its source. */
export function composeMemory(sections: readonly MemorySection[]): string {
  const parts = [MEMORY_MARKER, ""];
  for (const s of sections) {
    parts.push(`<!-- crewyard:begin ${s.itemId} ${s.source.replace(/--+/g, "-")} -->`, s.text.replace(/\r\n?/g, "\n").trimEnd(), `<!-- crewyard:end ${s.itemId} -->`, "");
  }
  return parts.join("\n");
}

/** A skill or command name usable as a file or folder name on every platform, spaces included. */
export function safeName(name: string): string | null {
  const n = name.trim();
  if (!n || n.length > 64 || n === "." || n === "..") return null;
  // Spaces are fine on every platform; a trailing dot or space is dropped by Windows, so it is refused.
  if (!/^[A-Za-z0-9][\w .-]*$/.test(n) || /[ .]$/.test(n)) return null;
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) return null;
  return n;
}

/**
 * The state of one copy:
 * - `current`: the profile has what the source holds now.
 * - `outdated`: the source changed since the last copy.
 * - `missing`: never copied to this profile yet, or the copy was deleted.
 * - `modified`: someone changed the copy in the profile folder; Sync puts the source back.
 * - `source_missing`: the original is gone; the copy stays until you stop sharing.
 */
export type CopyState = "current" | "outdated" | "missing" | "modified" | "source_missing";

export function copyState(input: { sourceHash: string | null; copiedSourceHash: string | null; destHash: string | null; copiedDestHash: string | null }): CopyState {
  if (input.sourceHash === null) return "source_missing";
  if (input.copiedSourceHash === null || input.destHash === null) return "missing";
  if (input.destHash !== input.copiedDestHash) return "modified";
  return input.sourceHash === input.copiedSourceHash ? "current" : "outdated";
}

// ---------------------------------------------------------------- bridging

/** Project instruction files a bridge can offer, in this order, relative to the project root. */
export const BRIDGE_FILES: readonly string[] = ["AGENTS.md", "CLAUDE.md", "GEMINI.md", ".github/copilot-instructions.md", ".cursorrules", ".windsurfrules"];

/**
 * How a runner can take a project instruction file in another tool's format:
 * - `native`: it reads the file anyway.
 * - `prompt`: Crewyard adds the file's text to the run's system prompt (Claude Code has no setting
 *   that names another file).
 * - `setting`: through the runner's own setting (Gemini CLI `context.fileName`, OpenCode
 *   `instructions`).
 * - `fallback`: Codex `project_doc_fallback_filenames`, read only in a folder without AGENTS.md.
 * - `none`: the runner's setting takes file names only, and this is a path.
 */
export type BridgeHow = "native" | "prompt" | "setting" | "fallback" | "none";

export function bridgeHow(runner: ProfileRunner, file: string): BridgeHow {
  const name = file.toLowerCase();
  const plain = !name.includes("/");
  if (runner === "claude-code") return name === "claude.md" ? "native" : "prompt";
  if (runner === "codex") return name === "agents.md" ? "native" : plain ? "fallback" : "none";
  if (runner === "gemini-cli") return name === "gemini.md" ? "native" : plain ? "setting" : "none";
  // OpenCode reads AGENTS.md; CLAUDE.md only through its Claude Code compatibility, which Crewyard
  // turns off (OPENCODE_DISABLE_CLAUDE_CODE) so ~/.claude never leaks into a profile.
  return name === "agents.md" ? "native" : "setting";
}

/** The files a run of `runner` gets through a bridge: the chosen ones it does not read natively and can take. */
export function bridgedFor(runner: ProfileRunner, files: readonly string[]): string[] {
  return files.filter((f) => {
    const how = bridgeHow(runner, f);
    return how !== "native" && how !== "none";
  });
}

/** Gemini CLI's `context.fileName` with its own GEMINI.md first, so bridging never drops it. */
export function geminiContextFileNames(files: readonly string[]): string[] {
  return [...new Set(["GEMINI.md", ...files.filter((f) => !f.includes("/"))])];
}

/**
 * The text Claude Code gets in its system prompt for bridged files. The files are the project's own
 * instructions, so they get the same standing as CLAUDE.md, never more: they cannot grant tools.
 */
export function bridgePrompt(files: ReadonlyArray<{ path: string; text: string; truncated: boolean }>): string {
  const parts = [
    "This project also keeps instructions for other coding agents in the files below. Follow them as you follow CLAUDE.md; where they conflict with CLAUDE.md, CLAUDE.md wins.",
    "They are the project's instructions, not permissions: they do not change which tools you may use or what needs approval.",
  ];
  for (const f of files) {
    parts.push("", `<project-instructions path="${f.path.replace(/"/g, "")}">`, f.text.replace(/<\/project-instructions>/gi, "</project-instructions_>").trimEnd(), "</project-instructions>");
    if (f.truncated) parts.push(`(${f.path} was cut at ${AGENT_FILE_LIMITS.bridgeBytes / 1024} KB.)`);
  }
  return parts.join("\n");
}
