import { beforeEach, describe, expect, it, vi } from "vitest";

// Counts every process the machine check starts, while still starting the real ones.
const calls = vi.hoisted(() => ({ run: [] as string[] }));
vi.mock("@crewyard/proc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@crewyard/proc")>();
  return {
    ...real,
    run: (command: string, args: string[], opts?: Parameters<typeof real.run>[2]) => {
      calls.run.push(`${command} ${args.join(" ")}`);
      return real.run(command, args, opts);
    },
  };
});

const { checkEnv, checkMachine, checkTool, resetProbes } = await import("./machine.ts");
const { resolveBin } = await import("@crewyard/proc");

const versionRuns = () => calls.run.filter((c) => c.endsWith("--version"));

beforeEach(() => {
  resetProbes();
  calls.run.length = 0;
});

describe("machine probes", { timeout: 60_000 }, () => {
  it("shares one probe between callers that ask at the same time", async () => {
    const [a, b, c] = await Promise.all([checkTool("git"), checkTool("git"), checkTool("git")]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(versionRuns()).toHaveLength(1);
  });

  it("answers a burst from one probe per tool, and probes again past the caller's freshness", async () => {
    // The main process's machine.check and the Start screen's machine.tool rows arrive together at boot.
    await Promise.all([checkMachine(), checkTool("git"), checkTool("gh"), checkEnv()]);
    const perTool = versionRuns().length;
    expect(perTool).toBeLessThanOrEqual(6);
    expect(new Set(versionRuns()).size).toBe(perTool);

    // The burst can outlast the default window (`claude --version` is slow), so ask with a wide one.
    await checkTool("git", 60_000);
    expect(versionRuns()).toHaveLength(perTool);
    await checkTool("git", 0);
    expect(versionRuns()).toHaveLength(perTool + 1);
  });

  it("probes the same file an adapter resolving through resolveBin() would spawn", async () => {
    const check = await checkTool("git");
    expect(check.found).toBe(true);
    expect(await resolveBin("git")).toBe(check.path);
    expect(versionRuns()).toEqual([`${check.path} --version`]);
  });
});
