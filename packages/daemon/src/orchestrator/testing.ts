import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capabilities, FakeAdapter, type FakeStep } from "@crewyard/adapter-fake";
import type { AgentAdapter, AgentEvent, Answer, CatalogModel, NativeSessionRef, Probe, RunHandle, StartRequest, UserInput } from "@crewyard/core";
import { run } from "@crewyard/proc";
import type { Candidate } from "./directory.ts";

// Test helpers only; nothing in production imports this file.

/**
 * Wraps one FakeAdapter per run so each role gets its own script. FakeAdapter numbers its runs
 * per instance, so handles are remapped to ids that stay unique across instances.
 */
export class ScriptedAdapter implements AgentAdapter {
  readonly id = "fake" as const;
  readonly capabilities = capabilities;
  readonly started: Array<{ runId: string; req: StartRequest; resumed: boolean; role: string }> = [];
  private readonly runs = new Map<string, { fake: FakeAdapter; inner: RunHandle }>();
  private n = 0;

  constructor(private readonly pick: (role: string, req: StartRequest, resumed: boolean) => FakeStep[]) {}

  async probe(): Promise<Probe> {
    return { installed: true, executable: null, version: "0.0.0", signedIn: true, capabilities, problems: [] };
  }

  start(req: StartRequest): Promise<RunHandle> {
    return this.open(req, false, null);
  }

  resume(ref: NativeSessionRef, req: StartRequest): Promise<RunHandle> {
    return this.open(req, true, ref);
  }

  private async open(req: StartRequest, resumed: boolean, ref: NativeSessionRef | null): Promise<RunHandle> {
    const role = roleOf(req);
    const fake = new FakeAdapter(this.pick(role, req, resumed));
    const inner = await fake.start(req);
    const runId = `scripted-${++this.n}`;
    this.runs.set(runId, { fake, inner });
    this.started.push({ runId, req, resumed, role });
    return { runId, runner: "fake", pid: null, nativeSession: ref ?? { runner: "fake", sessionId: runId } };
  }

  events(h: RunHandle): AsyncIterable<AgentEvent> {
    const r = this.get(h);
    return r.fake.events(r.inner);
  }

  send(h: RunHandle, input: UserInput): Promise<void> {
    const r = this.get(h);
    return r.fake.send(r.inner, input);
  }

  answer(h: RunHandle, requestId: string, answer: Answer): Promise<void> {
    const r = this.get(h);
    return r.fake.answer(r.inner, requestId, answer);
  }

  interrupt(h: RunHandle): Promise<void> {
    const r = this.get(h);
    return r.fake.interrupt(r.inner);
  }

  async stop(h: RunHandle): Promise<void> {
    const r = this.runs.get(h.runId);
    if (r) await r.fake.interrupt(r.inner);
  }

  steer(h: RunHandle, input: UserInput): Promise<void> {
    const r = this.get(h);
    return r.fake.steer(r.inner, input);
  }

  inspect(runId: string): { answers: Answer[]; inputs: UserInput[]; steered: UserInput[] } {
    const r = this.runs.get(runId);
    if (!r) throw new Error(`unknown run ${runId}`);
    return r.fake.inspect(r.inner);
  }

  private get(h: RunHandle) {
    const r = this.runs.get(h.runId);
    if (!r) throw new Error(`unknown run ${h.runId}`);
    return r;
  }
}

export const roleOf = (req: StartRequest) => req.prompt.match(/^Role: (\w+)/)?.[1]?.toLowerCase() ?? "unknown";

export function model(id: string, over: Partial<CatalogModel> = {}): CatalogModel {
  return { id, name: id, family: null, context: 200_000, output: 16_000, cost: { input: 3, output: 15, cacheRead: 0.3 }, reasoning: true, openWeights: false, released: null, ...over };
}

export function candidate(id: string, providerId: string, m: CatalogModel | null, kind: "api_key" | "plan_signin" = "api_key"): Candidate {
  return {
    profile: { id, alias: id, runner: "fake", providerId, credential: { kind, secretRef: null }, defaultModel: m?.id ?? null, configDir: ".", baseUrl: null },
    model: m,
    capabilities,
    ready: true,
  };
}

/** Three candidates on three providers, so independence and standby chains have room. */
export const CANDIDATES = (): Candidate[] => [
  candidate("anthropic-key", "anthropic", model("claude-sonnet")),
  candidate("openai-key", "openai", model("gpt-5", { cost: { input: 1.25, output: 10, cacheRead: 0.125 } })),
  candidate("deepseek-key", "deepseek", model("deepseek-chat", { reasoning: false, cost: { input: 0.27, output: 1.1, cacheRead: 0.07 } })),
];

const temps: string[] = [];

/** Temp folder with a space in its name, as the Windows rules ask. */
export function tempDir(prefix = "crewyard orch-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
}

export function cleanTemps(): void {
  temps.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const res = await run("git", args, { cwd, timeoutMs: 30_000 });
  if (res.code !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout;
}

/** A repo with one commit and a local identity, so WIP commits work on any machine. */
export async function tempRepo(parent: string, name = "demo repo"): Promise<string> {
  const repo = join(parent, name);
  mkdirSync(repo, { recursive: true });
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.name", "Crewyard Test");
  await git(repo, "config", "user.email", "test@crewyard.invalid");
  await git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "# demo\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "init");
  return repo;
}

export async function waitFor<T>(fn: () => T | null | undefined | false, ms = 8_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
