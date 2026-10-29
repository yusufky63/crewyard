import type { MachineEnv, MachineReport, ToolCheck, ToolId } from "@crewyard/core";
import { parseVersion, run, which } from "@crewyard/proc";

// The "This machine" check on the Start screen. Read-only: it never installs or changes anything.

export const TOOL_BINS: Record<ToolId, string> = {
  claude: "claude",
  codex: "codex",
  gemini: "gemini",
  opencode: "opencode",
  git: "git",
  gh: "gh",
};

export async function checkTool(id: ToolId): Promise<ToolCheck> {
  const path = await which(TOOL_BINS[id]);
  if (!path) return { id, found: false, path: null, version: null, detail: null };
  const res = await run(path, ["--version"], { timeoutMs: 15_000 });
  const version = parseVersion(res.stdout || res.stderr);
  return { id, found: true, path, version, detail: res.code === 0 ? null : "version check failed" };
}

/** `gh api user --jq .login` prints the login when signed in; anything else means not signed in. */
async function ghLogin(): Promise<string | null> {
  const gh = await which("gh");
  if (!gh) return null;
  const res = await run(gh, ["api", "user", "--jq", ".login"], { timeoutMs: 15_000 });
  const login = res.stdout.trim();
  return res.code === 0 && /^[\w-]+$/.test(login) ? login : null;
}

/** Parses `reg query ... /v LongPathsEnabled` output; null when the value is missing. */
export function parseLongPaths(regOutput: string): boolean | null {
  const m = regOutput.match(/LongPathsEnabled\s+REG_DWORD\s+0x([0-9a-f]+)/i);
  return m?.[1] ? parseInt(m[1], 16) === 1 : null;
}

async function longPaths(): Promise<boolean | null> {
  if (process.platform !== "win32") return null;
  const res = await run("reg", ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem", "/v", "LongPathsEnabled"]);
  return res.code === 0 ? parseLongPaths(res.stdout) : null;
}

export async function checkEnv(): Promise<MachineEnv> {
  const [ghUser, longPathsEnabled] = await Promise.all([ghLogin(), longPaths()]);
  return { checkedAt: new Date().toISOString(), platform: `${process.platform} ${process.arch}`, ghUser, longPathsEnabled };
}

export async function checkMachine(): Promise<MachineReport> {
  const [tools, env] = await Promise.all([Promise.all((Object.keys(TOOL_BINS) as ToolId[]).map(checkTool)), checkEnv()]);
  return { ...env, tools };
}
