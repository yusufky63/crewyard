import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, StartRequest } from "@crewyard/core";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PROFILES, E2eAdapter, e2eDirectory, e2eHook, type E2eScript } from "./index.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function scriptFile(script: E2eScript): string {
  const dir = mkdtempSync(join(tmpdir(), "crewyard e2e-"));
  dirs.push(dir);
  const file = join(dir, "script.json");
  writeFileSync(file, JSON.stringify(script));
  return file;
}

const req = (prompt: string) => ({ prompt }) as StartRequest;
const say = (text: string) => ({ emit: { type: "message.delta" as const, text } });

async function texts(adapter: E2eAdapter, prompt: string, resume = false): Promise<string[]> {
  const h = resume ? await adapter.resume({ runner: "fake", sessionId: "s" }, req(prompt)) : await adapter.start(req(prompt));
  const out: string[] = [];
  for await (const e of adapter.events(h) as AsyncIterable<AgentEvent>) if (e.type === "message.delta") out.push(e.text);
  return out;
}

describe("e2e hook", () => {
  it("stays off without the flag and needs an absolute script path with it", () => {
    expect(e2eHook({})).toBeNull();
    expect(e2eHook({ CREWYARD_E2E_SCRIPT: "x.json" })).toBeNull();
    expect(() => e2eHook({ CREWYARD_E2E: "1", CREWYARD_E2E_SCRIPT: "x.json" })).toThrow("absolute");
  });

  it("plays the n-th script for each role, repeats the last, and uses resume and * keys", async () => {
    const file = scriptFile({ scripts: { researcher: [[say("r1")], [say("r2")]], resume: [[say("again")]], "*": [[say("any")]] } });
    const adapter = new E2eAdapter(file);
    expect(await texts(adapter, "Role: Researcher\n...")).toEqual(["r1"]);
    expect(await texts(adapter, "Role: Researcher\n...")).toEqual(["r2"]);
    expect(await texts(adapter, "Role: Researcher\n...")).toEqual(["r2"]);
    expect(await texts(adapter, "Continue the task where you stopped.", true)).toEqual(["again"]);
    expect(await texts(adapter, "Role: Reviewer\n...")).toEqual(["any"]);
  });

  it("restarts the numbering when the test rewrites the script", async () => {
    const file = scriptFile({ scripts: { researcher: [[say("a1")], [say("a2")]] } });
    const adapter = new E2eAdapter(file);
    expect(await texts(adapter, "Role: Researcher")).toEqual(["a1"]);
    writeFileSync(file, JSON.stringify({ scripts: { researcher: [[say("b1")], [say("b2")]] } }));
    expect(await texts(adapter, "Role: Researcher")).toEqual(["b1"]);
  });

  it("offers the default fake profiles as ready candidates on the fake runner", async () => {
    const file = scriptFile({ scripts: {} });
    const adapter = new E2eAdapter(file);
    const candidates = await e2eDirectory(adapter).candidates("p");
    expect(candidates.map((c) => [c.profile.id, c.profile.runner, c.ready])).toEqual(DEFAULT_PROFILES.map((p) => [p.id, "fake", true]));
    expect(e2eHook({ CREWYARD_E2E: "1", CREWYARD_E2E_SCRIPT: file })?.options.adapters?.has("fake")).toBe(true);
  });
});
