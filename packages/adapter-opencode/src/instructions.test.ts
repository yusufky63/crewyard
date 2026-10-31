import { describe, expect, it } from "vitest";
import { withInstructions } from "./mcp.ts";
import { inlineConfigV2 } from "./v2/config.ts";

describe("the project bridge for OpenCode", () => {
  it("adds relative instruction files to the 1.x inline config and keeps what is there", () => {
    expect(withInstructions({ A: "1" }, undefined)).toEqual({ A: "1" });
    const out = withInstructions({ OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { x: {} } }) }, ["CLAUDE.md", ".github\\copilot-instructions.md"]);
    expect(JSON.parse(out.OPENCODE_CONFIG_CONTENT!)).toEqual({ provider: { x: {} }, instructions: ["CLAUDE.md", ".github/copilot-instructions.md"] });
  });

  it("adds them to the 2.x inline config only when there are any", () => {
    const base = { guardDir: "C:\\g", providerId: "anthropic", baseUrl: null, models: [], mcp: [] };
    expect(JSON.parse(inlineConfigV2(base).OPENCODE_CONFIG_CONTENT!).instructions).toBeUndefined();
    expect(JSON.parse(inlineConfigV2({ ...base, instructions: ["CLAUDE.md"] }).OPENCODE_CONFIG_CONTENT!).instructions).toEqual(["CLAUDE.md"]);
  });
});
