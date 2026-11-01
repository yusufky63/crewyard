import { describe, expect, it } from "vitest";
import type { CredentialSummary, GithubAuth, KeyCheckView, ProfileSummary, SignInStatus, TaskSummary, ToolCheck, ToolId } from "@crewyard/core";
import type { UpdateState } from "../../../../shared/api.ts";
import { githubState, guideChecklist, machineProblem, machineState, profileState, refusedByGate, releaseFacts, taskState, type Read } from "./model.ts";

const ok = <T>(data: T): Read<T> => ({ data, pending: false, error: null });
const pending = <T>(): Read<T> => ({ data: undefined, pending: true, error: null });
const failed = <T>(): Read<T> => ({ data: undefined, pending: false, error: new Error("daemon.offline") });

const tool = (id: ToolId, found: boolean, gate: ToolCheck["gate"] = null): ToolCheck => ({ id, found, path: found ? `C:\\Program Files\\${id}\\${id}.exe` : null, version: found ? "1.0.0" : null, detail: null, gate });
const gate = (status: NonNullable<ToolCheck["gate"]>["status"], rule: "min" | "exact" = "min"): ToolCheck["gate"] => ({ status, verified: "2.0.0", rule, update: status === "ok" ? null : "npm i -g x@latest" });
const tooOld = gate("outdated");
const allTools = (over: Partial<Record<ToolId, Read<ToolCheck>>> = {}) => ({
  claude: ok(tool("claude", false)),
  codex: ok(tool("codex", false)),
  opencode: ok(tool("opencode", false)),
  gemini: ok(tool("gemini", false)),
  git: ok(tool("git", true)),
  ...over,
});

describe("machineState", () => {
  it("passes with Git and one usable agent CLI", () => {
    expect(machineState(allTools({ codex: ok(tool("codex", true)) }))).toBe("done");
  });
  it("is not yet done when no agent CLI is installed", () => {
    expect(machineState(allTools())).toBe("todo");
  });
  it("is a problem when Git is missing", () => {
    expect(machineState(allTools({ git: ok(tool("git", false)), codex: ok(tool("codex", true)) }))).toBe("problem");
  });
  it("passes an agent whose version gate only warns", () => {
    // Claude Code and Codex below their checked version, and an unpinned OpenCode 1.x, still start.
    expect(machineState(allTools({ claude: ok(tool("claude", true, tooOld)) }))).toBe("done");
    expect(machineState(allTools({ codex: ok(tool("codex", true, gate("outdated"))) }))).toBe("done");
    expect(machineState(allTools({ opencode: ok(tool("opencode", true, gate("untested", "exact"))) }))).toBe("done");
    // An unreadable version is refused only where the adapter needs it: Gemini CLI's isolation check.
    expect(machineState(allTools({ claude: ok(tool("claude", true, gate("unknown"))) }))).toBe("done");
    expect(machineProblem(allTools({ claude: ok(tool("claude", true, tooOld)) }))).toBeNull();
  });
  it("is a problem when every agent found is one the adapters refuse to start", () => {
    // adapter-acp throws for a Gemini CLI too old (or unreadable) to keep profiles apart, and
    // adapter-opencode never launches a 2.x that has not passed its checks.
    for (const only of [{ gemini: ok(tool("gemini", true, gate("isolation"))) }, { gemini: ok(tool("gemini", true, gate("unknown"))) }, { opencode: ok(tool("opencode", true, gate("pending", "exact"))) }]) {
      expect(machineState(allTools(only))).toBe("problem");
      expect(machineProblem(allTools(only))).toBe("refused");
    }
    // One startable agent next to a refused one is enough.
    expect(machineState(allTools({ gemini: ok(tool("gemini", true, gate("isolation"))), codex: ok(tool("codex", true)) }))).toBe("done");
    // A refused agent next to a failed read: the failed one might be startable.
    expect(machineState(allTools({ gemini: ok(tool("gemini", true, gate("isolation"))), claude: failed() }))).toBe("unknown");
    expect(machineProblem(allTools({ git: ok(tool("git", false)) }))).toBe("git");
  });
  it("names the gates the adapters refuse", () => {
    expect(refusedByGate(tool("gemini", true, gate("isolation")))).toBe(true);
    expect(refusedByGate(tool("gemini", true, gate("unknown")))).toBe(true);
    expect(refusedByGate(tool("opencode", true, gate("pending", "exact")))).toBe(true);
    expect(refusedByGate(tool("opencode", true, gate("unknown", "exact")))).toBe(false);
    expect(refusedByGate(tool("claude", true, tooOld))).toBe(false);
    expect(refusedByGate(tool("gemini", true, gate("ok")))).toBe(false);
    expect(refusedByGate(tool("git", true))).toBe(false);
  });
  it("waits for every check and never turns a failed read into not done", () => {
    expect(machineState(allTools({ gemini: pending() }))).toBe("checking");
    expect(machineState(allTools({ git: failed() }))).toBe("unknown");
    expect(machineState(allTools({ claude: failed() }))).toBe("unknown");
    // One usable agent settles it even when another check failed.
    expect(machineState(allTools({ claude: failed(), codex: ok(tool("codex", true)) }))).toBe("done");
  });
});

const profile = (over: Partial<ProfileSummary>): ProfileSummary => ({ id: "p1", alias: "work", runner: "claude-code", providerId: "anthropic", credentialId: "c1", defaultModel: null, configDir: "C:\\Users\\a b\\cfg", createdAt: "", updatedAt: "", ...over }) as ProfileSummary;
const cred = (over: Partial<CredentialSummary> = {}): CredentialSummary => ({ id: "c1", alias: "key", providerId: "anthropic", kind: "api_key", isSet: true, caps: {} as CredentialSummary["caps"], createdAt: "", ...over });
const check = (state: KeyCheckView["state"]): KeyCheckView => ({ credentialId: "c1", providerId: "anthropic", state, reason: null, status: null, endpoint: null, models: [], extraModels: [] }) as unknown as KeyCheckView;
const signIn = (state: SignInStatus["state"]): SignInStatus => ({ profileId: "p2", kind: "chatgpt", state, plan: null, cliVersion: null, update: null, problem: null, probedAt: null });

describe("profileState", () => {
  const base = { profiles: ok([profile({})]), credentials: ok([cred()]), keyChecks: ok<KeyCheckView[]>([]), signIns: ok<SignInStatus[]>([]) };
  it("is done with a profile whose key is stored and not refused", () => {
    expect(profileState(base)).toBe("done");
  });
  it("is a problem when the only key was refused or is missing", () => {
    expect(profileState({ ...base, keyChecks: ok([check("invalid")]) })).toBe("problem");
    expect(profileState({ ...base, credentials: ok([cred({ isSet: false })]) })).toBe("problem");
  });
  it("counts a runner sign-in only once it is signed in", () => {
    const codex = profile({ id: "p2", runner: "codex", providerId: "openai", credentialId: null });
    expect(profileState({ ...base, profiles: ok([codex]), signIns: ok([signIn("signed_out")]) })).toBe("todo");
    expect(profileState({ ...base, profiles: ok([codex]), signIns: ok([signIn("blocked")]) })).toBe("problem");
    expect(profileState({ ...base, profiles: ok([codex]), signIns: ok([signIn("signed_in")]) })).toBe("done");
  });
  it("reads a key on a runner that could also sign in as a key, as the daemon does", () => {
    // Codex and Gemini CLI may run on an API key; such a profile has no sign-in status row.
    const codexKey = profile({ runner: "codex", providerId: "openai", credentialId: "c1" });
    const openaiKey = cred({ providerId: "openai" });
    expect(profileState({ ...base, profiles: ok([codexKey]), credentials: ok([openaiKey]) })).toBe("done");
    expect(profileState({ ...base, profiles: ok([codexKey]), credentials: ok([openaiKey]), keyChecks: ok([check("invalid")]) })).toBe("problem");
    const geminiKey = profile({ runner: "gemini-cli", providerId: "google", credentialId: "c1" });
    expect(profileState({ ...base, profiles: ok([geminiKey]), credentials: ok([cred({ providerId: "google" })]), keyChecks: ok([check("invalid")]) })).toBe("problem");
  });
  it("is not yet done without profiles, and unknown when a read failed", () => {
    expect(profileState({ ...base, profiles: ok([]) })).toBe("todo");
    expect(profileState({ ...base, keyChecks: failed() })).toBe("unknown");
    expect(profileState({ ...base, signIns: pending() })).toBe("checking");
  });
});

const task = (status: TaskSummary["status"]): TaskSummary => ({ id: status, status }) as TaskSummary;

describe("tasks and GitHub", () => {
  it("tells a first task from a first approved crew", () => {
    const tasks = ok([task("proposed")]);
    const rows = guideChecklist({ ...{ profiles: ok([]), credentials: ok([]), keyChecks: ok([]), signIns: ok([]) }, tools: allTools(), projectOpen: true, tasks, github: pending() });
    expect(rows.find((r) => r.id === "firstTask")?.state).toBe("done");
    expect(rows.find((r) => r.id === "firstCrew")?.state).toBe("todo");
    expect(rows.find((r) => r.id === "project")?.state).toBe("done");
    expect(rows.map((r) => r.id)).toEqual(["machine", "profile", "project", "firstTask", "firstCrew", "github"]);
    expect(taskState(ok([task("cancelled")]), (t) => t.status === "review")).toBe("todo");
    expect(taskState(failed(), () => true)).toBe("unknown");
  });

  it("does not count a goal's hidden planning run or last review as a crew you approved", () => {
    const base = { profiles: ok([]), credentials: ok([]), keyChecks: ok([]), signIns: ok([]), tools: allTools(), projectOpen: true, github: pending() };
    const ref = (role: "planning" | "integration" | "task", hidden: boolean) => ({ goalId: "g1", key: role, number: 1, waiting: false, hold: null, joined: false, hidden, role });
    const planning = { ...task("done"), goal: ref("planning", true) } as TaskSummary;
    const review = { ...task("running"), goal: ref("integration", true) } as TaskSummary;
    let rows = guideChecklist({ ...base, tasks: ok([planning, review]) });
    expect(rows.find((r) => r.id === "firstTask")?.state).toBe("done");
    expect(rows.find((r) => r.id === "firstCrew")?.state).toBe("todo");
    const released = { ...task("running"), goal: ref("task", false) } as TaskSummary;
    rows = guideChecklist({ ...base, tasks: ok([planning, released]) });
    expect(rows.find((r) => r.id === "firstCrew")?.state).toBe("done");
  });
  it("reads GitHub through gh's own login", () => {
    const auth = (over: Partial<GithubAuth>): Read<GithubAuth> => ok({ signedIn: false, login: null, scopes: null, rate: [], problem: null, ...over });
    expect(githubState(auth({ signedIn: true, login: "me" }))).toBe("done");
    expect(githubState(auth({ problem: "no_gh" }))).toBe("problem");
    expect(githubState(auth({ problem: "signed_out" }))).toBe("todo");
    expect(githubState(auth({ problem: "offline" }))).toBe("unknown");
    expect(githubState(failed())).toBe("unknown");
  });
});

describe("releaseFacts", () => {
  const state = (over: Partial<UpdateState>): UpdateState => ({ phase: "off", off: "no_feed", current: "0.2.0", feed: null, signed: false, publisher: null, autoCheck: false, checkedAt: null, available: null, progress: null, verifiedBy: null, error: null, ...over });
  it("reads the running build instead of a release written into the text", () => {
    expect(releaseFacts(null)).toBeNull();
    expect(releaseFacts(state({}))).toEqual({ version: "0.2.0", signed: false, updates: { looks: false, why: "no_feed" } });
    expect(releaseFacts(state({ off: "development" }))?.updates).toEqual({ looks: false, why: "development" });
    expect(releaseFacts(state({ phase: "idle", off: null, signed: true, feed: "https://updates.example/win" }))).toEqual({ version: "0.2.0", signed: true, updates: { looks: true } });
  });
});
