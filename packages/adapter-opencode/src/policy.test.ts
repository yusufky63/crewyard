import { describe, expect, it } from "vitest";
import { isDocsPath, mustReject, permissionRules } from "./policy.ts";

describe("OpenCode role policy", () => {
  it("denies every edit for read-only roles, after the agent's own allow rules", () => {
    const rules = permissionRules({ writes: "none", allowCommands: [], network: "ask" });
    expect(rules[0]).toEqual({ permission: "edit", pattern: "*", action: "deny" });
    expect(rules.filter((r) => r.permission === "edit" && r.action !== "deny")).toEqual([]);
  });

  it("lets docs roles edit docs only; later rules win in OpenCode", () => {
    const rules = permissionRules({ writes: "docs", allowCommands: [], network: "denied" });
    const edits = rules.filter((r) => r.permission === "edit");
    expect(edits[0]).toEqual({ permission: "edit", pattern: "*", action: "deny" });
    expect(edits.slice(1).every((r) => r.action === "allow")).toBe(true);
    expect(rules).toContainEqual({ permission: "websearch", pattern: "*", action: "deny" });
  });

  it("keeps worktree edits open and sends commands to approval unless allowlisted", () => {
    const rules = permissionRules({ writes: "worktree", allowCommands: ["dotnet test"], network: "allowed" });
    expect(rules.some((r) => r.permission === "edit")).toBe(false);
    expect(rules).toContainEqual({ permission: "bash", pattern: "*", action: "ask" });
    expect(rules).toContainEqual({ permission: "bash", pattern: "dotnet test *", action: "allow" });
    expect(rules).toContainEqual({ permission: "webfetch", pattern: "*", action: "allow" });
  });

  it("rejects requests the role may never grant", () => {
    expect(mustReject({ writes: "none", allowCommands: [], network: "ask" }, "edit", ["a.ts"])).toBe(true);
    expect(mustReject({ writes: "docs", allowCommands: [], network: "ask" }, "edit", ["docs/x.md", "README.md"])).toBe(false);
    expect(mustReject({ writes: "docs", allowCommands: [], network: "ask" }, "edit", ["docs/x.md", "src/a.ts"])).toBe(true);
    expect(mustReject({ writes: "worktree", allowCommands: [], network: "denied" }, "webfetch", ["https://x"])).toBe(true);
    expect(mustReject({ writes: "worktree", allowCommands: [], network: "ask" }, "bash", ["rm -rf /"])).toBe(false);
  });

  it("recognises docs paths with either slash", () => {
    expect(["docs\\adr\\0001.md", "./CHANGELOG.md", "notes.txt", "docs/img.png"].every(isDocsPath)).toBe(true);
    expect(isDocsPath("src/index.ts")).toBe(false);
  });
});
