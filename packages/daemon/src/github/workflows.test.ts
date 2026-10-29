import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkWorkflows, matchesFilter, parseWorkflow, runnerLabels, triggeredBy, type WorkflowFile } from "./workflows.ts";

const dir = join(import.meta.dirname, "fixtures");
const fixture = (name: string): WorkflowFile => ({ file: `.github/workflows/${name}`, text: readFileSync(join(dir, name), "utf8") });
const all = readdirSync(dir).sort().map(fixture);

const rulesFor = (name: string, opts: { private: boolean | null; defaultBranch: string | null } = { private: true, defaultBranch: "main" }) =>
  checkWorkflows([fixture(name)], opts).findings.map((f) => [f.rule, f.severity, f.job, f.detail]);

describe("branch filters", () => {
  it("follows GitHub's glob rules", () => {
    expect(matchesFilter(["main"], "main")).toBe(true);
    expect(matchesFilter(["feature/*"], "feature/a")).toBe(true);
    expect(matchesFilter(["feature/*"], "feature/a/b")).toBe(false);
    expect(matchesFilter(["feature/**"], "feature/a/b")).toBe(true);
    expect(matchesFilter(["**", "!agent/**"], "agent/x")).toBe(false);
    expect(matchesFilter(["**", "!agent/**", "agent/keep"], "agent/keep")).toBe(true);
    expect(matchesFilter(["v[12].*"], "v2.0")).toBe(true);
    expect(matchesFilter(["release.1"], "releasex1")).toBe(false);
  });

  it("reads the on: key in every spelling", () => {
    const w = parseWorkflow({ file: "a.yml", text: "on: push\njobs: {}" });
    expect("error" in w ? null : Object.keys(w.on)).toEqual(["push"]);
  });
});

describe("push triggers", () => {
  it("lists only workflows a branch push starts", () => {
    const hits = triggeredBy(all, "agent/terrain-seams", null);
    // good.yml, matrix.yml and release.yml filter push to main, release/** and tags; schedule.yml has no push.
    expect(hits.map((h) => h.file)).toEqual([".github/workflows/push-all.yml", ".github/workflows/reusable-caller.yaml"]);
    expect(hits.find((h) => h.file.endsWith("push-all.yml"))?.costlyRunners).toEqual(["build: windows-latest"]);
  });

  it("adds pull_request runs when the branch has an open PR", () => {
    const hits = triggeredBy(all, "agent/terrain-seams", "main");
    const good = hits.find((h) => h.file.endsWith("good.yml"));
    expect(good?.events).toEqual(["pull_request"]);
    expect(good?.conditional).toBe(false);
    // matrix.yml only runs for PRs that touch src/**.
    expect(hits.find((h) => h.file.endsWith("matrix.yml"))?.conditional).toBe(true);
  });

  it("starts push workflows for main and release branches", () => {
    expect(triggeredBy(all, "main", null).map((h) => h.name)).toEqual(["ci", "matrix", "build everything", "caller"]);
    expect(triggeredBy(all, "release/1.2", null).map((h) => h.name)).toContain("matrix");
  });

  it("ignores branches listed in branches-ignore", () => {
    expect(triggeredBy([fixture("reusable-caller.yaml")], "dependabot/npm/x", null)).toEqual([]);
  });

  it("expands matrix runner labels", () => {
    const w = parseWorkflow(fixture("matrix.yml"));
    if ("error" in w) throw new Error(w.error);
    expect(runnerLabels((w.doc.jobs as Record<string, Record<string, unknown>>).test!)).toEqual(["ubuntu-latest", "macos-14", "windows-2025"]);
  });
});

describe("workflow check", () => {
  it("passes a workflow that follows the CI rules", () => {
    expect(rulesFor("good.yml")).toEqual([]);
    expect(rulesFor("release.yml")).toEqual([]);
  });

  it("flags push on every branch, missing concurrency, missing timeout and Windows on push", () => {
    expect(rulesFor("push-all.yml")).toEqual([
      ["push_all_branches", "error", null, null],
      ["no_concurrency", "error", null, null],
      ["costly_runner_on_push", "error", "build", "windows-latest"],
      ["no_timeout", "error", "build", null],
    ]);
  });

  it("flags extra push branches, concurrency without cancel and macOS/Windows in a matrix", () => {
    expect(rulesFor("matrix.yml")).toEqual([
      ["push_all_branches", "warning", null, "release/**"],
      ["no_cancel_in_progress", "error", null, null],
      ["costly_runner_on_push", "error", "test", "macos-14"],
      ["costly_runner_on_push", "error", "test", "windows-2025"],
    ]);
  });

  it("flags branches-ignore as push on all branches and skips timeouts on reusable calls", () => {
    expect(rulesFor("reusable-caller.yaml")).toEqual([["push_all_branches", "error", null, "branches-ignore"]]);
  });

  it("flags schedule by repo visibility", () => {
    expect(rulesFor("schedule.yml", { private: true, defaultBranch: "main" })).toEqual([["schedule_private", "error", null, null]]);
    expect(rulesFor("schedule.yml", { private: null, defaultBranch: "main" })).toEqual([["schedule_private", "warning", null, null]]);
    expect(rulesFor("schedule.yml", { private: false, defaultBranch: "main" })).toEqual([]);
  });

  it("reports a file that is not valid YAML", () => {
    const [f] = checkWorkflows([fixture("broken.yml")], { private: true, defaultBranch: "main" }).findings;
    expect(f?.rule).toBe("parse_error");
    expect(f?.detail).toBeTruthy();
  });

  it("checks the repo's own CI workflow clean", () => {
    const text = readFileSync(join(import.meta.dirname, "../../../../.github/workflows/ci.yml"), "utf8");
    expect(checkWorkflows([{ file: "ci.yml", text }], { private: true, defaultBranch: "main" }).findings).toEqual([]);
  });
});
