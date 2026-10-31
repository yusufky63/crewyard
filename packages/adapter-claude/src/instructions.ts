import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { AGENT_FILE_LIMITS, bridgePrompt } from "@crewyard/core";

// The project bridge for Claude Code (docs/adr/0015). Claude Code has no setting that names another
// instruction file, so a bridged file's text goes into the run's system prompt, which the SDK sends
// empty otherwise. Claude Code 2.1.277 and later read AGENTS.md by themselves when the folder has no
// CLAUDE.md of any kind (code.claude.com/docs/en/memory), so it is left out then.

const OWN = ["CLAUDE.md", join(".claude", "CLAUDE.md"), "CLAUDE.local.md"];

function readCapped(file: string): { text: string; truncated: boolean } | null {
  let fd: number | null = null;
  try {
    if (!statSync(file).isFile()) return null;
    fd = openSync(file, "r");
    const buf = Buffer.alloc(AGENT_FILE_LIMITS.bridgeBytes + 1);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const truncated = n > AGENT_FILE_LIMITS.bridgeBytes;
    return { text: buf.subarray(0, Math.min(n, AGENT_FILE_LIMITS.bridgeBytes)).toString("utf8"), truncated };
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** The system prompt for the bridged files of a run, or null when none applies. */
export function bridgedSystemPrompt(cwd: string, files: readonly string[] | undefined): string | null {
  if (!files || files.length === 0) return null;
  const hasOwn = OWN.some((f) => existsSync(join(cwd, f)));
  const taken = files.filter((f) => !(f.toLowerCase() === "agents.md" && !hasOwn) && f.toLowerCase() !== "claude.md");
  const read = taken.flatMap((path) => {
    const r = readCapped(join(cwd, ...path.split("/")));
    return r && r.text.trim() ? [{ path, ...r }] : [];
  });
  return read.length > 0 ? bridgePrompt(read) : null;
}
