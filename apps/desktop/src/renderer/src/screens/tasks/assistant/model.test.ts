import { describe, expect, it } from "vitest";
import type { AssistantLine, AssistantView } from "@crewyard/core";
import { byteMeter, elapsedText, excerpt, groupLines, isPath, liveState, pathIn, quoted, toolCategory, toolCounts } from "./model.ts";

let n = 0;
const line = (role: AssistantLine["role"], text: string, extra: Partial<AssistantLine> = {}): AssistantLine => ({ id: `l${++n}`, role, text, at: `2026-10-31T10:00:${String(n % 60).padStart(2, "0")}.000Z`, ...extra });
const view = (state: AssistantView["state"], lines: AssistantLine[]) => ({ state, lines });

describe("groupLines", () => {
  it("folds each burst of tool lines into one entry and keeps the rest in order", () => {
    const lines = [line("user", "hi"), line("tool", "Read a.ts"), line("tool", "Grep: x"), line("assistant", "ok"), line("tool", "Read b.ts")];
    const g = groupLines(lines);
    expect(g.map((e) => e.t)).toEqual(["line", "tools", "line", "tools"]);
    expect(g[1]!.t === "tools" && g[1]!.lines.map((l) => l.text)).toEqual(["Read a.ts", "Grep: x"]);
    expect(g[3]!.t === "tools" && g[3]!.lines).toHaveLength(1);
  });
});

describe("tool lines", () => {
  it("sorts calls by their first word, and a bare path counts as a read", () => {
    expect(toolCategory("Read: packages/core/src/x.ts")).toBe("read");
    expect(toolCategory("Read README.md")).toBe("read");
    expect(toolCategory("src/app.ts")).toBe("read");
    expect(toolCategory("Grep: TODO")).toBe("search");
    expect(toolCategory("Glob: **/*.ts")).toBe("search");
    expect(toolCategory("Bash: git log")).toBe("other");
    expect(toolCategory("mcp__crewyard__list_tasks")).toBe("other");
    expect(toolCounts([line("tool", "Read a.ts"), line("tool", "Read b.ts"), line("tool", "Grep: x"), line("tool", "Bash: ls")])).toEqual({ read: 2, search: 1, other: 1 });
  });

  it("finds the path a call names, never a URL", () => {
    expect(pathIn("Read: packages/core/src/x.ts")).toBe("packages/core/src/x.ts");
    expect(pathIn("Read README.md:12")).toBe("README.md:12");
    expect(pathIn("C:\\Projeler\\my app\\x.ts")).toBeNull();
    expect(pathIn("apps/desktop/e2e")).toBe("apps/desktop/e2e");
    expect(pathIn("Grep: TODO")).toBeNull();
    expect(pathIn("Fetch https://example.com/a.js")).toBeNull();
    expect(isPath("https://example.com/a.js")).toBe(false);
    expect(isPath("src/x.ts:12:4")).toBe(true);
    expect(isPath("package.json")).toBe(true);
    expect(isPath("e.g.")).toBe(false);
    expect(isPath("two words.ts")).toBe(false);
  });
});

describe("liveState", () => {
  it("says nothing while idle or waiting, and sending until the daemon answers", () => {
    expect(liveState(view("idle", [line("user", "a")]), false)).toBeNull();
    expect(liveState(view("waiting", [line("user", "a"), line("assistant", "b")]), false)).toBeNull();
    expect(liveState(undefined, true)?.phase).toBe("sending");
  });

  it("starting, thinking, the latest call, then the reply itself", () => {
    const you = line("user", "plan it");
    expect(liveState(view("starting", [you]), true)).toMatchObject({ phase: "starting", since: you.at });
    expect(liveState(view("working", [line("assistant", "old"), you]), false)).toMatchObject({ phase: "thinking", since: you.at, tool: null });
    expect(liveState(view("working", [you, line("tool", "Read a.ts"), line("notice", "denied")]), false)).toMatchObject({ phase: "tool", tool: "Read a.ts" });
    expect(liveState(view("working", [you, line("tool", "Read a.ts"), line("assistant", "I read")]), false)?.phase).toBe("streaming");
  });

  it("counts queued messages and times the turn from the message that started it", () => {
    const first = line("user", "one");
    const s = liveState(view("working", [first, line("assistant", "half"), line("user", "two", { queued: true })]), false);
    expect(s).toMatchObject({ phase: "streaming", queued: 1, since: first.at });
  });
});

describe("text helpers", () => {
  it("elapsed time reads m:ss, then h:mm:ss", () => {
    expect(elapsedText(-5)).toBe("0:00");
    expect(elapsedText(65_000)).toBe("1:05");
    expect(elapsedText(3_725_000)).toBe("1:02:05");
  });

  it("quotes a reply into the box after what is already written", () => {
    expect(quoted("a\n\nb")).toBe("> a\n>\n> b\n\n");
    expect(quoted("x", "note  ")).toBe("note\n\n> x\n\n");
  });

  it("names a reply by its first line without Markdown marks", () => {
    expect(excerpt("\n## **Plan**\n- one")).toBe("Plan");
    expect(excerpt("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
  });

  it("shows the byte counter only near the cap", () => {
    expect(byteMeter("hello", 8000)).toEqual({ bytes: 5, near: false, over: false });
    expect(byteMeter("ğ".repeat(3500), 8000)).toMatchObject({ bytes: 7000, near: true, over: false });
    expect(byteMeter("a".repeat(8001), 8000).over).toBe(true);
  });
});
