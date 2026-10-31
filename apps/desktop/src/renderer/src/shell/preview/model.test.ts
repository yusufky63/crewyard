import { describe, expect, it } from "vitest";
import { previewCandidates, sameRect, visibleRect } from "./model.ts";

describe("previewCandidates", () => {
  it("puts the worktree port first and drops a printed copy of it", () => {
    const list = previewCandidates({
      port: 5173,
      printed: [
        { url: "http://localhost:5173/", runId: "r2", at: "t2" },
        { url: "http://127.0.0.1:6006/", runId: "", at: "t1" },
      ],
    });
    expect(list).toEqual([
      { url: "http://localhost:5173/", source: "port", runId: null, at: null },
      { url: "http://127.0.0.1:6006/", source: "printed", runId: null, at: "t1" },
    ]);
  });

  it("is empty without a port or printed URLs", () => {
    expect(previewCandidates({ port: null, printed: [] })).toEqual([]);
  });
});

describe("visibleRect", () => {
  const clip = { left: 900, top: 40, right: 1280, bottom: 872 };

  it("returns the frame when it is fully inside the inspector", () => {
    expect(visibleRect({ left: 916, top: 300, right: 1264, bottom: 700 }, clip)).toEqual({ x: 916, y: 300, width: 348, height: 400 });
  });

  it("cuts a frame scrolled under the inspector's top edge", () => {
    expect(visibleRect({ left: 916, top: -100.4, right: 1264, bottom: 300 }, clip)).toEqual({ x: 916, y: 40, width: 348, height: 260 });
  });

  it("hides a frame that is almost or fully out of view", () => {
    expect(visibleRect({ left: 916, top: 850, right: 1264, bottom: 1250 }, clip)).toBeNull();
    expect(visibleRect({ left: 916, top: 900, right: 1264, bottom: 1300 }, clip)).toBeNull();
  });
});

describe("sameRect", () => {
  it("compares by value and treats null as its own value", () => {
    expect(sameRect(null, null)).toBe(true);
    expect(sameRect(null, { x: 0, y: 0, width: 1, height: 1 })).toBe(false);
    expect(sameRect({ x: 1, y: 2, width: 3, height: 4 }, { x: 1, y: 2, width: 3, height: 4 })).toBe(true);
  });
});
