import { describe, expect, it } from "vitest";
import { projectDocFallback } from "./adapter.ts";

describe("the project bridge for Codex", () => {
  it("names fallback files only, never paths or AGENTS.md", () => {
    expect(projectDocFallback(undefined)).toBeNull();
    expect(projectDocFallback(["CLAUDE.md", ".github/copilot-instructions.md", "AGENTS.md", "docs\\x.md"])).toEqual(["CLAUDE.md"]);
    expect(projectDocFallback([".github/copilot-instructions.md"])).toBeNull();
  });
});
