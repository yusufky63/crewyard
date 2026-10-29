import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Headroom } from "@crewyard/core";
import { afterEach, describe, expect, it } from "vitest";
import { admit } from "./admission.ts";
import { classifyTask } from "./classify.ts";
import { proposeCrew, scoreCandidate, type ScoringContext } from "./crew.ts";
import { checkpoint, defaultWorktreeRoot, ensureWorktree, parseWorktreeList, taskSlug } from "./git.ts";
import { onlyDocPaths, planFor } from "./roles.ts";
import { CANDIDATES, candidate, cleanTemps, git, model, tempDir, tempRepo } from "./testing.ts";

afterEach(cleanTemps);

describe("classifyTask", () => {
  it("reads kind and size from English and Turkish keywords", () => {
    expect(classifyTask("Fix crash when the save file is empty", "")).toMatchObject({ kind: "code", size: "S" });
    expect(classifyTask("Refactor the whole input system", "")).toMatchObject({ kind: "code", size: "L" });
    expect(classifyTask("Research how other tools store API keys", "")).toMatchObject({ kind: "research" });
    expect(classifyTask("Add a FAQ page to the docs", "")).toMatchObject({ kind: "docs" });
    expect(classifyTask("Review PR 12", "")).toMatchObject({ kind: "review" });
    expect(classifyTask("Giriş ekranındaki hatayı düzelt", "")).toMatchObject({ kind: "code" });
    expect(classifyTask("Kimlik doğrulama kütüphanelerini araştır", "")).toMatchObject({ kind: "research" });
  });

  it("flags security and lets explicit values win", () => {
    const c = classifyTask("Audit the upload handler for injection", "");
    expect([c.kind, c.security]).toEqual(["review", true]);
    const e = classifyTask("Research things", "", { kind: "code", size: "L" });
    expect([e.kind, e.size]).toEqual(["code", "L"]);
    expect(e.reasons.map((r) => r.code)).toEqual(["classify.explicit", "classify.explicit"]);
  });
});

describe("planFor", () => {
  it("builds Plan -> Implement -> Test || Review for code M", () => {
    expect(planFor("code", "M", false).map((s) => [s.step, s.dependsOn])).toEqual([
      ["planner", []],
      ["implementer", ["planner"]],
      ["tester", ["implementer"]],
      ["reviewer", ["implementer"]],
    ]);
    expect(planFor("code", "L", false).map((s) => s.role)).toContain("security");
    expect(planFor("research", "S", false).map((s) => s.role)).toEqual(["researcher"]);
  });

  it("limits the Docs role to documentation paths", () => {
    expect(onlyDocPaths(["docs/guide.md", "README.md", "CHANGELOG"])).toBe(true);
    expect(onlyDocPaths(["src/app.ts"])).toBe(false);
    expect(onlyDocPaths([])).toBe(false);
  });
});

const ctx = (over: Partial<ScoringContext> = {}): ScoringContext => ({
  size: "M",
  budgetUsd: null,
  hasAdapter: () => true,
  headroom: (): Headroom => ({ pct: null, window: null, provenance: "unknown" }),
  history: () => ({ accepted: 0, total: 0 }),
  preference: () => 0,
  ...over,
});

describe("crew scoring", () => {
  it("keeps the reviewer off the implementer's model and prefers another provider", () => {
    const { members } = proposeCrew("code", false, CANDIDATES(), ctx());
    const impl = members.find((m) => m.role === "implementer")!.chosen!;
    const rev = members.find((m) => m.role === "reviewer")!;
    expect(rev.chosen!.model).not.toBe(impl.model);
    expect(rev.chosen!.providerId).not.toBe(impl.providerId);
    expect(rev.chosen!.reasons.map((r) => r.code)).toEqual(expect.arrayContaining(["independence.model", "independence.provider"]));
    expect(rev.standby.every((s) => s.model !== impl.model)).toBe(true);
  });

  it("prefers Reported headroom and drops a window under 20%", () => {
    const c = CANDIDATES()[0]!;
    const at = (pct: number, provenance: Headroom["provenance"]) => scoreCandidate(c, "implementer", ctx({ headroom: () => ({ pct, window: "5h", provenance }) }));
    expect(at(60, "reported").score).toBeGreaterThan(at(60, "estimated").score);
    expect(at(10, "reported").reasons.map((r) => r.code)).toContain("headroom.low");
  });

  it("adds Codex's per-turn system prompt overhead to its estimate", () => {
    const m = model("gpt-5", { cost: { input: 1, output: 10, cacheRead: 0.1 } });
    const plain = scoreCandidate(candidate("fake-key", "openai", m), "implementer", ctx()).estimate.usd!;
    const codex = { ...candidate("codex-key", "openai", m), profile: { ...candidate("codex-key", "openai", m).profile, runner: "codex" as const } };
    // M: 25 turns, implementer share 0.45 -> 11 turns x 14,800 tokens at $1 per million.
    expect(scoreCandidate(codex, "implementer", ctx()).estimate.usd! - plain).toBeCloseTo((11 * 14_800) / 1_000_000, 4);
  });

  it("labels plan profiles as costing nothing per token and unknown models as unknown", () => {
    expect(scoreCandidate(candidate("codex-plan", "openai", model("gpt-5"), "plan_signin"), "implementer", ctx()).estimate).toEqual({ usd: 0, provenance: "estimated" });
    expect(scoreCandidate(candidate("mystery", "x", null), "implementer", ctx()).estimate).toEqual({ usd: null, provenance: "unknown" });
  });

  it("learns from accepted runs and skips runners without an adapter or read-only support", () => {
    const [a, b] = CANDIDATES();
    const good = ctx({ history: (_r, role) => (role === "researcher" ? { accepted: 8, total: 8 } : { accepted: 0, total: 0 }) });
    expect(scoreCandidate(a!, "researcher", good).reasons).toContainEqual({ code: "history.accepted", params: { accepted: 8, total: 8 } });
    const noReadOnly = { ...b!, capabilities: { ...b!.capabilities, readOnlyMode: false } };
    const { members } = proposeCrew("research", false, [noReadOnly], ctx({ size: "S" }));
    expect(members[0]!.chosen).toBeNull();
    expect(proposeCrew("research", false, [a!], ctx({ size: "S", hasAdapter: () => false })).members[0]!.reasons[0]!.code).toBe("no_candidate");
  });
});

describe("admit", () => {
  const limits = { projectSlots: 2, perProfile: 1, globalSlots: 3, minFreeMb: 1024 };
  const load = { projectActive: 0, profileActive: 0, globalActive: 0, freeMb: 8_000, worktreeBusy: false, profileId: "p" };
  it("checks worktree, project, global, profile and memory in that order", () => {
    expect(admit(load, limits)).toBeNull();
    expect(admit({ ...load, worktreeBusy: true, projectActive: 9 }, limits)?.code).toBe("admission.worktree_busy");
    expect(admit({ ...load, projectActive: 2 }, limits)?.code).toBe("admission.project_slots");
    expect(admit({ ...load, globalActive: 3 }, limits)?.code).toBe("admission.global_slots");
    expect(admit({ ...load, profileActive: 1 }, limits)?.code).toBe("admission.profile_busy");
    expect(admit({ ...load, freeMb: 512 }, limits)).toEqual({ code: "admission.memory", params: { freeMb: 512, neededMb: 1024 } });
  });
});

describe("worktrees", () => {
  it("names tasks safely and places worktrees next to the projects folder", () => {
    expect(taskSlug("İçerik: Fix the *login* page!", "abcdef123")).toBe("icerik-fix-the-login-page-abcdef");
    expect(taskSlug("???", "123456789")).toBe("task-123456");
    expect(defaultWorktreeRoot(join("C:", "Projeler", "new-rts"))).toBe(join("C:", "Projeler", ".mc", "worktrees", "new-rts"));
  });

  it("creates a worktree on a new branch in a path with spaces, reuses it and checkpoints locally", async () => {
    const root = tempDir();
    const repo = await tempRepo(root, "my repo");
    const path = join(defaultWorktreeRoot(repo), "fix login-abc123");
    const wt = await ensureWorktree(repo, path, "crewyard/fix-login-abc123", null);
    expect(existsSync(join(path, "README.md"))).toBe(true);
    expect((await git(path, "rev-parse", "--abbrev-ref", "HEAD")).trim()).toBe("crewyard/fix-login-abc123");
    expect(await ensureWorktree(repo, path, wt.branch, null)).toEqual(wt);

    expect((await checkpoint(path, "wip: nothing")).committed).toBe(false);
    writeFileSync(join(path, "new file.txt"), "x\n");
    const cp = await checkpoint(path, "wip: handoff from r1");
    expect(cp.committed).toBe(true);
    expect((await git(path, "log", "-1", "--format=%s")).trim()).toBe("wip: handoff from r1");
    // Nothing reaches the main checkout's branch.
    expect((await git(repo, "log", "-1", "--format=%s")).trim()).toBe("init");
  });

  it("recovers a registered worktree whose folder is gone without touching anything else", async () => {
    const root = tempDir();
    const repo = await tempRepo(root);
    const path = join(defaultWorktreeRoot(repo), "task-1");
    const sibling = join(defaultWorktreeRoot(repo), "task-2");
    await ensureWorktree(repo, path, "crewyard/task-1", null);
    await ensureWorktree(repo, sibling, "crewyard/task-2", null);
    rmSync(path, { recursive: true, force: true });
    rmSync(sibling, { recursive: true, force: true });

    await ensureWorktree(repo, path, "crewyard/task-1", null);
    expect(existsSync(join(path, "README.md"))).toBe(true);
    // No repo-wide prune: the sibling's registration survives for its own recovery.
    expect(parseWorktreeList(await git(repo, "worktree", "list", "--porcelain", "-z")).map((r) => r.branch)).toContain("crewyard/task-2");
  });

  it("refuses a locked registration, a branch checked out elsewhere and a foreign folder", async () => {
    const root = tempDir();
    const repo = await tempRepo(root);
    const base = defaultWorktreeRoot(repo);
    await ensureWorktree(repo, join(base, "a"), "crewyard/a", null);
    await expect(ensureWorktree(repo, join(base, "b"), "crewyard/a", null)).rejects.toMatchObject({ code: "worktree.branch_elsewhere" });

    await git(repo, "worktree", "lock", join(base, "a"));
    rmSync(join(base, "a"), { recursive: true, force: true });
    await expect(ensureWorktree(repo, join(base, "a"), "crewyard/a", null)).rejects.toMatchObject({ code: "worktree.locked" });

    mkdirSync(join(base, "c"), { recursive: true });
    writeFileSync(join(base, "c", "notes.txt"), "mine\n");
    await expect(ensureWorktree(repo, join(base, "c"), "crewyard/c", null)).rejects.toMatchObject({ code: "worktree.path_taken" });
    expect(readFileSync(join(base, "c", "notes.txt"), "utf8")).toBe("mine\n");
  });

  it("parses porcelain output with spaces and locks", () => {
    const out = ["worktree C:/Projeler/my repo", "HEAD abc", "branch refs/heads/main", "", "worktree C:/Projeler/.mc/worktrees/my repo/t", "HEAD def", "branch refs/heads/crewyard/t", "locked moving", "", ""].join("\0");
    expect(parseWorktreeList(out)).toEqual([
      { path: "C:/Projeler/my repo", branch: "main", locked: false },
      { path: "C:/Projeler/.mc/worktrees/my repo/t", branch: "crewyard/t", locked: true },
    ]);
  });
});
