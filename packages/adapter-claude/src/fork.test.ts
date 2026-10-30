import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionProblemOf, type AgentEvent, type ForkRequest, type Profile, type StartRequest } from "@crewyard/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeAdapterDeps } from "./adapter.ts";
import { fakeQuery, type Step } from "./fake-query.ts";
import { compactBoundary, errorResult, init, result } from "./fixtures.ts";
import { createAdapter } from "./index.ts";
import { sessionProblemDetail } from "./sessions.ts";

const KEY_A = "sk-deepseek-test-aaaaaaaaaaaaaaaa";
const KEY_B = "sk-deepseek-test-bbbbbbbbbbbbbbbb";
const EXE = "C:\\Users\\Test User\\.local\\bin\\claude.exe";
const SOURCE = "0b6f3c1e-8a52-4c1d-9f0e-6d2a7b4c9e10";
const FOLDER = "C--Work-Trees-demo-repo";

let root: string;
let cwd: string;
let A: Profile;
let B: Profile;
let sourcePath: string;

const profile = (id: string, configDir: string): Profile => ({
  id,
  alias: `DeepSeek · ${id}`,
  runner: "claude-code",
  providerId: "deepseek",
  credential: { kind: "api_key", secretRef: id },
  defaultModel: "deepseek-flash",
  configDir,
  baseUrl: "https://api.deepseek.com/anthropic",
});

/** One recorded turn in the shape the CLI writes (2.1.306), trimmed to the fields a resume reads. */
function writeSource(): string {
  const at = "2026-10-30T10:00:00.000Z";
  const base = { sessionId: SOURCE, cwd, version: "2.1.306", gitBranch: "main", isSidechain: false, userType: "external", timestamp: at };
  const lines = [
    { type: "queue-operation", operation: "enqueue", sessionId: SOURCE, timestamp: at },
    { ...base, type: "user", uuid: "11111111-0000-4000-8000-000000000001", parentUuid: null, message: { role: "user", content: "Create fork-marker.txt with the word kiwi." } },
    { ...base, type: "assistant", uuid: "11111111-0000-4000-8000-000000000002", parentUuid: "11111111-0000-4000-8000-000000000001", message: { id: "msg_1", type: "message", role: "assistant", model: "deepseek-flash", content: [{ type: "tool_use", id: "toolu_1", name: "Write", input: { file_path: join(cwd, "fork-marker.txt"), content: "kiwi" } }], stop_reason: "tool_use", usage: { input_tokens: 11000, output_tokens: 60 } } },
    { ...base, type: "user", uuid: "11111111-0000-4000-8000-000000000003", parentUuid: "11111111-0000-4000-8000-000000000002", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "File created" }] } },
    { ...base, type: "assistant", uuid: "11111111-0000-4000-8000-000000000004", parentUuid: "11111111-0000-4000-8000-000000000003", message: { id: "msg_2", type: "message", role: "assistant", model: "deepseek-flash", content: [{ type: "text", text: "DONE" }], stop_reason: "end_turn", usage: { input_tokens: 11900, output_tokens: 31 } } },
    { type: "cost-state", sessionId: SOURCE, timestamp: at },
  ];
  const dir = join(A.configDir, "projects", FOLDER);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${SOURCE}.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  return path;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "crewyard fork test "));
  cwd = join(root, "Work Trees", "demo repo");
  mkdirSync(cwd, { recursive: true });
  A = profile("a", join(root, "profiles", "claude-code", "deepseek a"));
  B = profile("b", join(root, "profiles", "claude-code", "deepseek b"));
  sourcePath = writeSource();
});

afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const forkReq = (over: Partial<ForkRequest> = {}): ForkRequest => ({
  source: { profile: A, session: { runner: "claude-code", sessionId: SOURCE }, env: { ANTHROPIC_API_KEY: KEY_A } },
  target: { profile: B, model: null, env: { ANTHROPIC_API_KEY: KEY_B } },
  cwd,
  compact: false,
  ...over,
});

function setup(turns: Step[][], deps: Partial<ClaudeAdapterDeps> = {}) {
  const fq = fakeQuery(turns);
  const query = vi.fn(fq.query);
  const killTree = vi.fn(async () => {});
  const adapter = createAdapter({
    query,
    which: async () => EXE,
    run: async () => ({ code: 0, stdout: "2.1.312 (Claude Code)\n", stderr: "" }),
    killTree,
    env: { Path: "C:\\Windows", CLAUDE_CONFIG_DIR: "C:\\Users\\Test User\\.claude" },
    ...deps,
  });
  return { adapter, rec: fq.rec, query, killTree };
}

const targetDir = () => join(B.configDir, "projects", FOLDER);
const readJsonl = (path: string) => readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

describe("Claude adapter: fork", () => {
  it("copies the session into the target profile's project folder under a new id and never touches the source", async () => {
    const before = readFileSync(sourcePath);
    const { adapter, query } = setup([]);
    const out = await adapter.fork!(forkReq());

    expect(out.session.runner).toBe("claude-code");
    expect(out.session.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(out.session.sessionId).not.toBe(SOURCE);
    expect(out).toMatchObject({ compacted: false, summary: null, usage: null, totals: { tokensIn: 0, tokensOut: 0, cacheRead: 0, costUsd: 0 } });
    expect(query).not.toHaveBeenCalled();

    expect(readFileSync(sourcePath).equals(before)).toBe(true);
    expect(readdirSync(join(A.configDir, "projects", FOLDER))).toEqual([`${SOURCE}.jsonl`]);
    expect(readdirSync(targetDir())).toEqual([`${out.session.sessionId}.jsonl`]);

    const entries = readJsonl(join(targetDir(), `${out.session.sessionId}.jsonl`));
    const turns = entries.filter((e) => e.type === "user" || e.type === "assistant");
    expect(turns).toHaveLength(4);
    expect(turns.every((e) => e.sessionId === out.session.sessionId)).toBe(true);
    // New message uuids, with the parent chain kept.
    expect(turns.some((e) => String(e.uuid).startsWith("11111111-0000"))).toBe(false);
    expect(turns[0]!.parentUuid).toBeNull();
    for (let i = 1; i < turns.length; i++) expect(turns[i]!.parentUuid).toBe(turns[i - 1]!.uuid);
    // The source's running totals stay behind, which is why the fork starts from zero.
    expect(entries.some((e) => e.type === "cost-state")).toBe(false);
    expect(adapter.capabilities.fork).toEqual({ compact: true });
  });

  it("forks into the same profile without overwriting the source", async () => {
    const before = readFileSync(sourcePath);
    const { adapter } = setup([]);
    const out = await adapter.fork!(forkReq({ target: { profile: A, model: null, env: { ANTHROPIC_API_KEY: KEY_A } } }));
    expect(readFileSync(sourcePath).equals(before)).toBe(true);
    expect(readdirSync(join(A.configDir, "projects", FOLDER)).sort()).toEqual([`${SOURCE}.jsonl`, `${out.session.sessionId}.jsonl`].sort());
  });

  it("says gone when the source profile has no such session", async () => {
    const { adapter } = setup([]);
    const err = await adapter.fork!(forkReq({ source: { profile: A, session: { runner: "claude-code", sessionId: "22222222-0000-4000-8000-000000000000" }, env: {} } })).catch((e: unknown) => e);
    expect(sessionProblemOf(err)).toBe("gone");
    expect(existsSync(targetDir())).toBe(false);
  });

  it("compacts the fork with the target's key and model and reads the summary and usage", async () => {
    let forked = "";
    const forkSession: ClaudeAdapterDeps["forkSession"] = async (id, opts) => {
      const { forkSession: real } = await import("@anthropic-ai/claude-agent-sdk");
      const out = await real(id, opts);
      forked = out.sessionId;
      return out;
    };
    const summary = "The user asked for fork-marker.txt with the word kiwi; it was written.";
    const { adapter, rec } = setup(
      [[init({ model: "deepseek-flash" }), { hook: { hook_event_name: "PostCompact", trigger: "manual", compact_summary: summary, session_id: "x", transcript_path: "x", cwd } }, compactBoundary("x"), result({ modelUsage: { "deepseek-flash": { inputTokens: 13783, outputTokens: 2496, thinkingTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0.29, costBasis: "unknown", contextWindow: 128_000, maxOutputTokens: 8_192 } } })]],
      { forkSession },
    );
    const out = await adapter.fork!(forkReq({ compact: true, target: { profile: B, model: "deepseek-pro", env: { ANTHROPIC_API_KEY: KEY_B } } }));

    expect(out.session.sessionId).toBe(forked);
    expect(out.compacted).toBe(true);
    expect(out.summary).toBe(summary);
    // The CLI cannot price DeepSeek, so the cost is left to the caller.
    expect(out.usage).toEqual({ tokensIn: 13783, tokensOut: 2496, cacheRead: 0, costUsd: null });
    expect(out.totals).toEqual(out.usage);

    const o = rec.options!;
    expect(rec.prompts[0]?.message).toEqual({ role: "user", content: "/compact" });
    expect(o.resume).toBe(forked);
    expect(o.sessionId).toBeUndefined();
    expect(o.cwd).toBe(cwd);
    expect(o.model).toBe("deepseek-pro");
    expect(o.permissionMode).toBe("dontAsk");
    expect(o.env).toMatchObject({ CLAUDE_CONFIG_DIR: B.configDir, ANTHROPIC_AUTH_TOKEN: KEY_B, ANTHROPIC_BASE_URL: B.baseUrl, ANTHROPIC_MODEL: "deepseek-pro", CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1" });
    expect(JSON.stringify(o.env)).not.toContain(KEY_A);
    expect(existsSync(join(targetDir(), `${forked}.jsonl`))).toBe(true);
  });

  it("keeps the fork uncompacted when the CLI finds nothing to compact", async () => {
    const { adapter } = setup([[init(), result({ result: "Not enough messages to compact." })]]);
    const out = await adapter.fork!(forkReq({ compact: true }));
    expect(out).toMatchObject({ compacted: false, summary: null });
    expect(out.usage).not.toBeNull();
    expect(existsSync(join(targetDir(), `${out.session.sessionId}.jsonl`))).toBe(true);
  });

  it("removes the fork and keeps the key out of the error when compaction fails", async () => {
    const before = readFileSync(sourcePath);
    const { adapter } = setup([[init(), errorResult("error_during_execution", { errors: [`401 invalid key ${KEY_B}`] }), { fail: "Claude Code returned an error result" }]]);
    const err = (await adapter.fork!(forkReq({ compact: true })).catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/Compacting the forked session failed/);
    expect(err.message).not.toContain(KEY_B);
    expect(sessionProblemOf(err)).toBeNull();
    expect(readdirSync(targetDir())).toEqual([]);
    expect(readFileSync(sourcePath).equals(before)).toBe(true);
  });

  it("stops a compaction that runs too long and kills the CLI's process tree", async () => {
    const spawn = vi.fn(() => Object.assign(new EventEmitter(), { pid: 5151, stderr: null, exitCode: null }) as unknown as ChildProcess);
    const { adapter, killTree } = setup([[init(), { spawn: { pid: 5151 } }, { block: true }]], { spawn, forkTimeoutMs: 50 });
    const err = (await adapter.fork!(forkReq({ compact: true })).catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/did not finish within/);
    expect(killTree).toHaveBeenCalledWith(5151);
    expect(readdirSync(targetDir())).toEqual([]);
  });

  it("refuses a target profile folder that is signed in to claude.ai", async () => {
    const { adapter } = setup([[init({ apiKeySource: "oauth" }), { block: true }]]);
    await expect(adapter.fork!(forkReq({ compact: true }))).rejects.toThrow(/signed in to claude.ai/);
    expect(readdirSync(targetDir())).toEqual([]);
  });
});

describe("Claude adapter: a session the CLI refuses on resume", () => {
  const req = (): StartRequest => ({ profile: B, cwd, model: null, prompt: "Continue", policy: { writes: "worktree", allowCommands: [], network: "denied" }, env: { ANTHROPIC_API_KEY: KEY_B } });
  const GONE = `No conversation found with session ID: ${SOURCE}`;
  const LOCKED = "Error: That session is running in the background. Run `claude agents` to find it and open it, or stop it there first to resume it here. Add --fork-session to branch off a copy instead.";

  async function endOf(turn: Step[]): Promise<Extract<AgentEvent, { type: "run.ended" }>> {
    const { adapter } = setup([turn]);
    const run = await adapter.resume({ runner: "claude-code", sessionId: SOURCE }, req());
    const events: AgentEvent[] = [];
    for await (const e of adapter.events(run)) events.push(e);
    return events.at(-1) as Extract<AgentEvent, { type: "run.ended" }>;
  }

  it("ends with session.gone when the CLI has no such conversation, even though the SDK throws after it", async () => {
    const end = await endOf([errorResult("error_during_execution", { errors: [GONE], num_turns: 0 }), { fail: `Claude Code returned an error result: ${GONE}` }]);
    expect(end).toMatchObject({ reason: "failed", detail: `session.gone: ${GONE}` });
  });

  it("ends with session.locked when a background session holds it", async () => {
    const end = await endOf([errorResult("error_during_execution", { errors: [LOCKED], startup_failure_reason: "session_held_by_background" }), { fail: `Claude Code returned an error result: ${LOCKED}` }]);
    expect(end.reason).toBe("failed");
    expect(end.detail).toMatch(/^session\.locked: That session is running in the background\./);
  });

  it("finds the refusal in the SDK's error when no result arrived", async () => {
    const end = await endOf([{ fail: `Claude Code returned an error result: ${GONE}` }]);
    expect(end.detail).toBe(`session.gone: ${GONE}`);
  });

  it("leaves other failures without a session prefix", async () => {
    const end = await endOf([errorResult("error_during_execution", { errors: ["API Error: 500"] }), { fail: "Claude Code returned an error result: API Error: 500" }]);
    expect(end.detail).toMatch(/API Error: 500/);
    expect(end.detail).not.toMatch(/^session\./);
  });

  it("matches the CLI's exact strings", () => {
    expect(sessionProblemDetail([GONE])).toBe(`session.gone: ${GONE}`);
    expect(sessionProblemDetail([LOCKED])).toMatch(/^session\.locked: That session/);
    expect(sessionProblemDetail(["Failed to resume session: disk full"])).toBeNull();
  });
});
