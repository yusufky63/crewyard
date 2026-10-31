import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gemini } from "./agents.ts";
import { geminiContextEnv } from "./profile.ts";

const temps: string[] = [];
afterEach(() => temps.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("the project bridge for Gemini CLI", () => {
  it("names the files in a system-defaults file of their own, GEMINI.md first", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crewyard gemini bridge "));
    temps.push(dir);
    const env = await geminiContextEnv(dir, ["AGENTS.md", "CLAUDE.md"]);
    const file = env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH!;
    expect(file.startsWith(join(dir, ".gemini", "crewyard"))).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ context: { fileName: ["GEMINI.md", "AGENTS.md", "CLAUDE.md"] } });
    // The same files give the same file; other files another one, so concurrent runs never share it.
    expect((await geminiContextEnv(dir, ["AGENTS.md", "CLAUDE.md"])).GEMINI_CLI_SYSTEM_DEFAULTS_PATH).toBe(file);
    expect((await geminiContextEnv(dir, ["AGENTS.md"])).GEMINI_CLI_SYSTEM_DEFAULTS_PATH).not.toBe(file);
    expect(await geminiContextEnv(dir, [".github/copilot-instructions.md"])).toEqual({});
    expect(existsSync(join(dir, ".gemini", "settings.json"))).toBe(false);
  });

  it("is wired into the Gemini agent spec", () => {
    expect(typeof gemini.instructionEnv).toBe("function");
  });
});
