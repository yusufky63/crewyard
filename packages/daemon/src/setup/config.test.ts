import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultProjectConfig, ProjectConfig } from "@crewyard/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_REL, writeProjectConfig } from "./config.ts";

// customRoles (PLAN.md §9.1) has no field in the wizard, so a wizard save must not erase it.

describe("customRoles in project.json", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "crewyard config roles "));
    mkdirSync(join(repo, ".crewyard"));
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const onDisk = () => JSON.parse(readFileSync(join(repo, CONFIG_REL), "utf8")) as Record<string, unknown>;

  it("keeps the list on disk when the wizard saves without it", async () => {
    const steps = [{ role: "perf", kinds: ["code"], after: ["implementer"] }];
    writeFileSync(join(repo, CONFIG_REL), JSON.stringify({ ...defaultProjectConfig("app", "D:\\wt"), customRoles: steps }));
    const { config } = await writeProjectConfig(repo, { ...defaultProjectConfig("renamed", "D:\\wt") });
    expect(onDisk().customRoles).toEqual(steps);
    expect(onDisk().name).toBe("renamed");
    expect(config.customRoles).toEqual(steps);
  });

  it("keeps even a list that does not validate, for the user to fix", async () => {
    const bad = [{ role: "reviewer", kinds: ["code"] }];
    writeFileSync(join(repo, CONFIG_REL), JSON.stringify({ ...defaultProjectConfig("app", "D:\\wt"), customRoles: bad }));
    const { config } = await writeProjectConfig(repo, defaultProjectConfig("app", "D:\\wt"));
    expect(onDisk().customRoles).toEqual(bad);
    expect(config.customRoles).toBeUndefined();
  });

  it("drops a bad list without dropping the rest of the config", () => {
    const parsed = ProjectConfig.parse({ ...defaultProjectConfig("app", "D:\\wt"), budget: { dailyUsd: 3, perTaskUsd: 1 }, customRoles: [{ role: "Not An Id", kinds: ["code"] }] });
    expect(parsed.customRoles).toBeUndefined();
    expect(parsed.budget.dailyUsd).toBe(3);
  });
});
