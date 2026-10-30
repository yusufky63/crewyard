import { describe, expect, it } from "vitest";
import type { DiffFile, ReviewComment } from "@crewyard/core";
import { buildRows, fileStart, fileStep, first, hunkExcerpt, offsets, ROW_HEIGHT, scrollFor, step, visibleRange } from "./review.ts";

const file = (path: string, n: number, over: Partial<DiffFile> = {}): DiffFile => ({
  path,
  oldPath: null,
  status: "modified",
  added: 1,
  removed: 1,
  truncated: false,
  hunks: [
    {
      header: "@@ -1,3 +1,3 @@",
      lines: Array.from({ length: n }, (_, i) =>
        i === 1 ? { kind: "del" as const, old: 2, new: null, text: "old" } : i === 2 ? { kind: "add" as const, old: null, new: 2, text: "new" } : { kind: "context" as const, old: i + 1, new: i + 1, text: `ctx ${i}` },
      ),
    },
  ],
  ...over,
});

const comment = (path: string, line: number, side: "old" | "new"): ReviewComment => ({ id: `${path}${line}${side}`, taskId: "t", path, line, side, body: "fix", hunk: "", createdAt: "" });

describe("diff rows", () => {
  it("puts comments under their line on the right side and the editor after them", () => {
    const rows = buildRows([file("a.ts", 4)], [comment("a.ts", 2, "new"), comment("a.ts", 2, "old"), comment("b.ts", 2, "new")], { path: "a.ts", line: 2, side: "new" });
    expect(rows.map((r) => (r.kind === "line" ? `${r.line.kind}:${r.target.side}${r.target.line}` : r.kind === "comment" ? `c:${r.comment.side}${r.comment.line}` : r.kind))).toEqual([
      "file",
      "hunk",
      "context:new1",
      "del:old2",
      "c:old2",
      "add:new2",
      "c:new2",
      "editor",
      "context:new4",
    ]);
  });

  it("adds a notice for cut, binary and empty files", () => {
    const rows = buildRows([file("a.ts", 3, { truncated: true }), file("b.png", 0, { status: "binary", hunks: [] }), file("c.ts", 0, { hunks: [] })], [], null);
    expect(rows.filter((r) => r.kind === "note").map((r) => (r.kind === "note" ? r.note : ""))).toEqual(["truncated", "binary", "no_lines"]);
  });
});

describe("windowing", () => {
  it("renders only the rows in view for a 50,000-line diff", () => {
    const rows = buildRows([file("big.ts", 50_000)], [], null);
    const tops = offsets(rows);
    expect(tops.at(-1)).toBe(ROW_HEIGHT.file + ROW_HEIGHT.hunk + 50_000 * ROW_HEIGHT.line);
    const [start, end] = visibleRange(tops, 400_000, 600, 10);
    expect(end - start).toBeLessThan(60);
    expect(tops[start]!).toBeLessThanOrEqual(400_000);
    expect(tops[end]!).toBeGreaterThanOrEqual(400_600);
    expect(visibleRange(offsets([]), 0, 600)).toEqual([0, 0]);
  });

  it("scrolls just enough to show a row", () => {
    const tops = offsets(buildRows([file("a.ts", 100)], [], null));
    expect(scrollFor(tops, 2, 0, 200)).toBeNull();
    expect(scrollFor(tops, 50, 0, 200)).toBe(tops[51]! - 200);
    expect(scrollFor(tops, 2, 500, 200)).toBe(tops[2]);
  });
});

describe("keyboard movement", () => {
  const rows = buildRows([file("a.ts", 3), file("b.ts", 3)], [comment("a.ts", 2, "new")], null);
  it("moves over lines and comments, skipping headers, and stops at the ends", () => {
    const start = first(rows);
    expect(rows[start]!.kind).toBe("line");
    const kinds = [1, 2, 3, 4].map((n) => rows[step(rows, start, n)]!.kind);
    expect(kinds).toEqual(["line", "line", "comment", "line"]);
    expect(step(rows, start, -5)).toBe(start);
    expect(step(rows, rows.length - 1, 5)).toBe(rows.length - 1);
  });

  it("jumps between files", () => {
    const start = first(rows);
    const next = fileStep(rows, start, 1);
    expect(rows[next]).toMatchObject({ kind: "line", file: 1 });
    expect(fileStep(rows, next, 1)).toBe(next);
    expect(fileStep(rows, next, -1)).toBe(start);
    expect(fileStart(rows, 1)).toBe(next);
  });
});

describe("comment excerpt", () => {
  it("quotes the hunk header and the lines around the comment in diff form", () => {
    const h = file("a.ts", 20).hunks[0]!;
    expect(hunkExcerpt(h, 2, 1)).toBe("@@ -1,3 +1,3 @@\n-old\n+new\n ctx 3");
    expect(hunkExcerpt(h, 0, 2).split("\n")).toHaveLength(4);
  });
});
