import { describe, expect, it } from "vitest";
import { moveActive, rankCommands, scoreText, type Command } from "./search.ts";

describe("scoreText", () => {
  it("orders exact, prefix, word start, substring and fuzzy matches", () => {
    const q = "inbox";
    const scores = [scoreText("Inbox", q), scoreText("Inbox items", q), scoreText("Open inbox", q), scoreText("Myinbox", q), scoreText("In a box", "inbx")];
    expect(scores[0]).toBe(100);
    expect(scores[1]).toBe(80);
    expect(scores[2]).toBe(60);
    expect(scores[3]).toBe(40);
    expect(scores[4]).toBeGreaterThan(0);
    expect(scores[4]).toBeLessThanOrEqual(20);
  });

  it("scores tight fuzzy matches above loose ones and rejects letters out of order", () => {
    expect(scoreText("crew graph", "cgr")).toBeLessThan(scoreText("cgraph", "cgr"));
    expect(scoreText("tasks", "kst")).toBe(0);
  });

  it("lowercases with the UI locale, so Turkish İ matches i", () => {
    expect(scoreText("İstek kutusu", "istek", "tr")).toBe(80);
  });
});

describe("rankCommands", () => {
  const cmds: Command[] = [
    { id: "s:tasks", group: "screen", title: "Tasks" },
    { id: "s:limits", group: "screen", title: "Limits" },
    { id: "a:new-task", group: "action", title: "New task" },
    { id: "p:old", group: "project", title: "old-game", keywords: "C:\\Projeler\\old-game", recency: "2026-10-01T00:00:00Z" },
    { id: "p:new", group: "project", title: "stick wars", keywords: "C:\\Projeler\\stick wars", recency: "2026-10-29T00:00:00Z" },
    { id: "t:1", group: "task", title: "Fix the limits banner", keywords: "stick wars", recency: "2026-10-28T00:00:00Z" },
    { id: "t:2", group: "task", title: "Add task search", keywords: "old-game", recency: "2026-10-27T00:00:00Z" },
  ];

  it("shows screens, actions and recent projects before typing, and no tasks", () => {
    const ids = rankCommands(cmds, "  ").map((c) => c.id);
    expect(ids).toEqual(["s:tasks", "s:limits", "a:new-task", "p:new", "p:old"]);
  });

  it("puts a better title match first regardless of group", () => {
    const ids = rankCommands(cmds, "limits").map((c) => c.id);
    expect(ids[0]).toBe("s:limits");
    expect(ids).toContain("t:1");
  });

  it("weights keyword hits below title hits", () => {
    const ids = rankCommands(cmds, "stick").map((c) => c.id);
    expect(ids[0]).toBe("p:new");
    expect(ids[1]).toBe("t:1");
  });

  it("breaks score ties by group order, then recency", () => {
    const ids = rankCommands(cmds, "task").map((c) => c.id);
    // "Tasks" (screen, prefix) beats "New task" (action, word start) beats "Add task search" (task, word start).
    expect(ids.slice(0, 3)).toEqual(["s:tasks", "a:new-task", "t:2"]);
  });

  it("drops what does not match and respects the limit", () => {
    expect(rankCommands(cmds, "zzz")).toEqual([]);
    expect(rankCommands(cmds, "a", 2)).toHaveLength(2);
  });
});

describe("moveActive", () => {
  it("wraps with the arrow keys and jumps with Home and End", () => {
    expect(moveActive(2, 3, "ArrowDown")).toBe(0);
    expect(moveActive(0, 3, "ArrowUp")).toBe(2);
    expect(moveActive(-1, 3, "ArrowUp")).toBe(2);
    expect(moveActive(1, 3, "Home")).toBe(0);
    expect(moveActive(1, 3, "End")).toBe(2);
    expect(moveActive(0, 0, "ArrowDown")).toBe(-1);
  });
});
