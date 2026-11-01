import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentEvent, GOAL_PLAN_OUTPUT, REVIEW_VERDICT_OUTPUT, type Profile, type StartRequest } from "@crewyard/core";
import { afterEach, describe, expect, it } from "vitest";
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

  it("waits for the next turn mid-script and goes on with what it was given", async () => {
    const inputs = ["first answer"];
    const adapter = new FakeAdapter([{ emit: { type: "message.delta", text: "a" } }, { awaitTurn: true }, { emit: { type: "message.delta", text: "b" } }, { awaitTurn: true }, { emit: { type: "message.delta", text: "never" } }]);
    const run = await adapter.start({ ...req, nextTurn: async () => inputs.shift() ?? null });
    const texts: string[] = [];
    for await (const ev of adapter.events(run)) if (ev.type === "message.delta") texts.push(ev.text);
    expect(texts).toEqual(["a", "b"]);
    expect(adapter.inspect(run).inputs).toHaveLength(1);
  });

  describe("write steps", () => {
    const dirs: string[] = [];
    afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
    const folder = () => {
      const d = mkdtempSync(join(tmpdir(), "crewyard fake write "));
      dirs.push(d);
      return join(d, "work tree");
    };
    const drain = async (adapter: FakeAdapter, cwd: string) => {
      const run = await adapter.start({ ...req, cwd });
      const types: string[] = [];
      for await (const ev of adapter.events(run)) types.push(ev.type);
      return types;
    };

    it("writes UTF-8 files inside the run's folder, creating folders, in script order", async () => {
      const cwd = folder();
      const adapter = new FakeAdapter([{ write: { path: "docs/giriş kılavuzu.md", text: "# İki adımlı doğrulama\n" } }, { emit: { type: "message.delta", text: "yazdım" } }]);
      expect(await drain(adapter, cwd)).toEqual(["message.delta", "run.ended"]);
      expect(readFileSync(join(cwd, "docs", "giriş kılavuzu.md"), "utf8")).toBe("# İki adımlı doğrulama\n");
    });

    it("refuses a path that leaves the run's folder or is absolute", async () => {
      const cwd = folder();
      for (const path of ["../outside.txt", "docs/../../outside.txt", join(cwd, "..", "abs.txt"), "."]) {
        await expect(drain(new FakeAdapter([{ write: { path, text: "x" } }]), cwd)).rejects.toThrow(/outside the run's folder/);
      }
      expect(existsSync(join(cwd, "..", "outside.txt"))).toBe(false);
      expect(existsSync(join(cwd, "..", "abs.txt"))).toBe(false);
    });

    // Read-only roles run in the project's own checkout (no worktree), so this is what keeps a
    // scripted planner, reviewer or researcher from writing there, as a real runner's engine refuses.
    it("refuses every write in a read-only run, such as the goal planner's", async () => {
      const cwd = folder();
      const adapter = new FakeAdapter([{ write: { path: "src/plan notları.ts", text: "x" } }, { result: { summary: "Plan", tasks: [] } }]);
      const run = await adapter.start({ ...req, cwd, prompt: "Role: Goal planner", outputSchema: GOAL_PLAN_OUTPUT, policy: { writes: "none", allowCommands: [], network: "denied" } });
      await expect((async () => {
        for await (const _ of adapter.events(run)) void _;
      })()).rejects.toThrow(/refused by the run's policy \(read-only\)/);
      expect(existsSync(join(cwd, "src"))).toBe(false);
    });

    it("lets a docs run write documentation only", async () => {
      const cwd = folder();
      const docs = { ...req, cwd, policy: { writes: "docs" as const, allowCommands: [], network: "ask" as const } };
      const ok = new FakeAdapter([{ write: { path: "CHANGELOG.md", text: "- Passkey\n" } }, { write: { path: "docs/giriş kılavuzu.md", text: "# Giriş\n" } }]);
      for await (const _ of ok.events(await ok.start(docs))) void _;
      expect(readFileSync(join(cwd, "CHANGELOG.md"), "utf8")).toBe("- Passkey\n");
      expect(readFileSync(join(cwd, "docs", "giriş kılavuzu.md"), "utf8")).toBe("# Giriş\n");
      const bad = new FakeAdapter([{ write: { path: "src/a.ts", text: "x" } }]);
      const run = await bad.start(docs);
      await expect((async () => {
        for await (const _ of bad.events(run)) void _;
      })()).rejects.toThrow(/refused by the run's policy \(docs only\)/);
      expect(existsSync(join(cwd, "src"))).toBe(false);
    });
  });

  describe("result steps", () => {
    const ended = async (adapter: FakeAdapter, r: StartRequest) => {
      const run = await adapter.start(r);
      let last: AgentEvent | null = null;
      for await (const ev of adapter.events(run)) last = ev;
      return last as Extract<AgentEvent, { type: "run.ended" }>;
    };
    const plan = { summary: "Önce araştır.", tasks: [{ key: "r", title: "Kütüphaneleri karşılaştır", kind: "research", mode: "solo", size: "S", description: "Karşılaştır.", acceptance: ["Bir öneri"], basis: "passkey", dependsOn: [], paths: [], reason: "Önce bilgi gerek.", priority: "high" }] };

    it("ends the run with a result that fits the run's schema", async () => {
      const ev = await ended(new FakeAdapter([{ result: plan }]), { ...req, outputSchema: GOAL_PLAN_OUTPUT });
      expect(AgentEvent.safeParse(ev).success).toBe(true);
      expect(ev).toMatchObject({ type: "run.ended", reason: "completed", output: { ok: true, value: plan } });
    });

    it("reports a result that does not fit the schema as the real adapters do", async () => {
      const ev = await ended(new FakeAdapter([{ result: { verdict: "maybe" } }]), { ...req, outputSchema: REVIEW_VERDICT_OUTPUT });
      expect(ev.output).toMatchObject({ ok: false });
      expect((ev.output as { error: string }).error.length).toBeGreaterThan(0);
    });

    it("carries no output when the script gives none, and none when the run was stopped", async () => {
      expect((await ended(new FakeAdapter([{ emit: { type: "message.delta", text: "a" } }]), req)).output).toBeUndefined();
      const adapter = new FakeAdapter([{ result: plan }, { awaitAnswer: "never" }]);
      const run = await adapter.start({ ...req, outputSchema: GOAL_PLAN_OUTPUT });
      const it = adapter.events(run)[Symbol.asyncIterator]();
      const pending = it.next();
      await adapter.interrupt(run);
      const first = (await pending).value as Extract<AgentEvent, { type: "run.ended" }>;
      expect(first).toMatchObject({ type: "run.ended", reason: "stopped" });
      expect(first.output).toBeUndefined();
    });
  });
});
