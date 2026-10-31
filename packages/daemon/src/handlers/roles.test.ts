import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultProjectConfig } from "@crewyard/core";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../store.ts";
import { createRolesHandlers } from "./roles.ts";

const temps: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  stores.splice(0).forEach((s) => s.close());
  temps.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "crewyard roles handler "));
  temps.push(dir);
  const dataDir = join(dir, "app data");
  const repo = join(dir, "my project");
  mkdirSync(join(repo, ".crewyard", "roles"), { recursive: true });
  const store = new Store(join(dir, "t.db"));
  stores.push(store);
  const project = store.addProject(repo, "my project");
  return { repo, dataDir, project, h: createRolesHandlers({ store, info: { startedAt: "now", dbPath: "t.db", dataDir }, emit: () => {} }) };
}

describe("roles.list", () => {
  it("lists the built-ins without a project, with the global folder", async () => {
    const { h, dataDir } = setup();
    const r = await h["roles.list"]({ projectId: null });
    expect(r.globalDir).toBe(join(dataDir, "roles"));
    expect(r.repoDir).toBeNull();
    expect(r.roles.map((x) => [x.id, x.source])).toEqual([
      ["planner", "builtin"],
      ["implementer", "builtin"],
      ["reviewer", "builtin"],
      ["tester", "builtin"],
      ["researcher", "builtin"],
      ["docs", "builtin"],
      ["security", "builtin"],
    ]);
  });

  it("shows a project's role files, where the template uses them, and every problem", async () => {
    const { h, repo, project } = setup();
    const roles = join(repo, ".crewyard", "roles");
    writeFileSync(join(roles, "perf.md"), "---\ntitle: Perf check\n---\nBenchmarks.\n");
    writeFileSync(join(roles, "security.md"), "---\npolicy:\n  network: allowed\n---\n");
    writeFileSync(join(repo, ".crewyard", "project.json"), JSON.stringify({ ...defaultProjectConfig("p", "D:\\wt"), customRoles: [{ role: "perf", kinds: ["code"], after: ["implementer"] }] }));
    const r = await h["roles.list"]({ projectId: project.id });
    expect(r.repoDir).toBe(roles);
    expect(r.roles.find((x) => x.id === "perf")).toMatchObject({ title: "Perf check", source: "repo", path: join(roles, "perf.md"), steps: [{ role: "perf", kinds: ["code"], after: ["implementer"] }] });
    expect(r.roles.find((x) => x.id === "security")).toMatchObject({ source: "builtin", path: null });
    expect(r.problems).toEqual([{ source: "repo", path: join(roles, "security.md"), role: "security", code: "widens", params: { field: "policy.network" } }]);
  });

  it("reports a customRoles list that project.json rejects", async () => {
    const { h, repo, project } = setup();
    writeFileSync(join(repo, ".crewyard", "project.json"), JSON.stringify({ ...defaultProjectConfig("p", "D:\\wt"), customRoles: [{ role: "perf", kinds: ["build"] }] }));
    const r = await h["roles.list"]({ projectId: project.id });
    expect(r.problems).toEqual([expect.objectContaining({ source: "project", code: "step_invalid" })]);
  });
});
