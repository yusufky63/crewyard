import { describe, expect, it } from "vitest";
import { formatBytes, formatCount, formatDay } from "./format.ts";

describe("format", () => {
  it("prints sizes the way release pages do", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(123_456_789)).toBe("118 MB");
    expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 GB");
    expect(formatBytes(-1)).toBe("Unknown size");
  });

  it("prints a UTC day, whatever the server's zone", () => {
    expect(formatDay("2026-10-31T23:30:00Z")).toBe("2026-10-31");
    expect(formatDay("nope")).toBe("Unknown date");
  });

  it("shortens large counts", () => {
    expect(formatCount(999)).toBe("999");
    expect(formatCount(1200)).toBe("1.2k");
    expect(formatCount(1000)).toBe("1k");
    expect(formatCount(25_400)).toBe("25k");
  });
});
