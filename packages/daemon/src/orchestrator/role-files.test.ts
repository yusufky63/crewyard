import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Headroom } from "@crewyard/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { proposeCrew, type ScoringContext } from "./crew.ts";
import { checkCustomRoles, globalRolesDir, loadRoleSet, parseRoleFile, projectRoles, repoRolesDir, ROLE_LIMITS, roleViews } from "./role-files.ts";
import { customPlanSteps, effectivePolicy, GOAL_PLANNER, planFor, ROLES, type RoleTemplate } from "./roles.ts";
import { CANDIDATES } from "./testing.ts";

// Role files (PLAN.md §9.1): parsing, override rules, fail-closed cases, caps and layering.

const file = (front: string, body = "Findings with numbers. Do not change any file.") => `---\n${front}\n---\n${body}\n`;
const template = (r: ReturnType<typeof parseRoleFile>): RoleTemplate => {
  if ("problem" in r) throw new Error(`unexpected problem ${r.problem.code}`);
  return r.template;
};
const problem = (r: ReturnType<typeof parseRoleFile>) => ("problem" in r ? r.problem : null);

describe("parseRoleFile", () => {
  it("reads a new role from front matter and takes the body as its contract", () => {
    const t = template(
      parseRoleFile(
        "perf-check",
        file("title: Performance check\npolicy:\n  writes: none\n  allowCommands: [pnpm bench]\n  network: denied\nprefersReasoning: true\nindependentOf: [implementer]\ntokenShare: 0.1"),
      ),
    );
    expect(t).toEqual({
      id: "perf-check",
      title: "Performance check",
      policy: { writes: "none", allowCommands: ["pnpm bench"], network: "denied" },
      writesCode: false,
      needsReadOnly: true,
      prefersReasoning: true,
      tokenShare: 0.1,
      independentOf: ["implementer"],
      contract: "Findings with numbers. Do not change any file.",
    });
  });

  it("starts a new role from nothing: read-only, no commands, no network", () => {
    const t = template(parseRoleFile("notes", file("title: Notes")));
    expect(t.policy).toEqual({ writes: "none", allowCommands: [], network: "denied" });
    expect(t.needsReadOnly).toBe(true);
    expect(t.writesCode).toBe(false);
  });

  it("accepts CRLF line ends and a byte order mark", () => {
    const t = template(parseRoleFile("notes", "\uFEFF---\r\ntitle: Notes\r\n---\r\nA report.\r\n"));
    expect(t.contract).toBe("A report.");
  });

  it("refuses what it does not understand, field by field", () => {
    expect(problem(parseRoleFile("x", "no front matter"))).toEqual({ code: "front_matter" });
    expect(problem(parseRoleFile("x", "---\ntitle: X\nnever closed"))).toEqual({ code: "front_matter" });
    expect(problem(parseRoleFile("x", file("title: [unclosed")))?.code).toBe("yaml");
    expect(problem(parseRoleFile("x", file("- a list")))).toEqual({ code: "not_mapping" });
    expect(problem(parseRoleFile("x", file("title: X\nmodel: gpt")))).toEqual({ code: "unknown_field", params: { field: "model" } });
    expect(problem(parseRoleFile("x", file("title: X\npolicy:\n  sandbox: off")))).toEqual({ code: "unknown_field", params: { field: "policy.sandbox" } });
    expect(problem(parseRoleFile("x", file("title: X\npolicy:\n  writes: everything")))).toEqual({ code: "invalid_field", params: { field: "policy.writes" } });
    expect(problem(parseRoleFile("x", file("title: X\npolicy:\n  network: yes")))).toEqual({ code: "invalid_field", params: { field: "policy.network" } });
    expect(problem(parseRoleFile("x", file("title: X\npolicy:\n  allowCommands: pnpm test")))).toEqual({ code: "invalid_field", params: { field: "policy.allowCommands" } });
    expect(problem(parseRoleFile("x", file("title: X\ntokenShare: 2")))).toEqual({ code: "invalid_field", params: { field: "tokenShare" } });
    expect(problem(parseRoleFile("x", file("title: X\nneedsReadOnly: \"no\"")))).toEqual({ code: "invalid_field", params: { field: "needsReadOnly" } });
    expect(problem(parseRoleFile("x", file("title: X\nindependentOf: [x]")))).toEqual({ code: "invalid_field", params: { field: "independentOf" } });
    expect(problem(parseRoleFile("x", file("title: 42")))).toEqual({ code: "invalid_field", params: { field: "title" } });
    expect(problem(parseRoleFile("x", file("prefersReasoning: true")))).toEqual({ code: "no_title" });
    expect(problem(parseRoleFile("x", file("title: X", "")))).toEqual({ code: "contract_empty" });
  });

  it("never loads code from YAML tags", () => {
    const evil = file('title: X\npolicy: !!js/function "function () { return process.exit(1) }"');
    expect(problem(parseRoleFile("x", evil))?.code).toBe("yaml");
  });

  it("refuses a role that writes nothing on a runner without read-only enforcement", () => {
    expect(problem(parseRoleFile("x", file("title: X\nneedsReadOnly: false")))).toEqual({ code: "needs_read_only" });
    expect(template(parseRoleFile("x", file("title: X\npolicy:\n  writes: worktree\nneedsReadOnly: false"))).needsReadOnly).toBe(false);
  });

  it("caps the contract, which goes into every prompt of the role", () => {
    const long = "a".repeat(ROLE_LIMITS.contractChars + 1);
    expect(problem(parseRoleFile("x", file("title: X", long)))).toEqual({ code: "contract_too_long", params: { limit: ROLE_LIMITS.contractChars } });
    expect(template(parseRoleFile("x", file("title: X", "a".repeat(ROLE_LIMITS.contractChars)))).contract).toHaveLength(ROLE_LIMITS.contractChars);
  });

  it("drops control characters from the contract", () => {
    expect(template(parseRoleFile("x", file("title: X", "Report\u0007 this.\u001b[2J"))).contract).toBe("Report this.[2J");
  });
});

describe("overriding a role", () => {
  it("lets a file change a built-in's contract and title and keeps the rest", () => {
    const t = template(parseRoleFile("reviewer", file("title: Strict reviewer", "A verdict with comments citing our style guide."), ROLES.reviewer));
    expect(t.contract).toBe("A verdict with comments citing our style guide.");
    expect(t.title).toBe("Strict reviewer");
    expect(t.policy).toEqual(ROLES.reviewer.policy);
    expect(t.independentOf).toEqual(["implementer"]);
    expect(t.needsReadOnly).toBe(true);
  });

  it("keeps the built-in's contract when the body is empty", () => {
    expect(template(parseRoleFile("planner", file("tokenShare: 0.3", ""), ROLES.planner)).contract).toBe(ROLES.planner.contract);
  });

  it.each([
    ["planner", "policy:\n  writes: worktree", "policy.writes"],
    ["reviewer", "policy:\n  network: allowed", "policy.network"],
    ["researcher", "policy:\n  allowCommands: [curl]", "policy.allowCommands"],
    ["security", "policy:\n  writes: docs", "policy.writes"],
    ["docs", "policy:\n  writes: worktree", "policy.writes"],
    ["reviewer", "independentOf: []", "independentOf"],
    ["implementer", "policy:\n  network: allowed", "policy.network"],
  ] as const)("refuses an override of %s that widens %s", (id, front, field) => {
    expect(problem(parseRoleFile(id, file(front), ROLES[id]))).toEqual({ code: "widens", params: { field } });
  });

  it("lets an override narrow", () => {
    const t = template(parseRoleFile("researcher", file("policy:\n  network: ask"), ROLES.researcher));
    expect(t.policy.network).toBe("ask");
    const impl = template(parseRoleFile("implementer", file("policy:\n  network: denied\nindependentOf: [planner]"), ROLES.implementer));
    expect(impl.policy).toEqual({ writes: "worktree", allowCommands: [], network: "denied" });
    expect(impl.independentOf).toEqual(["planner"]);
  });
});

describe("loadRoleSet", () => {
  let root: string;
  let globalDir: string;
  let repo: string;
  beforeEach(() => {
    // Spaces in every path (AGENTS.md, Windows).
    root = mkdtempSync(join(tmpdir(), "crewyard roles "));
    globalDir = join(root, "app data", "roles");
    repo = join(root, "my repo");
    mkdirSync(globalDir, { recursive: true });
    mkdirSync(repoRolesDir(repo), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("starts from the seven built-ins when no folder exists", () => {
    const set = loadRoleSet({ globalDir: join(root, "missing"), repoDir: join(root, "missing too") });
    expect([...set.roles.keys()]).toEqual(["planner", "implementer", "reviewer", "tester", "researcher", "docs", "security"]);
    expect(set.problems).toEqual([]);
  });

  it("layers built-in, global and repo files, each override checked against the one below", () => {
    writeFileSync(join(globalDir, "reviewer.md"), file("title: House reviewer\npolicy:\n  network: denied"));
    writeFileSync(join(globalDir, "perf-check.md"), file("title: Perf\npolicy:\n  allowCommands: [pnpm bench, pnpm test]"));
    writeFileSync(join(repoRolesDir(repo), "reviewer.md"), file("title: Repo reviewer", "Repo contract."));
    // Narrower than the global role it replaces: fine. Wider: refused, the global one stays.
    writeFileSync(join(repoRolesDir(repo), "perf-check.md"), file("policy:\n  allowCommands: [pnpm bench, curl evil]"));
    const set = loadRoleSet({ globalDir, repoDir: repoRolesDir(repo) });
    const reviewer = set.roles.get("reviewer")!;
    expect(reviewer).toMatchObject({ source: "repo", overrides: "global", path: join(repoRolesDir(repo), "reviewer.md") });
    expect(reviewer.template.contract).toBe("Repo contract.");
    const perf = set.roles.get("perf-check")!;
    expect(perf.source).toBe("global");
    expect(perf.template.policy.allowCommands).toEqual(["pnpm bench", "pnpm test"]);
    expect(set.problems).toEqual([{ source: "repo", path: join(repoRolesDir(repo), "perf-check.md"), role: "perf-check", code: "widens", params: { field: "policy.allowCommands" } }]);
  });

  it("keeps the built-in when its override is invalid", () => {
    writeFileSync(join(repoRolesDir(repo), "planner.md"), file("title: Planner\npolicy:\n  writes: worktree"));
    const set = loadRoleSet({ globalDir, repoDir: repoRolesDir(repo) });
    expect(set.roles.get("planner")).toMatchObject({ source: "builtin", template: ROLES.planner });
    expect(set.problems.map((p) => p.code)).toEqual(["widens"]);
  });

  it("refuses file names that are not role ids and files over the size cap", () => {
    writeFileSync(join(repoRolesDir(repo), "Perf Check.md"), file("title: X"));
    writeFileSync(join(repoRolesDir(repo), "big.md"), file("title: Big", "b".repeat(ROLE_LIMITS.fileBytes)));
    writeFileSync(join(repoRolesDir(repo), "notes.txt"), "not a role");
    const set = loadRoleSet({ globalDir, repoDir: repoRolesDir(repo) });
    expect(set.problems.map((p) => [p.code, p.role])).toEqual([
      ["too_large", "big"],
      ["bad_name", null],
    ]);
    expect(set.roles.has("big")).toBe(false);
  });

  it("refuses a role file named after the Orchestra planner, in either folder, and keeps it out of the set", () => {
    // A file could otherwise widen what the planner may do or make it a crew role (docs/adr/0019).
    writeFileSync(join(globalDir, "goal-planner.md"), file("title: My planner\npolicy:\n  network: allowed"));
    writeFileSync(join(repoRolesDir(repo), "goal-planner.md"), file("title: Repo planner"));
    const set = loadRoleSet({ globalDir, repoDir: repoRolesDir(repo) });
    expect(set.roles.has(GOAL_PLANNER.id)).toBe(false);
    expect(set.problems).toEqual([
      { source: "global", path: join(globalDir, "goal-planner.md"), role: "goal-planner", code: "reserved", params: {} },
      { source: "repo", path: join(repoRolesDir(repo), "goal-planner.md"), role: "goal-planner", code: "reserved", params: {} },
    ]);
  });

  it("reads at most the first files of a folder, in name order", () => {
    for (let i = 0; i < ROLE_LIMITS.files + 2; i++) writeFileSync(join(globalDir, `r${String(i).padStart(2, "0")}.md`), file(`title: R${i}`));
    const set = loadRoleSet({ globalDir, repoDir: null });
    expect(set.problems).toEqual([{ source: "global", path: globalDir, role: null, code: "too_many", params: { limit: ROLE_LIMITS.files } }]);
    expect(set.roles.has("r31")).toBe(true);
    expect(set.roles.has("r32")).toBe(false);
  });
});

describe("the project's rules over a role's policy", () => {
  const config = { commands: { build: "pnpm build", test: "pnpm test" }, rules: { fallback: "ask" as const, slots: 4, allowCommands: ["git status"], network: "ask" as const, toastApprovals: "low" as const } };

  it("gives a custom role only the commands it lists that the project also allows", () => {
    const t = template(parseRoleFile("perf", file("title: Perf\npolicy:\n  allowCommands: [pnpm test, rm -rf /, git status]\n  network: allowed")));
    expect(effectivePolicy(t, config)).toEqual({ writes: "none", allowCommands: ["pnpm test", "git status"], network: "ask" });
    expect(effectivePolicy(t, { ...config, rules: { ...config.rules, network: "allowed" } }).network).toBe("allowed");
  });

  it("never raises a custom role's network to the project's", () => {
    const t = template(parseRoleFile("perf", file("title: Perf\npolicy:\n  network: ask")));
    expect(effectivePolicy(t, { ...config, rules: { ...config.rules, network: "allowed" } }).network).toBe("ask");
  });

  it("keeps the built-in rules for built-ins and their overrides", () => {
    expect(effectivePolicy(ROLES.tester, config)).toEqual({ writes: "none", allowCommands: ["git status", "pnpm build", "pnpm test"], network: "denied" });
    expect(effectivePolicy(ROLES.planner, config).allowCommands).toEqual(["git status"]);
  });
});

describe("custom roles in the crew templates", () => {
  it("validates the customRoles list of project.json as a whole", () => {
    const ok = checkCustomRoles([{ role: "perf", kinds: ["code"], after: ["implementer"] }], "p.json");
    expect(ok).toEqual({ steps: [{ role: "perf", kinds: ["code"], after: ["implementer"] }], problems: [] });
    expect(checkCustomRoles([{ role: "reviewer", kinds: ["code"] }], "p.json").problems[0]).toMatchObject({ code: "step_invalid", params: { detail: expect.stringContaining("customRoles[0].role") } });
    expect(checkCustomRoles([{ role: "perf", kinds: ["code"], extra: 1 }], "p.json").steps).toEqual([]);
    expect(checkCustomRoles("perf", "p.json").problems[0]?.code).toBe("step_invalid");
  });

  it("adds a step only for its kinds and sizes, after steps the template has", () => {
    const plan = planFor("code", "M", false);
    const steps = [
      { role: "perf", kinds: ["code" as const], after: ["implementer"] },
      { role: "a11y", kinds: ["code" as const], sizes: ["L" as const], after: [] },
      { role: "after-research", kinds: ["code" as const], after: ["researcher"] },
      { role: "chain", kinds: ["code" as const], after: ["perf"] },
    ];
    expect(customPlanSteps(plan, steps, "code", "M")).toEqual([
      { step: "perf", role: "perf", dependsOn: ["implementer"], required: true },
      { step: "chain", role: "chain", dependsOn: ["perf"], required: true },
    ]);
    expect(customPlanSteps(plan, steps, "docs", "M")).toEqual([]);
  });

  describe("in a proposal", () => {
    let root: string;
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "crewyard crew roles "));
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    const ctx: ScoringContext = {
      size: "M",
      budgetUsd: null,
      hasAdapter: () => true,
      headroom: (): Headroom => ({ pct: null, window: null, provenance: "unknown" }),
      history: () => ({ accepted: 0, total: 0 }),
      preference: () => 0,
    };

    it("uses built-ins only until the project lists a custom role", () => {
      const repo = join(root, "the repo");
      mkdirSync(repoRolesDir(repo), { recursive: true });
      writeFileSync(join(repoRolesDir(repo), "perf.md"), file("title: Perf\nindependentOf: [implementer]"));
      const dataDir = join(root, "data dir");
      const plain = projectRoles(dataDir, repo, { customRoles: undefined }, "p.json");
      const templates = (p: typeof plain) => new Map([...p.set.roles].map(([id, r]) => [id, r.template]));
      expect(proposeCrew("code", false, CANDIDATES(), ctx, { templates: templates(plain), steps: plain.steps }).members.map((m) => m.role)).toEqual(["planner", "implementer", "tester", "reviewer"]);

      const listed = projectRoles(dataDir, repo, { customRoles: [{ role: "perf", kinds: ["code"], after: ["implementer"] }] }, "p.json");
      const crew = proposeCrew("code", false, CANDIDATES(), ctx, { templates: templates(listed), steps: listed.steps });
      const perf = crew.members.find((m) => m.role === "perf")!;
      expect(perf).toMatchObject({ step: "perf", dependsOn: ["implementer"], writesCode: false });
      expect(perf.template.title).toBe("Perf");
      // Its independentOf keeps it off the implementer's model, like a reviewer.
      const impl = crew.members.find((m) => m.role === "implementer")!;
      expect(perf.chosen?.model).not.toBe(impl.chosen?.model);
      expect(roleViews(listed).find((r) => r.id === "perf")).toMatchObject({ source: "repo", builtin: false, steps: [{ role: "perf" }] });
    });

    it("reports a listed role that has no usable file and leaves it out", () => {
      const repo = join(root, "other repo");
      const listed = projectRoles(join(root, "data"), repo, { customRoles: [{ role: "ghost", kinds: ["code"], after: [] }] }, "p.json");
      expect(listed.steps).toEqual([]);
      expect(listed.set.problems).toEqual([{ source: "project", path: "p.json", role: "ghost", code: "step_unknown_role", params: { role: "ghost" } }]);
    });

    it("reads global roles from the data folder", () => {
      const dataDir = join(root, "data dir");
      mkdirSync(globalRolesDir(dataDir), { recursive: true });
      writeFileSync(join(globalRolesDir(dataDir), "tester.md"), file("title: Tester", "Results with the machine they ran on."));
      expect(projectRoles(dataDir, null, null, null).set.roles.get("tester")).toMatchObject({ source: "global", overrides: "builtin" });
    });
  });
});
