import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, StartRequest } from "@crewyard/core";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PROFILES, E2eAdapter, e2eDirectory, e2eHook, roleOf, scriptKey, type E2eScript } from "./index.ts";

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

  it("names the goal planner by its id, other roles by their first word", () => {
    expect(roleOf({ prompt: "Role: Goal planner\n\nYou are the Goal planner." })).toBe("goal-planner");
    expect(roleOf({ prompt: "Role: Docs writer\n..." })).toBe("docs");
    expect(roleOf({ prompt: "Role: Implementer" })).toBe("implementer");
    expect(roleOf({ prompt: "Continue where you stopped." })).toBeNull();
  });

  it("prefers a key naming words of the task title, then the role, then *", () => {
    const scripts = { "implementer@Sunucu: passkey": [[]], "implementer@İstemci": [[]], implementer: [[]], "goal-planner@tek görev": [[]], "goal-planner": [[]], "resume@conflicts with the goal branch": [[]], "*": [[]] };
    const role = (r: string, title: string, extra = "") => ({ prompt: `Role: ${r}\n\nYou are the ${r}.\n\nTask:\n<<<\n${title}\nayrıntı\n>>>${extra}` });
    expect(scriptKey(scripts, role("Implementer", "Sunucu: passkey kaydı"), false)).toBe("implementer@Sunucu: passkey");
    expect(scriptKey(scripts, role("Implementer", "İstemci: passkey düğmesi"), false)).toBe("implementer@İstemci");
    // Only the title counts when the prompt quotes a task: a sibling named further down does not match.
    expect(scriptKey(scripts, role("Implementer", "Belgeler", "\nTask 02 (Sunucu: passkey kaydı) is merged"), false)).toBe("implementer");
    expect(scriptKey(scripts, role("Reviewer", "Sunucu: passkey kaydı"), false)).toBe("*");
    // The planner's brief quotes no task section, so its words are looked for in the whole prompt.
    expect(scriptKey(scripts, { prompt: "Role: Goal planner\n\nGoal:\n<<<\nREADME'ye tek görev yeter\n>>>" }, false)).toBe("goal-planner@tek görev");
    expect(scriptKey(scripts, { prompt: "Role: Goal planner\n\nGoal:\n<<<\nbaşka bir hedef\n>>>" }, false)).toBe("goal-planner");
    expect(scriptKey(scripts, { prompt: "Merging task 02 conflicts with the goal branch: CHANGELOG.md" }, true)).toBe("resume@conflicts with the goal branch");
    expect(scriptKey(scripts, { prompt: "Merging task 02 conflicts with the goal branch" }, false)).toBe("*");
  });

  it("counts each keyed script on its own", async () => {
    const file = scriptFile({ scripts: { "implementer@Sunucu": [[say("s1")], [say("s2")]], implementer: [[say("plain")]] } });
    const adapter = new E2eAdapter(file);
    const prompt = (title: string) => `Role: Implementer\n\nTask:\n<<<\n${title}\n>>>`;
    expect(await texts(adapter, prompt("Sunucu tarafı"))).toEqual(["s1"]);
    expect(await texts(adapter, prompt("İstemci tarafı"))).toEqual(["plain"]);
    expect(await texts(adapter, prompt("Sunucu tarafı"))).toEqual(["s2"]);
  });

  it("offers the default fake profiles as ready candidates on the fake runner", async () => {
    const file = scriptFile({ scripts: {} });
    const adapter = new E2eAdapter(file);
    const candidates = await e2eDirectory(adapter).candidates("p");
    expect(candidates.map((c) => [c.profile.id, c.profile.runner, c.ready])).toEqual(DEFAULT_PROFILES.map((p) => [p.id, "fake", true]));
    expect(e2eHook({ CREWYARD_E2E: "1", CREWYARD_E2E_SCRIPT: file })?.options.adapters?.has("fake")).toBe(true);
  });
});
