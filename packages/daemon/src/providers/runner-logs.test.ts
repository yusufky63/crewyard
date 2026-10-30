import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PURGE_MARKER, purgeRunnerLogs } from "./runner-logs.ts";

const temps: string[] = [];
afterEach(() => temps.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 3 })));
// Spaces on purpose, as in every Windows path test.
const root = () => {
  const d = mkdtempSync(join(tmpdir(), "crewyard runner logs "));
  temps.push(d);
  return join(d, "profiles");
};

describe("purgeRunnerLogs", () => {
  it("removes codex log databases from every Codex profile once, and leaves everything else", () => {
    const profiles = root();
    const a = join(profiles, "codex", "work key");
    const b = join(profiles, "codex", "ds");
    const claude = join(profiles, "claude-code", "c");
    for (const d of [a, b, claude]) mkdirSync(d, { recursive: true });
    for (const f of ["logs_2.sqlite", "logs_2.sqlite-wal", "logs_2.sqlite-shm", "state_5.sqlite", "config.toml"]) writeFileSync(join(a, f), "x");
    writeFileSync(join(b, "logs_1.sqlite"), "x");
    writeFileSync(join(claude, "logs_2.sqlite"), "x");

    expect(purgeRunnerLogs(profiles)).toEqual({ removed: 4, busy: 0 });
    expect(existsSync(join(a, "logs_2.sqlite"))).toBe(false);
    expect(existsSync(join(a, "logs_2.sqlite-wal"))).toBe(false);
    expect(existsSync(join(b, "logs_1.sqlite"))).toBe(false);
    // Threads, the profile config and other runners' folders stay.
    expect(existsSync(join(a, "state_5.sqlite"))).toBe(true);
    expect(existsSync(join(a, "config.toml"))).toBe(true);
    expect(existsSync(join(claude, "logs_2.sqlite"))).toBe(true);
    expect(existsSync(join(profiles, PURGE_MARKER))).toBe(true);

    // Once: a log codex writes after the fix is not touched again.
    writeFileSync(join(a, "logs_2.sqlite"), "x");
    expect(purgeRunnerLogs(profiles)).toBeNull();
    expect(existsSync(join(a, "logs_2.sqlite"))).toBe(true);
  });

  it("does nothing on a data folder with no profiles yet", () => {
    expect(purgeRunnerLogs(root())).toEqual({ removed: 0, busy: 0 });
  });
});
