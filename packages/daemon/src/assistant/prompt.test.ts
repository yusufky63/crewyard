import { describe, expect, it } from "vitest";
import { ASSISTANT_EXTRA_TOOLS, utf8Length } from "@crewyard/core";
import { assistantPrompt } from "./prompt.ts";

// The tool guidance in the assistant's first message (docs/adr/0022). The owner, 2026-11-01: a
// model said it had no tool to remove its own drafts although discard_draft exists, and no tool for
// goals. The prompt explains; the daemon enforces every rule on its own.

describe("assistant prompt tool guidance", () => {
  const p = assistantPrompt({ name: "demo", path: "C:\\Projeler\\demo repo" }, "Remove the draft you made");

  it("names the draft tools, the draft id they take, and list_drafts before saying a draft cannot change", () => {
    expect(p).toContain("discard_draft removes or replaces one");
    expect(p).toContain("draft_id that propose_task, draft_goal or list_drafts gives you");
    expect(p).toContain("Before saying a draft cannot be changed, call list_drafts");
  });

  it("offers draft_goal for work that needs several tasks, with Plan goal as the person's click", () => {
    expect(p).toContain("call draft_goal");
    expect(p).toContain("presses Plan goal");
  });

  it("names who can do what it cannot: the person's click, or Autopilot", () => {
    expect(p).toContain("is the person's click");
    expect(p).toContain("needs Autopilot, which the person turns on in this panel");
    expect(p).toContain("Never say a tool is missing without checking your tool list");
  });

  it("names every one of its own tools and stays short, since it goes out with every session", () => {
    for (const tool of ASSISTANT_EXTRA_TOOLS) expect(p).toContain(tool);
    expect(utf8Length(p)).toBeLessThan(4_200);
  });
});
