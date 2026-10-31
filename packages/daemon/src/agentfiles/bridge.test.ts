import type { FakeStep } from "@crewyard/adapter-fake";
import { FakeAdapter } from "@crewyard/adapter-fake";
import type { AgentAdapter, StartRequest } from "@crewyard/core";
import { describe, expect, it } from "vitest";
import { AdapterRegistry } from "../orchestrator/adapters.ts";
import { bridgeDecorator } from "./bridge.ts";

const req = (cwd: string): StartRequest => ({
  profile: { id: "p", alias: "a", runner: "fake", providerId: "x", credential: { kind: "local", secretRef: null }, defaultModel: null, configDir: ".", baseUrl: null },
  cwd,
  model: null,
  prompt: "hi",
  policy: { writes: "none", allowCommands: [], network: "denied" },
  env: {},
});

class Recording extends FakeAdapter {
  readonly seen: StartRequest[] = [];
  constructor() {
    super([] as FakeStep[]);
  }
  override start(r: StartRequest) {
    this.seen.push(r);
    return super.start(r);
  }
}

describe("the bridge decorator", () => {
  it("adds the files to starts and resumes, keeps everything else, and wraps adapters made before and after", async () => {
    const early = new Recording();
    const registry = new AdapterRegistry({ codex: () => new Recording() as unknown as AgentAdapter });
    registry.set("fake", early);
    const asked: string[] = [];
    registry.decorate(
      bridgeDecorator((runner, cwd) => {
        asked.push(`${runner}:${cwd}`);
        return cwd === "C:\\repo" ? ["CLAUDE.md"] : null;
      }),
    );
    const fake = registry.get("fake")!;
    expect(fake.id).toBe("fake");
    expect(fake.capabilities).toBe(early.capabilities);
    await fake.start(req("C:\\repo"));
    await fake.start(req("C:\\other"));
    expect(early.seen.map((r) => r.instructionFiles)).toEqual([["CLAUDE.md"], undefined]);
    await registry.get("codex")!.start(req("C:\\repo"));
    expect(asked).toEqual(["fake:C:\\repo", "fake:C:\\other", "codex:C:\\repo"]);
  });

  it("starts the run as it would without a bridge when the lookup fails", async () => {
    const inner = new Recording();
    const wrapped = bridgeDecorator(() => {
      throw new Error("database closed");
    })("fake", inner);
    await wrapped.start(req("C:\\repo"));
    expect(inner.seen[0]!.instructionFiles).toBeUndefined();
  });
});
