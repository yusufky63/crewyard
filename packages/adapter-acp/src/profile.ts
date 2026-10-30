import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// Settings Crewyard keeps in a Gemini profile folder (GEMINI_CLI_HOME, so <configDir>/.gemini).
// The folder belongs to the Crewyard profile, never to your own ~/.gemini; we change only the keys
// named here and leave everything else in the file as it is.

/**
 * Gemini CLI's built-in subagents (geminicli.com/docs/cli/plan-mode, checked 2026-10-30). Their
 * work would bypass the crew's DAG, approvals and spend caps.
 */
export const GEMINI_SUBAGENT_TOOLS = ["codebase_investigator", "cli_help"];

/** User-tier policy (<home>/.gemini/policies/*.toml): denies the built-in subagents in every mode. */
export const GEMINI_POLICY = [
  "# Written by Crewyard for this profile; rewritten on every run.",
  "# Subagents would bypass the crew's own plan, approvals and spend caps.",
  ...GEMINI_SUBAGENT_TOOLS.flatMap((tool) => ["", "[[rule]]", `toolName = "${tool}"`, 'decision = "deny"', "priority = 900"]),
  "",
].join("\n");

export interface PreparedProfile {
  /** Why a setting could not be applied; the run goes on with Crewyard's own checks. */
  problems: string[];
}

/**
 * Turns Gemini's subagents off for this profile: `experimental.enableAgents: false` in its
 * settings.json (default true, documented in the configuration reference) and a policy file that
 * denies the built-in subagent tools. A settings file we cannot parse is left alone and reported.
 */
export async function prepareGeminiProfile(configDir: string): Promise<PreparedProfile> {
  const home = join(configDir, ".gemini");
  const problems: string[] = [];
  const settingsFile = join(home, "settings.json");
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsFile)) {
    try {
      const parsed: unknown = JSON.parse(stripComments(await readFile(settingsFile, "utf8")));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      settings = parsed as Record<string, unknown>;
    } catch (err) {
      problems.push(`Could not read ${settingsFile} (${err instanceof Error ? err.message : String(err)}); Gemini subagents stay on the policy file only.`);
      settings = {};
    }
  }
  if (problems.length === 0) {
    const experimental = settings.experimental && typeof settings.experimental === "object" ? (settings.experimental as Record<string, unknown>) : {};
    if (experimental.enableAgents !== false) await writeAtomic(settingsFile, `${JSON.stringify({ ...settings, experimental: { ...experimental, enableAgents: false } }, null, 2)}\n`);
  }
  const policyFile = join(home, "policies", "crewyard.toml");
  const current = existsSync(policyFile) ? await readFile(policyFile, "utf8").catch(() => "") : "";
  if (current !== GEMINI_POLICY) await writeAtomic(policyFile, GEMINI_POLICY);
  return { problems };
}

/** Gemini's settings.json may carry // and /* *\/ comments; strings are left intact. */
export function stripComments(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  return out;
}

/** Write to a temporary file, then rename; retried because antivirus scanners hold new files briefly. */
async function writeAtomic(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content, "utf8");
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, file);
      return;
    } catch (err) {
      if (attempt >= 5) {
        await rm(tmp, { force: true });
        throw err;
      }
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
}
