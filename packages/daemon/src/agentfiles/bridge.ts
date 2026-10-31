import type { AgentAdapter, NativeSessionRef, RunnerId, StartRequest } from "@crewyard/core";
import type { AdapterDecorator } from "../orchestrator/adapters.ts";

// The project bridge at run start (docs/adr/0015). A project that turned the bridge on gets its
// chosen instruction files offered to the runners that do not read them natively, through each
// runner's own setting (the adapters map StartRequest.instructionFiles). Wrapping the adapters
// keeps this out of the orchestrator: every start and resume passes through here, the request
// gains the field, and nothing else about it changes. Policy, approvals and caps are untouched.

export type InstructionLookup = (runner: RunnerId, cwd: string) => string[] | null;

export function bridgeDecorator(lookup: InstructionLookup): AdapterDecorator {
  const withFiles = (runner: RunnerId, req: StartRequest): StartRequest => {
    let files: string[] | null = null;
    try {
      files = lookup(runner, req.cwd);
    } catch {
      // A bridge that cannot be read must never stop a run; it starts as it would without one.
      files = null;
    }
    return files && files.length > 0 ? { ...req, instructionFiles: files } : req;
  };
  return (runner, adapter) =>
    new Proxy(adapter, {
      get(target, prop) {
        if (prop === "start") return (req: StartRequest) => target.start(withFiles(runner, req));
        if (prop === "resume") return (ref: NativeSessionRef, req: StartRequest) => target.resume(ref, withFiles(runner, req));
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as AgentAdapter;
}
