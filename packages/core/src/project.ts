import { z } from "zod";
import { RunnerId } from "./events.ts";

// .crewyard/project.json, written by the New project wizard (PLAN.md §11.1). Never holds secrets.

export type CommandProblem = "empty" | "unclosed_quote" | "shell_syntax" | "multiline";

const SHELL_CHARS = new Set(["|", "&", ";", "<", ">", "`"]);

/**
 * Setup and cleanup commands run without a shell (AGENTS.md, Windows), so the text is split into a
 * program and arguments: `pnpm install --frozen-lockfile` -> ["pnpm", "install", "--frozen-lockfile"].
 * Double or single quotes group text with spaces; backslashes stay literal so Windows paths need no
 * escaping. Shell syntax is refused: passed along as plain arguments it would silently do
 * something other than what the user wrote.
 */
export function splitCommand(text: string): { argv: string[] } | { problem: CommandProblem } {
  if (/[\r\n\0]/.test(text)) return { problem: "multiline" };
  const argv: string[] = [];
  let cur = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (ch === " " || ch === "\t") {
      if (started) argv.push(cur);
      cur = "";
      started = false;
    } else if (SHELL_CHARS.has(ch)) {
      return { problem: "shell_syntax" };
    } else {
      cur += ch;
      started = true;
    }
  }
  if (quote) return { problem: "unclosed_quote" };
  if (started) argv.push(cur);
  if (argv.length === 0 || argv[0] === "") return { problem: "empty" };
  return { argv };
}

/** One setup or cleanup command, run in the task worktree without a shell, with its own timeout. */
export const BootstrapStep = z.object({
  command: z
    .string()
    .min(1)
    .max(2000)
    .refine((c) => "argv" in splitCommand(c), "a program and arguments without shell syntax"),
  timeoutSec: z.number().int().min(1).max(3600),
});
export type BootstrapStep = z.infer<typeof BootstrapStep>;

const UNSAFE_INCLUDE = /^[\\/]|^[a-z]:|(^|[\\/])\.\.([\\/]|$)|[*?<>|"\0]/i;

/** A path relative to the project root that stays inside it: no drive, no leading slash, no `..`, no wildcards, not `.git`. */
export const IncludePath = z
  .string()
  .min(1)
  .max(260)
  .refine((p) => !UNSAFE_INCLUDE.test(p) && !/^\.git([\\/]|$)/i.test(p), "a relative path inside the project");

/**
 * Worktree bootstrap (feature scan A1). Setup runs after a task worktree is created and before
 * the agent starts; cleanup runs before Crewyard removes or parks it. Every command is High risk
 * and is approved once in the Inbox against a hash of its exact text.
 */
export const WorktreeBootstrap = z.object({
  setup: z.array(BootstrapStep).max(20),
  cleanup: z.array(BootstrapStep).max(20),
  /** Gitignored files or folders copied (never linked) from the main checkout, e.g. `.env`. */
  include: z.array(IncludePath).max(50),
  includeMaxMb: z.number().int().min(1).max(4096),
  /** A stable port per branch from this range, exposed as `envVar` and as CREWYARD_PORT. */
  port: z
    .object({
      from: z.number().int().min(1024).max(65535),
      to: z.number().int().min(1024).max(65535),
      envVar: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
    })
    .refine((p) => p.to >= p.from, "to must not be below from")
    .nullable(),
});
export type WorktreeBootstrap = z.infer<typeof WorktreeBootstrap>;

export const DEFAULT_STEP_TIMEOUT_SEC = 600;
export const DEFAULT_PORT_RANGE = { from: 4100, to: 4999, envVar: "PORT" } as const;

export const defaultBootstrap = (): WorktreeBootstrap => ({ setup: [], cleanup: [], include: [], includeMaxMb: 64, port: null });

export const DEFAULT_MAX_ITERATIONS = 3;
export const defaultLoop = () => ({ maxIterations: DEFAULT_MAX_ITERATIONS });

export const ProjectConfig = z.object({
  version: z.literal(1),
  name: z.string().min(1),
  commands: z.object({ build: z.string().nullable(), test: z.string().nullable() }),
  runners: z.array(RunnerId),
  profiles: z.array(z.string()),
  budget: z.object({ dailyUsd: z.number().nonnegative(), perTaskUsd: z.number().nonnegative() }),
  rules: z.object({
    fallback: z.enum(["manual", "ask", "auto"]),
    slots: z.number().int().min(1).max(16),
    allowCommands: z.array(z.string()),
    network: z.enum(["ask", "allowed"]),
    toastApprovals: z.enum(["low", "none"]),
  }),
  worktreeRoot: z.string(),
  github: z.object({
    remote: z.string().nullable(),
    pushNeedsApproval: z.literal(true),
    actionsWarnPct: z.number().min(1).max(100),
  }),
  // Configs written before bootstrap existed read as "nothing to set up".
  bootstrap: WorktreeBootstrap.default(defaultBootstrap),
  // Run until green and the review loop (feature scan A9): fix attempts per step before the loop stops.
  loop: z.object({ maxIterations: z.number().int().min(1).max(10) }).default(defaultLoop),
});
export type ProjectConfig = z.infer<typeof ProjectConfig>;

const SECRET_KEY = /(key|token|secret|password|passwd|credential)/i;

/** Defense in depth: refuse to write a config that looks like it carries a secret. */
export function findSecretLikeKeys(value: unknown, path = ""): string[] {
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([k, v]) => {
    const here = path ? `${path}.${k}` : k;
    return [...(SECRET_KEY.test(k) && typeof v === "string" && v.length > 0 ? [here] : []), ...findSecretLikeKeys(v, here)];
  });
}

export function defaultProjectConfig(name: string, worktreeRoot: string): ProjectConfig {
  return {
    version: 1,
    name,
    commands: { build: null, test: null },
    runners: [],
    profiles: [],
    budget: { dailyUsd: 10, perTaskUsd: 4 },
    rules: { fallback: "ask", slots: 4, allowCommands: ["git status", "git diff"], network: "ask", toastApprovals: "low" },
    worktreeRoot,
    github: { remote: null, pushNeedsApproval: true, actionsWarnPct: 80 },
    bootstrap: defaultBootstrap(),
    loop: defaultLoop(),
  };
}
