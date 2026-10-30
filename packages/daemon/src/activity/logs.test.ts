import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REDACTED } from "@crewyard/core";
import { parseLog, readLogs, readTail } from "./logs.ts";

const temps: string[] = [];
afterEach(() => temps.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function dir() {
  const d = mkdtempSync(join(tmpdir(), "crewyard logs-"));
  temps.push(d);
  return d;
}

describe("parseLog", () => {
  it("reads time and level, and a stack line keeps the line above's", () => {
    const lines = parseLog("2026-10-31T10:00:00.000Z error Daemon exited (code 1)\r\n    at start (daemon.js:4)\r\n2026-10-31T10:00:01.000Z WARNING slow\n", "main");
    expect(lines).toEqual([
      { source: "main", at: "2026-10-31T10:00:00.000Z", level: "error", text: "Daemon exited (code 1)" },
      { source: "main", at: "2026-10-31T10:00:00.000Z", level: "error", text: "    at start (daemon.js:4)" },
      { source: "main", at: "2026-10-31T10:00:01.000Z", level: "warn", text: "slow" },
    ]);
  });

  it("redacts every line, even when a writer let a secret through", () => {
    const [line] = parseLog("2026-10-31T10:00:00.000Z info env OPENAI_API_KEY=sk-proj-abcdefghijklmnop0123 set\n", "daemon");
    expect(line!.text).toBe(`env OPENAI_API_KEY=${REDACTED} set`);
    expect(line!.text).not.toContain("sk-proj");
  });
});

describe("readTail", () => {
  it("drops the partial first line of a cut file and is empty for a missing one", () => {
    const d = dir();
    const p = join(d, "main.log");
    writeFileSync(p, "first line that is long\nsecond\nthird\n");
    expect(readTail(p, 12)).toBe("third\n");
    // A cut right after a newline keeps the whole line behind it.
    expect(readTail(p, 14)).toBe("second\nthird\n");
    expect(readTail(join(d, "missing.log"))).toBe("");
  });
});

describe("readLogs", () => {
  it("merges the files newest first, reads the rotated file, and caps the count", () => {
    const d = dir();
    writeFileSync(join(d, "main.log.old"), "2026-10-31T09:00:00.000Z info old main\n");
    writeFileSync(join(d, "main.log"), "2026-10-31T10:00:00.000Z info main a\n2026-10-31T10:00:02.000Z warn main b\n");
    writeFileSync(join(d, "daemon.log"), "2026-10-31T10:00:01.000Z error daemon a\n");
    const all = readLogs(d);
    expect(all.lines.map((l) => `${l.source} ${l.text}`)).toEqual(["main main b", "daemon daemon a", "main main a", "main old main"]);
    expect(all.more).toBe(false);
    expect(all.dir).toBe(d);
    expect(new Set(all.lines.map((l) => l.id)).size).toBe(4);
    const two = readLogs(d, ["main", "daemon"], 2);
    expect(two.lines.map((l) => l.text)).toEqual(["main b", "daemon a"]);
    expect(two.more).toBe(true);
    expect(readLogs(d, ["daemon"]).lines.map((l) => l.text)).toEqual(["daemon a"]);
  });

  it("answers with nothing when no log was written yet", () => {
    expect(readLogs(dir()).lines).toEqual([]);
  });
});
