import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Catalog, estimateCost, usableWith } from "./catalog.ts";
import { defaultProjectConfig, findSecretLikeKeys, ProjectConfig } from "./project.ts";

describe("ProjectConfig", () => {
  it("accepts the wizard defaults", () => {
    const cfg = defaultProjectConfig("new-rts", "C:\\Projeler\\.mc\\worktrees\\new-rts");
    expect(ProjectConfig.parse(cfg).rules.fallback).toBe("ask");
    expect(findSecretLikeKeys(cfg)).toEqual([]);
  });

  it("flags values that look like secrets", () => {
    expect(findSecretLikeKeys({ github: { token: "ghp_x" }, apiKey: "" })).toEqual(["github.token"]);
  });
});

describe("catalog snapshot", () => {
  const raw = readFileSync(fileURLToPath(new URL("../../../catalog/providers.json", import.meta.url)), "utf8");
  const catalog = Catalog.parse(JSON.parse(raw));

  it("parses and lists Anthropic-compatible providers for Claude Code", () => {
    const direct = catalog.providers.filter((p) => p.runners.claudeCode === "direct").map((p) => p.id);
    expect(direct).toContain("deepseek");
    expect(direct).toContain("moonshotai");
    expect(catalog.providers.find((p) => p.id === "mistral")?.runners.claudeCode).toBe("conversion");
    expect(usableWith("conversion")).toBe(false);
  });

  it("estimates cost from per-million prices", () => {
    const flash = catalog.providers.find((p) => p.id === "deepseek")?.models.find((m) => m.id === "deepseek-flash");
    expect(flash).toBeDefined();
    expect(estimateCost(flash!, 1_000_000, 0)).toBeCloseTo(flash!.cost!.input!, 6);
  });
});
