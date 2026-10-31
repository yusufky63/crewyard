import { toUserInput, type AgentAdapter, type AgentCapabilities, type AgentEvent, type Answer, type Attachment, type NativeSessionRef, type Probe, type RunHandle, type StartRequest, type UserInput } from "@crewyard/core";
import { callMcpTool } from "./mcp-call.ts";

// A scripted runner for tests and UI work. A script is a list of steps; a step either emits an
// event, waits, or blocks on a request until answer() is called. Nothing is spawned.

export type FakeStep =
  | { emit: DistributiveOmit<AgentEvent, "runId" | "seq" | "at" | "source"> }
  | { wait: number }
  | { awaitAnswer: string }
  /**
   * Calls a tool of the run's report server through the daemon's pipe, as a runner would (docs/adr/0007).
   * A string argument `{{mcp.N.field}}` is replaced by that field of the N-th mcp result's JSON text,
   * so a script can use an id the daemon just returned (Autopilot, docs/adr/0017).
   */
  | { mcp: { tool: string; arguments: unknown } }
  /** Ends the turn here and waits for the next input (nextTurn), then goes on with the script; null ends the run. */
  | { awaitTurn: true };

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
  mcp: { toolFilter: true },
  // Records what it was given (inspect().started and inputs) instead of reading the files.
  attachments: { images: true, files: true },
};

interface RunState {
  script: FakeStep[];
  answers: Map<string, (a: Answer) => void>;
  /** Answers that arrive before the script reaches the matching wait; real runners can do this too. */
  early: Map<string, Answer>;
  received: Answer[];
  inputs: UserInput[];
  /** The start or resume prompt and the attachments that came with it. */
  started: { prompt: string; attachments: Attachment[] };
  /** Text steered into the running script (steer()). */
  steered: UserInput[];
  nextTurn: StartRequest["nextTurn"];
  mcpServers: StartRequest["mcpServers"];
  /** What each mcp step's tool call returned. */
  mcpResults: Array<{ isError: boolean; text: string }>;
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

  async start(req: StartRequest): Promise<RunHandle> {
    const runId = `fake-${++this.counter}`;
    this.runs.set(runId, { script: [...this.script], answers: new Map(), early: new Map(), received: [], inputs: [], started: { prompt: req.prompt, attachments: req.attachments ?? [] }, steered: [], nextTurn: req.nextTurn, mcpServers: req.mcpServers, mcpResults: [], interrupted: false });
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
      else if ("mcp" in step) {
        const spec = state.mcpServers?.find((m) => m.builtin);
        state.mcpResults.push(spec ? await callMcpTool(spec, step.mcp.tool, resolveRefs(step.mcp.arguments, state.mcpResults)) : { isError: true, text: "no report server in this run" });
      } else if ("awaitTurn" in step) {
        const next = state.nextTurn ? await state.nextTurn() : null;
        if (!next) break;
        state.inputs.push(toUserInput(next));
      } else yield { ...step.emit, runId: run.runId, seq: seq++, at: new Date().toISOString(), source: { adapter: "fake", cliVersion: null } } as AgentEvent;
    }
    // Turn boundary, as the real adapters do: queued follow-ups become further (empty) turns.
    while (!state.interrupted && state.nextTurn) {
      const next = await state.nextTurn();
      if (!next) break;
      state.inputs.push(toUserInput(next));
    }
    yield { type: "run.ended", reason: state.interrupted ? "stopped" : "completed", runId: run.runId, seq, at: new Date().toISOString(), source: { adapter: "fake", cliVersion: null } };
  }

  async send(run: RunHandle, input: UserInput): Promise<void> {
    this.mustGet(run).inputs.push(input);
  }

  /** Records steered text; capabilities leave `steer` off, so only tests that claim it use this. */
  async steer(run: RunHandle, input: UserInput): Promise<void> {
    this.mustGet(run).steered.push(input);
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
  inspect(run: RunHandle): { answers: Answer[]; inputs: UserInput[]; steered: UserInput[]; mcpResults: Array<{ isError: boolean; text: string }>; started: { prompt: string; attachments: Attachment[] } } {
    const s = this.mustGet(run);
    return { answers: [...s.received], inputs: [...s.inputs], steered: [...s.steered], mcpResults: [...s.mcpResults], started: s.started };
  }

  private mustGet(run: RunHandle): RunState {
    const state = this.runs.get(run.runId);
    if (!state) throw new Error(`Unknown run ${run.runId}`);
    return state;
  }
}

const REF = /^\{\{mcp\.(\d+)\.(\w+)\}\}$/;

/** Replaces `{{mcp.N.field}}` strings with fields of earlier mcp results; anything unresolved stays as written. */
function resolveRefs(v: unknown, results: ReadonlyArray<{ text: string }>): unknown {
  if (typeof v === "string") {
    const m = REF.exec(v);
    if (!m) return v;
    try {
      const value = (JSON.parse(results[Number(m[1])]?.text ?? "null") as Record<string, unknown> | null)?.[m[2]!];
      return value === undefined ? v : value;
    } catch {
      return v;
    }
  }
  if (Array.isArray(v)) return v.map((x) => resolveRefs(x, results));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveRefs(x, results)]));
  return v;
}
