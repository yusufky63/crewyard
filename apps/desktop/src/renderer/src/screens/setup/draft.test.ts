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
    expect(draftProblems({ ...d, actionsWarnPct: "" }, detection())).toEqual([{ step: 6, problem: "warnPct" }]);
    expect(draftProblems({ ...d, path: null }, undefined)).toContainEqual({ step: 1, problem: "folder" });
    expect(draftProblems(d, { ...detection(), caseTwins: ["C:\\work\\App"] })).toEqual([{ step: 1, problem: "caseTwins" }]);
    expect(draftProblems(d, { ...detection(), caseTwins: [] })).toEqual([]);
  });

  it("suggests the lockfile's install as setup and builds the bootstrap block", () => {
    const node = detection({ type: { kind: "node", markers: ["package.json", "pnpm-lock.yaml"], packageManager: "pnpm", build: "pnpm build", test: "pnpm test" } });
    const d = seedFromDetection(blank(), node);
    expect(d.setup).toEqual([{ command: "pnpm install --frozen-lockfile", timeoutSec: "600" }]);
    const cfg = buildConfig({ ...d, cleanup: [{ command: "  ", timeoutSec: "600" }], include: [".env", "cache dir/"], portOn: true }, null);
    expect(cfg.bootstrap).toEqual({
      setup: [{ command: "pnpm install --frozen-lockfile", timeoutSec: 600 }],
      cleanup: [],
      include: [".env", "cache dir/"],
      includeMaxMb: 64,
      port: { from: 4100, to: 4999, envVar: "PORT" },
    });
    expect(ProjectConfig.parse(cfg)).toEqual(cfg);
    // An existing project.json keeps its own (empty) setup instead of the guess.
    const kept = seedFromDetection(blank(), detection({ ...node, existingConfig: defaultProjectConfig("x", "D:\\wt") }));
    expect(kept.setup).toEqual([]);
  });

  it("blocks create on shell syntax, bad timeouts, unsafe include paths and bad ports", () => {
    const d = seedFromDetection(blank(), detection());
    const bad = (patch: Partial<typeof d>) => draftProblems({ ...d, ...patch }, detection());
    expect(bad({ setup: [{ command: "pnpm i && pnpm build", timeoutSec: "600" }] })).toEqual([{ step: 5, problem: "bootstrap" }]);
    expect(bad({ cleanup: [{ command: "docker compose down", timeoutSec: "0" }] })).toEqual([{ step: 5, problem: "bootstrap" }]);
    expect(bad({ include: ["../secrets/.env"] })).toEqual([{ step: 5, problem: "bootstrap" }]);
    expect(bad({ portOn: true, portFrom: "5000", portTo: "4000" })).toEqual([{ step: 5, problem: "bootstrap" }]);
    expect(bad({ portOn: true, portEnvVar: "MY-PORT" })).toEqual([{ step: 5, problem: "bootstrap" }]);
    expect(bad({ setup: [{ command: "", timeoutSec: "" }] })).toEqual([]);
  });
});
