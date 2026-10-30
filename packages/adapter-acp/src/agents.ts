import { join } from "node:path";
import type { Profile } from "@crewyard/core";
import { prepareGeminiProfile, type PreparedProfile } from "./profile.ts";

// What differs between ACP agents: how to start ACP mode, how to keep each profile in its own
// folder, and how an API-key profile authenticates. The protocol driver itself is shared.

export interface AgentSpec {
  /** Profile runner this spec serves, e.g. "gemini-cli". */
  runner: Profile["runner"];
  label: string;
  /** Command looked up on PATH. */
  command: string;
  /** Picks the ACP flag from the installed CLI's --help output; null when it has none. */
  acpArgs(help: string): string[] | null;
  modelArgs(model: string): string[];
  /**
   * Flags that make the agent's own engine read-only, picked from --help like acpArgs; null when
   * the installed version has no such mode (our permission check is then the only layer).
   */
  readOnlyArgs(help: string): string[] | null;
  /** Writes the settings Crewyard keeps in the profile folder (subagents off) before each start. */
  prepare(profile: Profile): Promise<PreparedProfile>;
  /** Variables that point the agent at the profile folder. */
  env(profile: Profile): Record<string, string>;
  /** Why this CLI version cannot be kept inside the profile folder, or null when it can. */
  isolationProblem(version: string | null): string | null;
  /** ACP auth method for a profile that brings an API key; null leaves sign-in to the CLI's own login. */
  authMethod(profile: Profile, env: Record<string, string>): string | null;
  /** The agent's own subscription sign-in through ACP `authenticate`; null when it has none. */
  signIn: SignInSpec | null;
}

export interface SignInSpec {
  /** ACP auth method that runs the agent's browser login. */
  methodId: string;
  /** File the agent writes once signed in. Only its presence is checked; it is never opened. */
  credentialsFile(profile: Profile): string;
  /** Where the agent prints the sign-in page, so the UI can offer it when the browser did not open. */
  urlPattern: RegExp;
  /** Oldest version that keeps the sign-in inside the profile folder. */
  minVersion: string;
  /** What to run when the installed version is older than that. */
  updateCommand: string;
}

/** Compares dotted versions numerically; pre-release tags are ignored. */
export function versionAtLeast(version: string, min: string): boolean {
  const a = version.split(/[-+]/)[0]?.split(".").map(Number) ?? [];
  const b = min.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/**
 * Gemini CLI. Checked against the published packages on 2026-10-30:
 * - ACP flag: 0.6.1 through 0.31 only have `--experimental-acp`; 0.35 adds `--acp` and keeps the old
 *   one as deprecated. The help text decides, so both generations work.
 * - GEMINI_CLI_HOME first appears in @google/gemini-cli-core 0.25.0 (`homedir()` in utils/paths.js).
 *   Older versions always use os.homedir()/.gemini, which would put every profile in your own
 *   ~/.gemini (PLAN.md D4), so they are refused instead of run.
 * - GEMINI_FORCE_FILE_STORAGE=true keeps OAuth tokens in the profile folder instead of the OS
 *   keychain entry that all profiles would otherwise share.
 */
export const GEMINI_ISOLATION_MIN = "0.25.0";

export const gemini: AgentSpec = {
  runner: "gemini-cli",
  label: "Gemini CLI",
  command: "gemini",
  acpArgs(help) {
    if (/(^|\s)--acp\b/m.test(help)) return ["--acp"];
    if (/(^|\s)--experimental-acp\b/m.test(help)) return ["--experimental-acp"];
    return null;
  },
  modelArgs: (model) => ["--model", model],
  // Plan mode: "a strict, read-only mode" in which writes are refused by Gemini itself, except
  // Markdown plans in its own plans folder (geminicli.com/docs/cli/plan-mode, checked 2026-10-30).
  // Older versions do not list "plan" among the --approval-mode choices.
  readOnlyArgs(help) {
    const line = help.split(/\r?\n/).find((l) => /--approval-mode\b/.test(l));
    return line && /\bplan\b/.test(line) ? ["--approval-mode", "plan"] : null;
  },
  prepare: (profile) => prepareGeminiProfile(profile.configDir),
  env: (profile) => ({ GEMINI_CLI_HOME: profile.configDir, GEMINI_FORCE_FILE_STORAGE: "true" }),
  isolationProblem(version) {
    if (version && versionAtLeast(version, GEMINI_ISOLATION_MIN)) return null;
    return `Gemini CLI ${version ?? "(unknown version)"} ignores GEMINI_CLI_HOME and would use your own ~/.gemini; update it to ${GEMINI_ISOLATION_MIN} or newer`;
  },
  // "gemini-api-key" is AuthType.USE_GEMINI; Gemini reads the key from GEMINI_API_KEY.
  authMethod: (profile, env) => (profile.credential.kind === "api_key" && env.GEMINI_API_KEY ? "gemini-api-key" : null),
  // Checked against gemini-cli v0.66.0 on 2026-10-30: `authenticate` with "oauth-personal"
  // (AuthType.LOGIN_WITH_GOOGLE) opens the browser itself in ACP mode, waits for Google's callback on
  // its own local port and resolves once the tokens are cached in <GEMINI_CLI_HOME>/.gemini/oauth_creds.json.
  signIn: {
    methodId: "oauth-personal",
    credentialsFile: (profile) => join(profile.configDir, ".gemini", "oauth_creds.json"),
    urlPattern: /https:\/\/accounts\.google\.com\/[^\s"'<>]+/,
    minVersion: GEMINI_ISOLATION_MIN,
    updateCommand: "npm install -g @google/gemini-cli@latest",
  },
};

export const AGENTS: AgentSpec[] = [gemini];
