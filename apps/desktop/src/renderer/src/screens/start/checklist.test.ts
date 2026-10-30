import { describe, expect, it } from "vitest";
import type { AccountRow, CredentialSummary, ProfileSummary, TaskStatus, TaskSummary } from "@crewyard/core";
import { checklist, showChecklist, type ChecklistInput } from "./checklist.ts";

const profile = (id: string, runner: ProfileSummary["runner"], credentialId: string | null): ProfileSummary => ({
  id,
  alias: id,
  runner,
  providerId: runner === "claude-code" ? "anthropic" : "openai",
  credentialId,
  defaultModel: null,
  configDir: `C:\\Users\\A B\\AppData\\Roaming\\Crewyard\\profiles\\${id}`,
  createdAt: "2026-10-30T00:00:00Z",
  updatedAt: "2026-10-30T00:00:00Z",
});
const credential = (id: string, isSet: boolean): CredentialSummary => ({ id, alias: id, providerId: "anthropic", kind: "api_key", isSet, caps: { dailyUsd: null, taskUsd: null }, createdAt: "2026-10-30T00:00:00Z" });
const account = (kind: AccountRow["kind"]): AccountRow => ({ key: kind, label: kind, providerId: "openai", runner: "codex", kind, pct: null, value: { kind: "none" }, provenance: "unknown", window: null, resetsAt: null });
const task = (status: TaskStatus): TaskSummary => ({
  id: status,
  projectId: "p",
  title: status,
  kind: "code",
  size: "S",
  status,
  fallback: "ask",
  budgetUsd: null,
  spend: { usd: null, provenance: "unknown" },
  createdAt: "2026-10-30T00:00:00Z",
  cancelledAt: null,
  openRequests: 0,
  activeRuns: 0,
  resumableRunIds: [],
});

const empty: ChecklistInput = { agents: {}, accounts: undefined, profiles: undefined, credentials: undefined, githubSignedIn: undefined, tasks: undefined };
const done = (input: Partial<ChecklistInput>) => Object.fromEntries(checklist({ ...empty, ...input }).map((i) => [i.id, i.done]));

describe("checklist", () => {
  it("knows nothing before the reads answer", () => {
    expect(done({})).toEqual({ agents: null, plan: null, github: null, claudeKey: null, firstTask: null });
  });

  it("checks agents as soon as one agent CLI is found, and fails only when all four were checked", () => {
    expect(done({ agents: { codex: { found: true } } }).agents).toBe(true);
    expect(done({ agents: { claude: { found: false }, codex: { found: false } } }).agents).toBeNull();
    expect(done({ agents: { claude: { found: false }, codex: { found: false }, opencode: { found: false }, gemini: { found: false } } }).agents).toBe(false);
  });

  it("counts a plan account, not an API key account", () => {
    expect(done({ accounts: [account("api_key")] }).plan).toBe(false);
    expect(done({ accounts: [account("api_key"), account("plan")] }).plan).toBe(true);
  });

  it("takes GitHub from the gh sign-in", () => {
    expect(done({ githubSignedIn: false }).github).toBe(false);
    expect(done({ githubSignedIn: true }).github).toBe(true);
  });

  it("needs a Claude Code profile whose API key is actually stored", () => {
    expect(done({ profiles: [profile("c", "claude-code", "k")], credentials: [credential("k", false)] }).claudeKey).toBe(false);
    expect(done({ profiles: [profile("x", "codex", "k")], credentials: [credential("k", true)] }).claudeKey).toBe(false);
    expect(done({ profiles: [profile("c", "claude-code", null)], credentials: [] }).claudeKey).toBe(false);
    expect(done({ profiles: [profile("c", "claude-code", "k")], credentials: [credential("k", true)] }).claudeKey).toBe(true);
  });

  it("checks the first task once a crew was approved and started, not for a draft or a cancelled draft", () => {
    expect(done({ tasks: [] }).firstTask).toBe(false);
    expect(done({ tasks: [task("proposed"), task("cancelled")] }).firstTask).toBe(false);
    expect(done({ tasks: [task("running")] }).firstTask).toBe(true);
  });
});

describe("showChecklist", () => {
  it("stays until a task finishes", () => {
    expect(showChecklist(undefined)).toBe(true);
    expect(showChecklist([task("running"), task("failed")])).toBe(true);
    expect(showChecklist([task("review")])).toBe(false);
    expect(showChecklist([task("done")])).toBe(false);
  });
});
