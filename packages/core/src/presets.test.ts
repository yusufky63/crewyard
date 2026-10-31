import { describe, expect, it } from "vitest";
import { presetById, suggestPresets, TASK_PRESETS, type ProjectFacts } from "./presets.ts";

const facts = (over: Partial<ProjectFacts> = {}): ProjectFacts => ({ projectType: "node", testCommand: "pnpm test", hasDependencies: false, recentCommits: 2, hasRemote: false, ...over });

describe("task presets", () => {
  it("are research tasks whose contract asks for findings and changes nothing", () => {
    expect(TASK_PRESETS.map((p) => p.id)).toEqual(["review", "optimize", "bugs", "security", "deps", "tests"]);
    for (const p of TASK_PRESETS) {
      expect(p.kind).toBe("research");
      expect(p.description).toContain("do not change any file");
      expect(p.description).toContain("severity");
    }
    expect(presetById("security")?.title).toBe("Find security issues");
    expect(presetById("deploy")).toBeUndefined();
  });

  it("suggests what fits the project from local facts, most useful first, three at most", () => {
    expect(suggestPresets(facts({ testCommand: null, hasDependencies: true, recentCommits: 24, hasRemote: true }))).toEqual([
      { id: "tests", reason: "no_test_command" },
      { id: "review", reason: "recent_activity", count: 24 },
      { id: "deps", reason: "dependencies" },
    ]);
    expect(suggestPresets(facts({ hasRemote: true }))).toEqual([
      { id: "security", reason: "remote" },
      { id: "review", reason: "general" },
      { id: "bugs", reason: "general" },
    ]);
    // Nothing known still gives general picks, never an empty list.
    expect(suggestPresets(facts({ projectType: null, recentCommits: null })).map((s) => s.id)).toEqual(["review", "bugs", "security"]);
  });
});
