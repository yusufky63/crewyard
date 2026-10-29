import { AgentEvent, type Profile, type StartRequest } from "@crewyard/core";
import { describe, expect, it } from "vitest";
import { FakeAdapter } from "./index.ts";

const profile: Profile = { id: "p", alias: "fake", runner: "fake", providerId: "none", credential: { kind: "local", secretRef: null }, defaultModel: null, configDir: ".", baseUrl: null };
const req: StartRequest = { profile, cwd: ".", model: null, prompt: "hi", policy: { writes: "worktree", allowCommands: [], network: "ask" }, env: {} };

describe("FakeAdapter", () => {
  it("emits valid events in order and blocks on requests until answered", async () => {
    const adapter = new FakeAdapter([
      { emit: { type: "run.state", state: "running" } },
      { emit: { type: "request.approval", requestId: "a1", toolCallId: null, command: "dotnet test", cwd: ".", paths: [], network: false } },
      { awaitAnswer: "a1" },
      { emit: { type: "message.delta", text: "done" } },
    ]);
    const run = await adapter.start(req);
    const seen: string[] = [];
    for await (const ev of adapter.events(run)) {
      expect(AgentEvent.safeParse(ev).success).toBe(true);
      seen.push(ev.type);
      if (ev.type === "request.approval") void adapter.answer(run, ev.requestId, { kind: "approval", decision: "allow_once" });
    }
    expect(seen).toEqual(["run.state", "request.approval", "message.delta", "run.ended"]);
    expect(adapter.inspect(run).answers).toEqual([{ kind: "approval", decision: "allow_once" }]);
  });

  it("ends as stopped after an interrupt", async () => {
    const adapter = new FakeAdapter([{ awaitAnswer: "q" }, { emit: { type: "message.delta", text: "never" } }]);
    const run = await adapter.start(req);
    const it = adapter.events(run)[Symbol.asyncIterator]();
    const pending = it.next();
    await adapter.interrupt(run);
    const first = await pending;
    expect(first.value).toMatchObject({ type: "run.ended", reason: "stopped" });
  });
});
