import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { capabilities, FakeAdapter, type FakeStep } from "@crewyard/adapter-fake";
import type { AgentAdapter, AgentEvent, Answer, CatalogModel, NativeSessionRef, Probe, RunHandle, StartRequest, UserInput } from "@crewyard/core";
import { AdapterRegistry } from "../orchestrator/adapters.ts";
import type { Candidate, ProfileDirectory } from "../orchestrator/directory.ts";
import { orchestratorFor, type OrchestratorOptions } from "../orchestrator/index.ts";
import type { HandlerContext } from "../handlers/types.ts";
import { GOAL_PLANNER } from "../orchestrator/roles.ts";

// App-level end-to-end tests (PLAN.md §15) run the real daemon with scripted runners. With
// CREWYARD_E2E=1 and CREWYARD_E2E_SCRIPT=<absolute json path>, the orchestrator gets only the
// fake runner and fake profiles; no real CLI is ever started. The main process deletes both
// variables in a packaged build before the daemon is forked, so this never runs for users.

export interface E2eProfile {
  id: string;
  alias: string;
  providerId: string;
  model: CatalogModel;
}

/**
 * What the test writes. `scripts[key][n]` is the n-th run started for that key, the last one
 * repeating; the key is the role id ("researcher", "implementer", "goal-planner"), "resume" for a
 * native resume of a stopped or paused session, and "*" for any role without its own entry.
 *
 * A key `<role>@<words>` (or `resume@<words>`) is tried first and wins over the plain key: it
 * matches when the run's task title contains the words, or, for a prompt with no task section (the
 * goal planner's brief, a follow-up resume), when the prompt does. That is how one flow scripts two
 * implementers of two goal tasks differently, or a planner per goal.
 */
export interface E2eScript {
  profiles?: E2eProfile[];
  scripts: Record<string, FakeStep[][]>;
}

const priced = (id: string, input: number, output: number): CatalogModel => ({
  id,
  name: id,
  family: null,
  context: 200_000,
  output: 16_000,
  cost: { input, output, cacheRead: input / 10 },
  reasoning: true,
  openWeights: false,
  released: null,
});

/** Three profiles on three providers: a reviewer must differ from the implementer and a handoff needs a standby. */
export const DEFAULT_PROFILES: E2eProfile[] = [
  { id: "e2e-alpha", alias: "Fake Alpha", providerId: "anthropic", model: priced("fake-alpha", 3, 15) },
  { id: "e2e-beta", alias: "Fake Beta", providerId: "openai", model: priced("fake-beta", 1.25, 10) },
  { id: "e2e-gamma", alias: "Fake Gamma", providerId: "deepseek", model: priced("fake-gamma", 0.27, 1.1) },
];

/**
 * The role a run was started for, from the first line of its prompt ("Role: Implementer"). The
 * goal planner's title is two words, so it is named by its id rather than its first word.
 */
export function roleOf(req: Pick<StartRequest, "prompt">): string | null {
  const title = req.prompt.match(/^Role: ([^\n]+)/)?.[1]?.trim();
  if (!title) return null;
  if (title === GOAL_PLANNER.title) return GOAL_PLANNER.id;
  return title.match(/^\w+/)?.[0]?.toLowerCase() ?? null;
}

/** The task title a role prompt quotes ("Task:\n<<<\n<title>"), or null for a prompt with none. */
const titleOf = (prompt: string): string | null => prompt.split("Task:\n<<<\n")[1]?.split("\n")[0] ?? null;

/**
 * The script key for a run: a `<base>@<words>` key whose words appear in the task title (or the
 * prompt, when it quotes no task), then the plain key, then "*". `base` is the role, or "resume".
 */
export function scriptKey(scripts: E2eScript["scripts"], req: Pick<StartRequest, "prompt">, resumed: boolean): string {
  const role = roleOf(req);
  const base = role ?? (resumed ? "resume" : null);
  if (base) {
    const haystack = titleOf(req.prompt) ?? req.prompt;
    const keyed = Object.keys(scripts).find((k) => k.startsWith(`${base}@`) && haystack.includes(k.slice(base.length + 1)));
    if (keyed) return keyed;
    if (scripts[base]) return base;
  }
  return "*";
}

/**
 * Reads the script file on every start, so a test can rewrite it between flows. Counters reset
 * when the file content changes, which keeps each flow's numbering independent of the last one.
 */
export class E2eAdapter implements AgentAdapter {
  readonly id = "fake" as const;
  readonly capabilities = capabilities;
  private readonly runs = new Map<string, { fake: FakeAdapter; inner: RunHandle }>();
  private readonly counts = new Map<string, number>();
  private lastSource = "";
  private n = 0;

  constructor(private readonly file: string) {}

  read(): E2eScript {
    const source = readFileSync(this.file, "utf8");
    if (source !== this.lastSource) {
      this.lastSource = source;
      this.counts.clear();
    }
    return JSON.parse(source) as E2eScript;
  }

  async probe(): Promise<Probe> {
    return { installed: true, executable: null, version: "0.0.0", signedIn: true, capabilities, problems: [] };
  }

  start(req: StartRequest): Promise<RunHandle> {
    return this.open(req, null);
  }

  resume(ref: NativeSessionRef, req: StartRequest): Promise<RunHandle> {
    return this.open(req, ref);
  }

  private async open(req: StartRequest, ref: NativeSessionRef | null): Promise<RunHandle> {
    const { scripts } = this.read();
    const key = scriptKey(scripts, req, ref !== null);
    const list = scripts[key] ?? [];
    const n = this.counts.get(key) ?? 0;
    this.counts.set(key, n + 1);
    const fake = new FakeAdapter(list[Math.min(n, list.length - 1)] ?? []);
    const inner = await fake.start(req);
    const runId = `e2e-${++this.n}`;
    this.runs.set(runId, { fake, inner });
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

  private get(h: RunHandle) {
    const r = this.runs.get(h.runId);
    if (!r) throw new Error(`Unknown run ${h.runId}`);
    return r;
  }
}

export function e2eDirectory(adapter: E2eAdapter): ProfileDirectory {
  return {
    candidates: (): Candidate[] =>
      (adapter.read().profiles ?? DEFAULT_PROFILES).map((p) => ({
        profile: { id: p.id, alias: p.alias, runner: "fake", providerId: p.providerId, credential: { kind: "api_key", secretRef: null }, defaultModel: p.model.id, configDir: ".", baseUrl: null },
        model: p.model,
        capabilities,
        ready: true,
      })),
    envFor: () => ({}),
  };
}

export interface E2eHook {
  options: Partial<OrchestratorOptions>;
  directory: ProfileDirectory;
}

/** Null unless both variables are set; a relative or missing script path is a setup error. */
export function e2eHook(env: NodeJS.ProcessEnv): E2eHook | null {
  if (env.CREWYARD_E2E !== "1") return null;
  const file = env.CREWYARD_E2E_SCRIPT;
  if (!file || !isAbsolute(file)) throw new Error("CREWYARD_E2E_SCRIPT must be an absolute path");
  const adapter = new E2eAdapter(file);
  adapter.read();
  const adapters = new AdapterRegistry({});
  adapters.set("fake", adapter);
  // A short tick and fixed free memory keep scheduling independent of the machine's load.
  return { options: { adapters, tickMs: 500, freeMemoryMb: () => 64_000 }, directory: e2eDirectory(adapter) };
}

/**
 * Creates the handlers with the e2e orchestrator in place. The orchestrator is built first with
 * the fake registry; the providers handlers then set their directory, so ours is set after them.
 */
export function createHandlersForEnv<H>(ctx: HandlerContext, env: NodeJS.ProcessEnv, create: (ctx: HandlerContext) => H): H {
  const hook = e2eHook(env);
  if (!hook) return create(ctx);
  orchestratorFor(ctx, hook.options);
  const handlers = create(ctx);
  orchestratorFor(ctx).setDirectory(hook.directory);
  return handlers;
}
