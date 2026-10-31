import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REDACTED } from "@crewyard/core";
import { lineSplitter, logFile } from "./logs.ts";

const temps: string[] = [];
afterEach(() => temps.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function dir() {
  const d = mkdtempSync(join(tmpdir(), "crewyard main logs-"));
  temps.push(d);
  return d;
}

const at = () => new Date("2026-10-31T10:00:00.000Z");

describe("logFile", () => {
  it("writes one stamped, redacted entry per call and creates the folder", () => {
    const path = join(dir(), "logs", "main.log");
    const log = logFile(path, at);
    log.write("error", "spawn failed: GITHUB_TOKEN=ghp_0123456789abcdefghijABCDEFGHIJ\n    at run (x.js:1)");
    expect(readFileSync(path, "utf8")).toBe(`2026-10-31T10:00:00.000Z error spawn failed: GITHUB_TOKEN=${REDACTED}\r\n    at run (x.js:1)\r\n`);
  });

  it("rotates a full file to .old", () => {
    const d = dir();
    const path = join(d, "daemon.log");
    writeFileSync(path, "x".repeat(1024 * 1024 + 1));
    logFile(path, at).write("info", "after rotation");
    expect(existsSync(`${path}.old`)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("2026-10-31T10:00:00.000Z info after rotation\r\n");
  });

  it("never throws when the folder cannot be written", () => {
    const d = dir();
    writeFileSync(join(d, "file"), "");
    expect(() => logFile(join(d, "file", "main.log"), at).write("info", "x")).not.toThrow();
  });
});

describe("lineSplitter", () => {
  it("joins lines split across chunks and skips blank ones", () => {
    const lines: string[] = [];
    const s = lineSplitter((l) => lines.push(l));
    s.push("first par");
    s.push(Buffer.from("t\r\n\r\nsecond\nthi"));
    s.flush();
    expect(lines).toEqual(["first part", "second", "thi"]);
  });
});
