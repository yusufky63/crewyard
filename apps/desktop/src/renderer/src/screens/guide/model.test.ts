import { describe, expect, it } from "vitest";
import type { CredentialSummary, GithubAuth, KeyCheckView, ProfileSummary, SignInStatus, TaskSummary, ToolCheck, ToolId } from "@crewyard/core";
import { githubState, guideChecklist, machineState, profileState, taskState, type Read } from "./model.ts";

const ok = <T>(data: T): Read<T> => ({ data, pending: false, error: null });
const pending = <T>(): Read<T> => ({ data: undefined, pending: true, error: null });
const failed = <T>(): Read<T> => ({ data: undefined, pending: false, error: new Error("daemon.offline") });

const tool = (id: ToolId, found: boolean, gate: ToolCheck["gate"] = null): ToolCheck => ({ id, found, path: found ? `C:\\Program Files\\${id}\\${id}.exe` : null, version: found ? "1.0.0" : null, detail: null, gate });
const tooOld: ToolCheck["gate"] = { status: "outdated", verified: "2.0.0", rule: "min", update: "npm i -g x@latest" };
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
  it("is a problem when Git is missing or every installed agent is too old", () => {
    expect(machineState(allTools({ git: ok(tool("git", false)), codex: ok(tool("codex", true)) }))).toBe("problem");
    expect(machineState(allTools({ claude: ok(tool("claude", true, tooOld)) }))).toBe("problem");
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
  it("reads GitHub through gh's own login", () => {
    const auth = (over: Partial<GithubAuth>): Read<GithubAuth> => ok({ signedIn: false, login: null, scopes: null, rate: [], problem: null, ...over });
    expect(githubState(auth({ signedIn: true, login: "me" }))).toBe("done");
    expect(githubState(auth({ problem: "no_gh" }))).toBe("problem");
    expect(githubState(auth({ problem: "signed_out" }))).toBe("todo");
    expect(githubState(auth({ problem: "offline" }))).toBe("unknown");
    expect(githubState(failed())).toBe("unknown");
  });
});
