import { isAbsolute, resolve } from "node:path";
import type { BootstrapStep, SetupFailure } from "@crewyard/core";
import { run, which } from "@crewyard/proc";
import { splitCommand } from "./command.ts";

const TAIL_LINES = 40;
const TAIL_BYTES = 4096;

/** The last lines of a step's output, for the failure panel. Never longer than 4 KB. */
export function logTail(stdout: string, stderr: string): string {
  const lines = `${stdout}\n${stderr}`.split(/\r?\n/).filter((l) => l.trim().length > 0);
  let tail = lines.slice(-TAIL_LINES).join("\n");
  if (tail.length > TAIL_BYTES) tail = tail.slice(-TAIL_BYTES);
  return tail;
}

/** A bare program name is looked up on PATH (an .exe before a .cmd shim); a path is taken relative to the worktree. */
async function resolveProgram(program: string, cwd: string): Promise<string | null> {
  if (/[\\/]/.test(program)) return isAbsolute(program) ? program : resolve(cwd, program);
  return which(program);
}

export interface StepsResult {
  ok: boolean;
  failure: Omit<SetupFailure, "at"> | null;
}

/**
 * Runs the steps in order in `cwd` through @crewyard/proc (cross-spawn, no shell, hidden window,
 * tree kill on timeout). The first failure stops the rest.
 */
export async function runSteps(steps: BootstrapStep[], cwd: string, env: NodeJS.ProcessEnv): Promise<StepsResult> {
  for (const step of steps) {
    const split = splitCommand(step.command);
    if ("problem" in split) return { ok: false, failure: { command: step.command, code: null, timedOut: false, tail: `bootstrap.command_${split.problem}` } };
    const argv = split.argv;
    const program = await resolveProgram(argv[0]!, cwd);
    if (!program) return { ok: false, failure: { command: step.command, code: null, timedOut: false, tail: `${argv[0]}: not found on PATH` } };
    const started = Date.now();
    const res = await run(program, argv.slice(1), { cwd, env, timeoutMs: step.timeoutSec * 1000 });
    if (res.code !== 0) {
      const timedOut = res.code === null && Date.now() - started >= step.timeoutSec * 1000 - 50;
      return { ok: false, failure: { command: step.command, code: res.code, timedOut, tail: logTail(res.stdout, res.stderr) } };
    }
  }
  return { ok: true, failure: null };
}
