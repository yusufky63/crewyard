import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_FILE_LIMITS } from "@crewyard/core";
import { afterEach, describe, expect, it } from "vitest";
import { bridgedSystemPrompt } from "./instructions.ts";

const temps: string[] = [];
afterEach(() => temps.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "crewyard claude bridge "));
  temps.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

describe("the project bridge for Claude Code", () => {
  it("puts bridged files in the system prompt and nothing without a bridge", () => {
    const cwd = repo({ "CLAUDE.md": "Claude.", "AGENTS.md": "Use pnpm.", ".github/copilot-instructions.md": "Tabs." });
    expect(bridgedSystemPrompt(cwd, undefined)).toBeNull();
    const p = bridgedSystemPrompt(cwd, ["AGENTS.md", ".github/copilot-instructions.md", "missing.md"])!;
    expect(p).toContain('<project-instructions path="AGENTS.md">\nUse pnpm.\n</project-instructions>');
    expect(p).toContain('<project-instructions path=".github/copilot-instructions.md">');
    expect(p).not.toContain("missing.md");
  });

  it("leaves AGENTS.md to Claude Code when the folder has no CLAUDE.md, since it reads it then", () => {
    const cwd = repo({ "AGENTS.md": "Use pnpm." });
    expect(bridgedSystemPrompt(cwd, ["AGENTS.md"])).toBeNull();
  });

  it("cuts a long file and says so", () => {
    const cwd = repo({ "CLAUDE.md": "c", "AGENTS.md": "x".repeat(AGENT_FILE_LIMITS.bridgeBytes + 10) });
    const p = bridgedSystemPrompt(cwd, ["AGENTS.md"])!;
    expect(p).toContain("AGENTS.md was cut at 64 KB");
    expect(p.length).toBeLessThan(AGENT_FILE_LIMITS.bridgeBytes + 1_000);
  });
});
