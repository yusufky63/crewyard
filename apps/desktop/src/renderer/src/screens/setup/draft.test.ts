import { describe, expect, it } from "vitest";
import { defaultProjectConfig, ProjectConfig, type FolderDetection } from "@crewyard/core";
import { buildConfig, draftProblems, seedFromDetection, useDraft } from "./draft.ts";

const detection = (patch: Partial<FolderDetection> = {}): FolderDetection => ({
  path: "C:\\Projeler\\new rts",
  name: "new rts",
  exists: true,
  empty: false,
  alreadyAdded: false,
  git: { available: true, isRepo: true, parentRepo: null, branch: "main", commits: 2, clean: true, remoteUrl: null, githubRepo: null, error: null },
  type: { kind: "godot-csharp", markers: ["project.godot", "NewRts.csproj"], packageManager: null, build: "dotnet build", test: "dotnet test" },
  worktreeRoot: "C:\\Projeler\\.mc\\worktrees\\new rts",
  pathCheck: { longest: 118, longestRelative: "x", limit: 260, ok: true, truncated: false, filesSeen: 10 },
  longPathsEnabled: false,
  existingConfig: null,
  workflows: [],
  ...patch,
});

const blank = () => {
  useDraft.getState().reset();
  return { ...useDraft.getState(), path: "C:\\Projeler\\new rts" };
};

describe("setup draft", () => {
  it("seeds commands and allowlist from detection and builds a valid config", () => {
    const d = seedFromDetection(blank(), detection());
    expect(d).toMatchObject({ name: "new rts", build: "dotnet build", test: "dotnet test", gitInit: false });
    expect(d.allowCommands).toEqual(["dotnet build", "dotnet test", "git status", "git diff"]);
    expect(draftProblems(d, detection())).toEqual([]);
    const cfg = buildConfig(d, "https://github.com/a/b.git");
    expect(ProjectConfig.parse(cfg)).toEqual(cfg);
    expect(cfg.github).toEqual({ remote: "https://github.com/a/b.git", pushNeedsApproval: true, actionsWarnPct: 80 });
    expect(cfg.profiles).toEqual([]);
  });

  it("prefers an existing project.json over guesses", () => {
    const existing = { ...defaultProjectConfig("Kept name", "D:\\wt"), commands: { build: "make", test: null } };
    const d = seedFromDetection(blank(), detection({ existingConfig: existing }));
    expect(d).toMatchObject({ name: "Kept name", build: "make", test: "", worktreeRoot: "D:\\wt" });
  });

  it("offers git init for empty folders and blocks create without git", () => {
    const empty = detection({ empty: true, git: { ...detection().git, isRepo: false, branch: null, commits: 0 } });
    const d = seedFromDetection({ ...blank(), source: "empty" }, empty);
    expect(d.gitInit).toBe(true);
    expect(draftProblems({ ...d, gitInit: false }, empty)).toContainEqual({ step: 1, problem: "git" });
  });

  it("reports bad numbers by step", () => {
    const d = seedFromDetection(blank(), detection());
    expect(draftProblems({ ...d, dailyUsd: "-1" }, detection())).toEqual([{ step: 3, problem: "budget" }]);
    expect(draftProblems({ ...d, slots: "2.5" }, detection())).toEqual([{ step: 4, problem: "slots" }]);
    expect(draftProblems({ ...d, actionsWarnPct: "" }, detection())).toEqual([{ step: 5, problem: "warnPct" }]);
    expect(draftProblems({ ...d, path: null }, undefined)).toContainEqual({ step: 1, problem: "folder" });
  });
});
