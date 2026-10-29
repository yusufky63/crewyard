import type { AgentAdapter, AgentCapabilities, AgentEvent, Answer, NativeSessionRef, Probe, RunHandle, StartRequest, UserInput } from "@crewyard/core";

// A scripted runner for tests and UI work. A script is a list of steps; a step either emits an
// event, waits, or blocks on a request until answer() is called. Nothing is spawned.

export type FakeStep =
  | { emit: DistributiveOmit<AgentEvent, "runId" | "seq" | "at" | "source"> }
  | { wait: number }
  | { awaitAnswer: string };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export const capabilities: AgentCapabilities = {
  launch: true,
  stream: true,
  answerQuestions: true,
  approveTools: true,
  interrupt: true,
  resume: true,
  setModel: true,
  usage: true,
  reportedLimits: true,
  readOnlyMode: true,
};

interface RunState {
  script: FakeStep[];
  answers: Map<string, (a: Answer) => void>;
  /** Answers that arrive before the script reaches the matching wait; real runners can do this too. */
  early: Map<string, Answer>;
  received: Answer[];
  inputs: UserInput[];
  interrupted: boolean;
}

export class FakeAdapter implements AgentAdapter {
  readonly id = "fake" as const;
  readonly capabilities = capabilities;
  private readonly runs = new Map<string, RunState>();
  private counter = 0;

  constructor(private readonly script: FakeStep[]) {}

  async probe(): Promise<Probe> {
    return { installed: true, executable: null, version: "0.0.0", signedIn: true, capabilities, problems: [] };
  }

  async start(_req: StartRequest): Promise<RunHandle> {
    const runId = `fake-${++this.counter}`;
    this.runs.set(runId, { script: [...this.script], answers: new Map(), early: new Map(), received: [], inputs: [], interrupted: false });
    return { runId, runner: "fake", pid: null, nativeSession: { runner: "fake", sessionId: runId } };
  }

  async *events(run: RunHandle): AsyncIterable<AgentEvent> {
    const state = this.mustGet(run);
    let seq = 0;
    for (const step of state.script) {
      if (state.interrupted) break;
      if ("wait" in step) await new Promise((r) => setTimeout(r, step.wait));
      else if ("awaitAnswer" in step) {
        if (state.early.has(step.awaitAnswer)) state.early.delete(step.awaitAnswer);
        else await new Promise<Answer>((resolve) => state.answers.set(step.awaitAnswer, resolve));
      }
      else yield { ...step.emit, runId: run.runId, seq: seq++, at: new Date().toISOString(), source: { adapter: "fake", cliVersion: null } } as AgentEvent;
    }
    yield { type: "run.ended", reason: state.interrupted ? "stopped" : "completed", runId: run.runId, seq, at: new Date().toISOString(), source: { adapter: "fake", cliVersion: null } };
  }

  async send(run: RunHandle, input: UserInput): Promise<void> {
    this.mustGet(run).inputs.push(input);
  }

  async answer(run: RunHandle, requestId: string, answer: Answer): Promise<void> {
    const state = this.mustGet(run);
    state.received.push(answer);
    const resolve = state.answers.get(requestId);
    if (!resolve) {
      state.early.set(requestId, answer);
      return;
    }
    state.answers.delete(requestId);
    resolve(answer);
  }

  async interrupt(run: RunHandle): Promise<void> {
    const state = this.mustGet(run);
    state.interrupted = true;
    state.answers.forEach((resolve) => resolve({ kind: "cancel" }));
  }

  async resume(ref: NativeSessionRef, req: StartRequest): Promise<RunHandle> {
    return this.runs.has(ref.sessionId) ? { runId: ref.sessionId, runner: "fake", pid: null, nativeSession: ref } : this.start(req);
  }

  async stop(run: RunHandle): Promise<void> {
    await this.interrupt(run);
    this.runs.delete(run.runId);
  }

  /** Test helper: what the run received through answer() and send(). */
  inspect(run: RunHandle): { answers: Answer[]; inputs: UserInput[] } {
    const s = this.mustGet(run);
    return { answers: [...s.received], inputs: [...s.inputs] };
  }

  private mustGet(run: RunHandle): RunState {
    const state = this.runs.get(run.runId);
    if (!state) throw new Error(`Unknown run ${run.runId}`);
    return state;
  }
}
