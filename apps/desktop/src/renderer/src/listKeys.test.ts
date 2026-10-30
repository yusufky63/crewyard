import { describe, expect, it } from "vitest";
import { listStep } from "./listKeys.ts";

describe("listStep", () => {
  const ids = ["a", "b", "c"];

  it("moves one row and stops at either end", () => {
    expect(listStep(ids, "a", 1)).toBe("b");
    expect(listStep(ids, "b", -1)).toBe("a");
    expect(listStep(ids, "c", 1)).toBe("c");
    expect(listStep(ids, "a", -1)).toBe("a");
  });

  it("starts at the top on J and at the bottom on K when nothing in the list is selected", () => {
    expect(listStep(ids, null, 1)).toBe("a");
    expect(listStep(ids, null, -1)).toBe("c");
    // A selection the filter hides counts as none.
    expect(listStep(ids, "gone", 1)).toBe("a");
  });

  it("has nothing to select in an empty list", () => {
    expect(listStep([], null, 1)).toBeNull();
  });
});
