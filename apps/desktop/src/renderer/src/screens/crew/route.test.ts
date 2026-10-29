import { describe, expect, it } from "vitest";
import { routeEdge, segmentHits, spreadPorts, type Box } from "./route.ts";

const box = (x: number, y: number): Box => ({ x, y, w: 180, h: 100 });
// Each quadratic curve is one rounded corner.
const corners = (d: string) => (d.match(/Q/g) ?? []).length;

describe("routeEdge", () => {
  it("draws a straight line between nodes that face each other", () => {
    expect(routeEdge(box(0, 0), box(300, 12))!.d).toBe("M180 56L300 56");
    expect(routeEdge(box(0, 0), box(0, 200))!.d).toBe("M90 100L90 200");
  });

  it("otherwise steps through the gap between the columns, side to side", () => {
    const r = routeEdge(box(0, 0), box(300, 300))!;
    expect(corners(r.d)).toBe(2);
    expect(r.d.startsWith("M180 50L232 50Q240 50")).toBe(true);
    expect(r.d.endsWith("L300 350")).toBe(true);
    expect(r.label).toEqual({ x: 240, y: 200 });
  });

  it("steps through the gap between rows for nodes stacked above each other", () => {
    const r = routeEdge(box(0, 0), box(170, 300))!;
    expect(corners(r.d)).toBe(2);
    expect(r.d.startsWith("M90 100")).toBe(true);
    expect(r.d.endsWith("L260 300")).toBe(true);
  });

  it("falls back to a single bend when the step would cross a node", () => {
    // A node sitting in the gap between the columns blocks the step.
    const blocker: Box = { x: 200, y: 100, w: 80, h: 160 };
    const r = routeEdge(box(0, 0), box(300, 300), [blocker])!;
    expect(corners(r.d)).toBe(1);
    expect(r.d.startsWith("M90 100")).toBe(true);
    expect(r.d.endsWith("L300 350")).toBe(true);
  });

  it("routes leftwards and upwards too", () => {
    const r = routeEdge(box(300, 300), box(0, 0))!;
    expect(r.d.startsWith("M300 350")).toBe(true);
    expect(r.d.endsWith("L180 50")).toBe(true);
  });

  it("shifts ports by the given offsets", () => {
    const r = routeEdge(box(0, 0), box(300, 300), [], { from: -6, to: 6 })!;
    expect(r.d.startsWith("M180 44")).toBe(true);
    expect(r.d.endsWith("L300 356")).toBe(true);
  });

  it("returns nothing while two nodes overlap during a drag", () => {
    expect(routeEdge(box(0, 0), box(60, 40))).toBeNull();
  });

  it("detects segments crossing a box but not ones running along its edge", () => {
    expect(segmentHits([0, 50], [400, 50], box(100, 0))).toBe(true);
    expect(segmentHits([0, 100], [400, 100], box(100, 0))).toBe(false);
    expect(segmentHits([0, 150], [400, 150], box(100, 0))).toBe(false);
  });
});

describe("spreadPorts", () => {
  it("spreads edges into one target by the height of their sources", () => {
    const y: Record<string, number> = { a: 0, b: 300, t: 100, u: 500 };
    const ports = spreadPorts(
      [
        { id: "1", from: "b", to: "t" },
        { id: "2", from: "a", to: "t" },
        { id: "3", from: "a", to: "u" },
      ],
      (id) => y[id]!,
    );
    expect(ports.get("2")!.to).toBe(-6);
    expect(ports.get("1")!.to).toBe(6);
    // a has two outgoing edges, sorted by their targets' height.
    expect(ports.get("2")!.from).toBe(-6);
    expect(ports.get("3")!.from).toBe(6);
    expect(ports.get("1")!.from).toBeUndefined();
  });
});
