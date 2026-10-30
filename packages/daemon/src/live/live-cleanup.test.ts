import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// The opt-in live tests are skipped in `pnpm test`, but Vitest still runs a skipped describe's body
// to collect its tests. A temp folder or a store made there was never cleaned up and left one
// `%TEMP%\crewyard live *` folder per run (about 70 by 2026-10-30). This keeps that from coming back.

const SRC = join(import.meta.dirname, "..");
const MAKES_FILES = /\b(?:mkdtempSync|mkdirSync|tempDir|tempRepo|new Store|writeFileSync)\(/;

function liveFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? liveFiles(join(dir, e.name)) : /\.live(\.test)?\.ts$/.test(e.name) ? [join(dir, e.name)] : []));
}

/** Lines of a gated describe's own body, outside its hooks and tests (depth 1 inside the describe). */
function collectorLines(text: string): string[] {
  const out: string[] = [];
  const lines = text.split("\n");
  let depth = -1;
  for (const line of lines) {
    if (depth < 0) {
      if (/^describe\.runIf\(/.test(line)) depth = 0;
      continue;
    }
    if (depth === 0 && line.trim() && !/^\s*\/\//.test(line)) out.push(line);
    for (const ch of line) {
      if (ch === "{" || ch === "(") depth++;
      else if (ch === "}" || ch === ")") depth--;
    }
    if (depth < 0) break;
  }
  return out;
}

describe("live tests", () => {
  it("create nothing on disk while Vitest only collects them", () => {
    const files = liveFiles(SRC);
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.flatMap((f) => collectorLines(readFileSync(f, "utf8")).filter((l) => MAKES_FILES.test(l) && !/^\s*(?:beforeAll|afterAll|beforeEach|afterEach|it|test)\b/.test(l)).map((l) => `${relative(SRC, f)}: ${l.trim()}`));
    expect(offenders).toEqual([]);
  });
});
