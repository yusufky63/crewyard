import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import type { AgentAdapter, AgentCapabilities, AgentEvent, NativeSessionRef, RunHandle, StartRequest } from "@crewyard/core";
import { resolveBin } from "@crewyard/proc";
import { startFakeModel, USAGE, type Director, type FakeModel, type ModelRequest } from "./fake-model.ts";
import { children, gone, type ProcRow } from "./procs.ts";
import { QUESTION, RUNNERS, type Prepared, type RunnerSpec, type ToolShape } from "./runners.ts";

// `pnpm conformance` (CREWYARD_CONFORMANCE=1): the PLAN.md §5.4 scenarios against every installed
// runner CLI, driven through our own adapters, with a scripted local model in place of a provider.
// Free and deterministic, so it gates a CLI version bump (D6) without the paid live suite.
//
// CREWYARD_CONFORMANCE_RUNNERS=codex,claude-code,opencode,gemini-cli   run only these runners
// CREWYARD_CONFORMANCE_OUT=<folder>   where report.json and report.md go (default: TEMP)
//
// Each runner gets its own temp folder with spaces in its path (profile folder and a git work tree),
// deleted afterwards. A runner whose CLI is not on PATH is skipped.

const enabled = process.env.CREWYARD_CONFORMANCE === "1";
const ONLY = process.env.CREWYARD_CONFORMANCE_RUNNERS?.split(",").map((s) => s.trim()) ?? null;
const OUT = process.env.CREWYARD_CONFORMANCE_OUT ?? join(tmpdir(), "crewyard-conformance-out");
const WAIT_MS = 120_000;

// Nothing in this run may reach a paid account: a real key or endpoint in the environment would let
// a runner (or a fallback inside it) spend. The adapters strip most of these too; this is the backstop.
for (const name of Object.keys(process.env)) {
  if (/(_API_KEY|_AUTH_TOKEN|_BASE_URL)$/i.test(name) || /^(ANTHROPIC|OPENAI|CODEX_API|GEMINI|GOOGLE_GENAI|GOOGLE_CLOUD)_/i.test(name)) delete process.env[name];
}

type Result = "pass" | "fail" | "n/a" | "skipped";
interface Row {
  runner: string;
  version: string | null;
  scenario: string;
  result: Result;
  notes: string;
}
const rows: Row[] = [];

const MARKER = /\[\[cf:([a-z]+)\]\]/g;
const prompt = (scenario: string) => `Crewyard conformance check [[cf:${scenario}]]. Follow the scripted model.`;
const scenarioOf = (text: string) => [...text.matchAll(MARKER)].at(-1)?.[1] ?? null;
const FILES: Record<string, string> = { approve: "approved.txt", deny: "denied.txt", stop: "stopped.txt" };
const DENY_MESSAGE = "cf-deny: stay inside the work tree";

/** The scripted model for one runner: what to answer for each scenario, step by step. */
function director(spec: RunnerSpec): Director {
  return (req) => {
    // Side requests (titles, summaries, Gemini's next-speaker check) carry no tools.
    if (req.tools.length === 0 || req.wantsJson) return { kind: "text", text: "Conformance check" };
    const scenario = scenarioOf(req.lastUserText);
    if (!scenario) return { kind: "text", text: "cf-no-scenario" };
    if (scenario === "hang") return { kind: "hang", text: "cf-working" };
    const steps = stepsFor(spec, scenario, req);
    if (!steps) return { kind: "text", text: `cf-missing-tool ${scenario}` };
    const next = steps[req.toolRounds];
    return next ? { kind: "tool", ...next } : { kind: "text", text: `cf-done ${scenario}` };
  };
}

function stepsFor(spec: RunnerSpec, scenario: string, req: ModelRequest): ToolShape[] | null {
  const file = FILES[scenario];
  if (file) {
    const shell = spec.shell(req.tools, `echo cf > ${file}`);
    return shell ? [shell] : null;
  }
  if (scenario === "plan") {
    const plan = spec.plan(req.tools, req.transcript);
    return plan.length ? plan : null;
  }
  if (scenario === "question") {
    const q = spec.question(req.tools);
    return q ? [q] : null;
  }
  return [];
}

/** Reads a run's events in the background so a scenario can wait for one. */
class Recorder {
  readonly events: AgentEvent[] = [];
  ended = false;
  error: unknown = null;
  readonly done: Promise<void>;
  readonly handle: RunHandle;

  /** `log` gets every event as a JSON line (the runner's events.jsonl in the report folder). */
  constructor(adapter: AgentAdapter, handle: RunHandle, log: (line: string) => void) {
    this.handle = handle;
    this.done = (async () => {
      try {
        for await (const ev of adapter.events(handle)) {
          this.events.push(ev);
          log(JSON.stringify(ev));
        }
      } catch (err) {
        this.error = err;
      } finally {
        this.ended = true;
      }
    })();
  }

  async waitFor<T extends AgentEvent["type"]>(type: T, pred: (e: Extract<AgentEvent, { type: T }>) => boolean = () => true, timeoutMs = WAIT_MS): Promise<Extract<AgentEvent, { type: T }>> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.events.find((e): e is Extract<AgentEvent, { type: T }> => e.type === type && pred(e as Extract<AgentEvent, { type: T }>));
      if (hit) return hit;
      if (this.ended) throw new Error(`the run's events ended without ${type} (${this.summary()})`);
      if (Date.now() > until) throw new Error(`no ${type} within ${Math.round(timeoutMs / 1000)} s (${this.summary()})`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  text(): string {
    return this.events.map((e) => (e.type === "message.delta" ? e.text : "")).join("");
  }

  last<T extends AgentEvent["type"]>(type: T): Extract<AgentEvent, { type: T }> | undefined {
    return this.events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type).at(-1);
  }

  summary(): string {
    const ended = this.last("run.ended");
    const types = [...new Set(this.events.map((e) => e.type))].join(",");
    return `saw ${types || "nothing"}${ended ? `; ended ${ended.reason}${ended.detail ? `: ${ended.detail.slice(0, 300)}` : ""}` : ""}${this.error ? `; error ${String(this.error).slice(0, 300)}` : ""}`;
  }
}

function initRepo(cwd: string): void {
  mkdirSync(cwd, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Crewyard Conformance", "-c", "user.email=conformance@crewyard.invalid", ...args], { cwd, windowsHide: true, stdio: "ignore" });
  git("init", "-q");
  writeFileSync(join(cwd, "README.md"), "# Conformance work tree\n");
  git("add", ".");
  git("commit", "-q", "-m", "Initial commit");
}

for (const spec of RUNNERS) {
  describe.runIf(enabled && (!ONLY || ONLY.includes(spec.runner)))(spec.label, () => {
    let bin: string | null = null;
    let version: string | null = null;
    let root = "";
    let cwd = "";
    let fake: FakeModel | null = null;
    let prep: Prepared | null = null;
    let adapter: AgentAdapter | null = null;
    /** What probe() said for this CLI version; capabilities that depend on the agent are narrowed there. */
    let caps: AgentCapabilities | null = null;
    let baseline: ProcRow[] = [];
    let approveRun: Recorder | null = null;
    let approveSession: NativeSessionRef | null = null;

    const row = (scenario: string, result: Result, notes: string) => {
      rows.push({ runner: spec.runner, version, scenario, result, notes });
      console.log(`[${spec.runner} ${version ?? "?"}] ${scenario}: ${result.toUpperCase()} ${notes}`);
    };

    /** Model requests the fake saw for a scenario. */
    const seen = (scenario: string) => (fake?.requests ?? []).filter((r) => r.tools.length > 0 && scenarioOf(r.lastUserText) === scenario);

    const launch = async (scenario: string, ref?: NativeSessionRef): Promise<Recorder> => {
      if (!adapter || !prep) throw new Error("setup did not finish");
      const req: StartRequest = { profile: prep.profile, cwd, model: prep.model, prompt: prompt(scenario), policy: { writes: "worktree", allowCommands: [], network: "ask" }, env: prep.env };
      const handle = ref ? await adapter.resume(ref, req) : await adapter.start(req);
      return new Recorder(adapter, handle, (line) => appendFileSync(join(OUT, `${spec.runner}-events.jsonl`), `${scenario} ${line}\n`));
    };

    /** Stops a run a failed scenario left behind, so the next one starts clean. */
    const settle = async (rec: Recorder | null) => {
      if (!rec || rec.ended || !adapter) return;
      await adapter.stop(rec.handle).catch(() => undefined);
      await Promise.race([rec.done, new Promise((r) => setTimeout(r, 15_000))]);
    };

    /** Allows every approval the run asks for until it ends; resolves to how many there were. */
    const allowAll = async (rec: Recorder): Promise<number> => {
      const answered = new Set<string>();
      while (!rec.ended) {
        for (const e of rec.events) {
          if (e.type !== "request.approval" || answered.has(e.requestId)) continue;
          answered.add(e.requestId);
          await adapter!.answer(rec.handle, e.requestId, { kind: "approval", decision: "allow_once" });
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      return answered.size;
    };

    const scenario = (name: string, fn: () => Promise<{ result: Result; notes: string }>) =>
      it(name, async (ctx) => {
        if (!bin) {
          row(name, "skipped", `${spec.command} is not on PATH`);
          ctx.skip();
          return;
        }
        let outcome: { result: Result; notes: string };
        try {
          outcome = await fn();
        } catch (err) {
          // undici's "fetch failed" says nothing without its cause.
          const cause = err instanceof Error && err.cause ? ` (${err.cause instanceof Error ? err.cause.message : String(err.cause)})` : "";
          outcome = { result: "fail", notes: `${err instanceof Error ? err.message : String(err)}${cause}` };
        }
        row(name, outcome.result, outcome.notes);
        if (outcome.result === "fail") throw new Error(outcome.notes);
      });

    const pass = (notes: string) => ({ result: "pass" as const, notes });
    const fail = (notes: string) => ({ result: "fail" as const, notes });

    beforeAll(async () => {
      bin = await resolveBin(spec.command);
      if (!bin) return;
      mkdirSync(OUT, { recursive: true });
      writeFileSync(join(OUT, `${spec.runner}-events.jsonl`), "");
      baseline = children();
      root = mkdtempSync(join(tmpdir(), "crewyard conformance "));
      cwd = join(root, "work tree");
      initRepo(cwd);
      fake = await startFakeModel(director(spec));
      prep = spec.prepare(root, fake.url);
      adapter = spec.adapter();
      const probe = await adapter.probe(prep.profile);
      version = probe.version;
      caps = probe.capabilities;
      console.log(`[${spec.runner}] ${bin} ${version ?? "(no version)"}${probe.problems.length ? ` problems: ${probe.problems.join("; ")}` : ""}`);
    });

    afterAll(async () => {
      if (fake) {
        // What the runner sent, without system prompts: the first thing to read when a CLI bump fails.
        mkdirSync(OUT, { recursive: true });
        const trace = fake.requests.map((r) => ({ wire: r.wire, path: r.path, model: r.model, stream: r.stream, tools: r.tools, lastUserText: r.lastUserText.slice(-300), toolRounds: r.toolRounds, toolResults: r.toolResults }));
        writeFileSync(join(OUT, `${spec.runner}-requests.json`), JSON.stringify({ unknown: fake.unknown, requests: trace }, null, 2));
      }
      if (fake?.unknown.length) console.log(`[${spec.runner}] requests the fake model does not serve: ${[...new Set(fake.unknown)].join(", ")}`);
      await fake?.close();
      if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    });

    scenario("start", async () => {
      const rec = await launch("start");
      try {
        const ended = await rec.waitFor("run.ended");
        if (ended.reason !== "completed") return fail(`ended ${ended.reason}: ${ended.detail ?? ""}`);
        if (!rec.text().includes("cf-done start")) return fail(`final text was "${rec.text().slice(0, 200)}"`);
        return pass(`${rec.events.length} events, turn.started ${rec.events.some((e) => e.type === "turn.started") ? "yes" : "no"}`);
      } finally {
        await settle(rec);
      }
    });

    scenario("plan", async () => {
      const rec = await launch("plan");
      try {
        // Gemini CLI asks before write_todos; the plan is still the runner's own, so allow it.
        const approvals = allowAll(rec);
        const ended = await rec.waitFor("run.ended");
        const asked = await approvals;
        const plan = rec.last("plan.update");
        const tool = rec.events.find((e) => e.type === "tool.call");
        if (rec.text().includes("cf-missing-tool")) return fail(`no plan tool offered (tools: ${seen("plan")[0]?.tools.join(",") ?? "?"})`);
        // A runner that never reports its plan is a known gap, held to that: a plan arriving means
        // the CLI now sends one and capabilities.plan should change.
        if (caps?.plan === false) {
          if (plan) return fail(`capabilities.plan is false, yet a plan.update with ${plan.steps.length} step(s) arrived; the CLI reports plans now`);
          return { result: "n/a", notes: `known CLI gap, capabilities.plan false: ${spec.gaps?.plan ?? "no source given"}; no plan.update arrived (${rec.summary()})` };
        }
        if (!plan || plan.steps.length === 0) return fail(`no plan.update with steps (${rec.summary()})`);
        if (ended.reason !== "completed") return fail(`ended ${ended.reason}: ${ended.detail ?? ""}`);
        return pass(`plan.update with ${plan.steps.length} step(s): ${plan.steps.map((s) => `${s.title} [${s.status}]`).join("; ")}; tool.call ${tool?.type === "tool.call" ? tool.title : "none"}${asked ? `; asked for approval ${asked} time(s) first` : ""}`);
      } finally {
        await settle(rec);
      }
    });

    scenario("tool call + approve once", async () => {
      const rec = await launch("approve");
      approveRun = rec;
      try {
        const approval = await rec.waitFor("request.approval");
        const tool = rec.events.find((e) => e.type === "tool.call");
        await adapter!.answer(rec.handle, approval.requestId, { kind: "approval", decision: "allow_once" });
        const ended = await rec.waitFor("run.ended");
        approveSession = rec.handle.nativeSession;
        const ran = existsSync(join(cwd, FILES.approve!));
        const resultSent = seen("approve").some((r) => r.toolRounds > 0);
        if (ended.reason !== "completed") return fail(`ended ${ended.reason}: ${ended.detail ?? ""}`);
        if (!ran) return fail("the approved command did not run (no approved.txt)");
        if (!resultSent) return fail("no tool result reached the model");
        return pass(`approval for "${approval.command ?? approval.paths.join(", ")}", tool.call ${tool?.type === "tool.call" ? `"${tool.title}" (${tool.kind})` : "none"}; command ran; result sent back`);
      } finally {
        await settle(rec);
      }
    });

    scenario("deny once", async () => {
      const rec = await launch("deny");
      try {
        const approval = await rec.waitFor("request.approval");
        await adapter!.answer(rec.handle, approval.requestId, { kind: "approval", decision: "deny", message: DENY_MESSAGE });
        const ended = await rec.waitFor("run.ended");
        const ran = existsSync(join(cwd, FILES.deny!));
        const results = seen("deny").flatMap((r) => r.toolResults);
        if (ran) return fail("the denied command ran (denied.txt exists)");
        if (ended.reason !== "completed") return fail(`ended ${ended.reason}: ${ended.detail ?? ""}`);
        // Some runners end the turn on a denial without asking the model again; both are fine.
        if (results.length === 0) return pass("command did not run; the runner ended the turn without another model call");
        const reason = results.some((r) => r.text.includes(DENY_MESSAGE));
        return pass(`command did not run; the model got "${results[0]!.text.replace(/\s+/g, " ").slice(0, 120)}"; deny reason ${reason ? "passed on" : "not passed on"}`);
      } finally {
        await settle(rec);
      }
    });

    scenario("answer a question", async () => {
      if (!adapter!.capabilities.answerQuestions) return { result: "n/a", notes: "capabilities.answerQuestions is false for this adapter" };
      const rec = await launch("question");
      try {
        const q = await rec.waitFor("request.question").catch((err: unknown) => {
        const results = seen("question").flatMap((r) => r.toolResults.map((t) => t.text.replace(/\s+/g, " ").slice(0, 200)));
        throw new Error(`${err instanceof Error ? err.message : String(err)}; tool results: ${results.join(" | ") || "none"}`);
      });
        await adapter!.answer(rec.handle, q.requestId, { kind: "question", answers: [{ selected: [QUESTION.options[0]] }] });
        const ended = await rec.waitFor("run.ended");
        const results = seen("question").flatMap((r) => r.toolResults);
        if (ended.reason !== "completed") return fail(`ended ${ended.reason}: ${ended.detail ?? ""}`);
        if (!results.some((r) => r.text.includes(QUESTION.options[0]))) return fail(`the answer did not reach the model (results: ${results.map((r) => r.text.slice(0, 80)).join(" | ") || "none"})`);
        return pass(`question "${q.questions[0]?.prompt ?? ""}" with ${q.questions[0]?.options.length ?? 0} options; answer reached the model`);
      } finally {
        await settle(rec);
      }
    });

    scenario("interrupt", async () => {
      const rec = await launch("hang");
      try {
        await rec.waitFor("message.delta", (e) => e.text.includes("cf-working"));
        const refused = await adapter!.interrupt(rec.handle).then(
          () => null,
          (err: unknown) => (err instanceof Error ? `${err.message}${err.cause instanceof Error ? ` (${err.cause.message})` : ""}` : String(err)),
        );
        const ended = await rec.waitFor("run.ended", () => true, 60_000);
        // The orchestrator treats both as resumable (RESUMABLE in orchestrator/db.ts); the report shows which one.
        if (ended.reason !== "interrupted" && ended.reason !== "stopped") return fail(`ended ${ended.reason}${ended.detail ? `: ${ended.detail}` : ""}, expected interrupted`);
        // A caller (the Stop button) would show this error although the interrupt worked.
        if (refused) return fail(`interrupt() rejected with "${refused}" although the run ended ${ended.reason}`);
        return pass(`turn in flight interrupted; run.ended ${ended.reason}${ended.detail ? ` (${ended.detail})` : ""}`);
      } finally {
        await settle(rec);
      }
    });

    scenario("resume", async () => {
      if (!approveSession) return fail("no session from the approve scenario to resume");
      const rec = await launch("resume", approveSession);
      try {
        const ended = await rec.waitFor("run.ended");
        if (ended.reason !== "completed") return fail(`ended ${ended.reason}: ${ended.detail ?? ""}`);
        const history = seen("resume").some((r) => r.transcript.includes("[[cf:approve]]"));
        if (!history) return fail("the resumed turn did not carry the earlier conversation");
        return pass(`session ${approveSession.sessionId.slice(0, 12)}… resumed with its history`);
      } finally {
        await settle(rec);
      }
    });

    scenario("read usage", async () => {
      const usage = (approveRun as Recorder | null)?.last("usage.update");
      if (!usage) return fail("the approve run reported no usage.update");
      const notes = `in=${usage.tokensIn} out=${usage.tokensOut} cacheRead=${usage.cacheRead} context=${usage.contextUsed ?? "-"}/${usage.contextSize ?? "-"} cost=${usage.costUsd ?? "-"} ${usage.costProvenance} (fake reports ${USAGE.input} in, ${USAGE.cachedInput} cached, ${USAGE.output} out per call)`;
      if (usage.tokensIn <= 0 || usage.tokensOut <= 0) return fail(`token counts missing: ${notes}`);
      return pass(notes);
    });

    scenario("read limits", async () => {
      if (!adapter!.limits) return { result: "n/a", notes: `no limits() (capabilities.reportedLimits ${adapter!.capabilities.reportedLimits})` };
      const samples = await adapter!.limits(prep!.profile);
      // An API-key profile on a fake provider has no limit source, so anything Reported would be invented.
      const reported = samples.filter((s) => s.provenance === "reported");
      if (reported.length) return fail(`reported limits from a fake provider: ${reported.map((s) => s.window).join(", ")}`);
      return pass(samples.length ? samples.map((s) => `${s.window} ${s.provenance}`).join(", ") : "no samples");
    });

    scenario("stop, no process remains", async () => {
      const before = children();
      const rec = await launch("stop");
      try {
        await rec.waitFor("request.approval");
        const tree = children().filter((r) => !before.some((b) => b.pid === r.pid));
        await adapter!.stop(rec.handle);
        const ended = await rec.waitFor("run.ended", () => true, 60_000);
        const left = await gone(tree, 20_000);
        if (left.length) return fail(`still running after stop: ${left.map((r) => `${r.name} ${r.pid}`).join(", ")}`);
        if (existsSync(join(cwd, FILES.stop!))) return fail("the unanswered command ran (stopped.txt exists)");
        return pass(`run.ended ${ended.reason}; ${tree.length} process(es) gone: ${[...new Set(tree.map((r) => r.name))].join(", ")}`);
      } finally {
        await settle(rec);
      }
    });

    scenario("no process left after the suite", async () => {
      const extra = children().filter((r) => !baseline.some((b) => b.pid === r.pid));
      const left = await gone(extra, 20_000);
      return left.length ? fail(`left running: ${left.map((r) => `${r.name} ${r.pid}`).join(", ")}`) : pass("none");
    });
  });
}

afterAll(() => {
  if (!rows.length) return;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), JSON.stringify({ at: new Date().toISOString(), platform: process.platform, rows }, null, 2));
  const md = ["| Runner | Version | Scenario | Result | Notes |", "|---|---|---|---|---|", ...rows.map((r) => `| ${r.runner} | ${r.version ?? "-"} | ${r.scenario} | ${r.result} | ${r.notes.replace(/\|/g, "\\|").replace(/\s+/g, " ")} |`)];
  writeFileSync(join(OUT, "report.md"), `${md.join("\n")}\n`);
  console.log(`\nconformance report: ${join(OUT, "report.md")}\n${md.join("\n")}`);
});
