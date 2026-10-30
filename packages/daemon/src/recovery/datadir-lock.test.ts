import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { killTree, start } from "@crewyard/proc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanTemps, tempDir, waitFor } from "../orchestrator/testing.ts";
import { acquireDataDirLock, DataDirLockedError, type DataDirLock } from "./datadir-lock.ts";

vi.setConfig({ testTimeout: 60_000 });

const locks: DataDirLock[] = [];
const pids: number[] = [];
afterEach(async () => {
  locks.splice(0).forEach((l) => l.release());
  for (const pid of pids.splice(0)) await killTree(pid);
  cleanTemps();
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("data folder lock", () => {
  it("lets one holder in, refuses the next, and frees the folder on release", async () => {
    const dir = join(tempDir("crewyard lock-"), "data dir");
    const first = await acquireDataDirLock(dir);
    locks.push(first);
    expect(first.unsupported).toBeNull();
    const t0 = Date.now();
    await expect(acquireDataDirLock(dir, { waitMs: 300, retryMs: 50 })).rejects.toBeInstanceOf(DataDirLockedError);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    first.release();
    first.release();
    const second = await acquireDataDirLock(dir, { waitMs: 0 });
    locks.push(second);
    expect(second.unsupported).toBeNull();
  });

  it("waits for a holder that lets go during the wait", async () => {
    const dir = tempDir("crewyard lock-");
    const first = await acquireDataDirLock(dir);
    setTimeout(() => first.release(), 300);
    const second = await acquireDataDirLock(dir, { waitMs: 5_000, retryMs: 50 });
    locks.push(second);
    expect(second.unsupported).toBeNull();
  });

  it.runIf(process.platform === "win32")("is released when the holder is killed, even with a child of it still running", async () => {
    const dir = tempDir("crewyard lock-");
    const lockModule = pathToFileURL(join(import.meta.dirname, "datadir-lock.ts")).href;
    // A daemon that takes the lock, starts an agent that outlives it, and reports both pids.
    const script = [
      `import { spawn } from "node:child_process";`,
      `import { acquireDataDirLock } from ${JSON.stringify(lockModule)};`,
      `await acquireDataDirLock(${JSON.stringify(dir)});`,
      `const agent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore", windowsHide: true });`,
      `agent.unref();`,
      `process.stdout.write(process.pid + " " + agent.pid + "\\n");`,
      `setInterval(() => {}, 1000);`,
    ].join("\n");
    const daemon = start(process.execPath, ["--experimental-transform-types", "--no-warnings", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    pids.push(daemon.pid!);
    let out = "";
    let err = "";
    daemon.stdout!.setEncoding("utf8").on("data", (d: string) => (out += d));
    daemon.stderr!.setEncoding("utf8").on("data", (d: string) => (err += d));
    const [, agentPid] = await waitFor(() => (out.includes("\n") ? out.trim().split(" ").map(Number) : null), 30_000).catch(() => {
      throw new Error(`lock holder never started: ${err.slice(0, 1000)}`);
    });
    pids.push(agentPid!);
    await expect(acquireDataDirLock(dir, { waitMs: 0 })).rejects.toBeInstanceOf(DataDirLockedError);

    // Kill only the holder, as a crash would; its agent keeps running.
    process.kill(daemon.pid!);
    await waitFor(() => !alive(daemon.pid!), 10_000);
    expect(alive(agentPid!)).toBe(true);
    const next = await acquireDataDirLock(dir, { waitMs: 5_000, retryMs: 50 });
    locks.push(next);
    expect(next.unsupported).toBeNull();
  });
});
