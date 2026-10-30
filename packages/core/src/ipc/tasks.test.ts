import { describe, expect, it } from "vitest";
import { splitEndDetail } from "./tasks.ts";

describe("splitEndDetail", () => {
  it("separates our code from the error text a runner gave", () => {
    expect(splitEndDetail("process_gone")).toEqual({ code: "process_gone", text: null });
    expect(splitEndDetail("bootstrap.denied")).toEqual({ code: "bootstrap.denied", text: null });
    expect(splitEndDetail("adapter.failed: spawn opencode ENOENT")).toEqual({ code: "adapter.failed", text: "spawn opencode ENOENT" });
    // A provider's own text is not a code, whatever colons it holds.
    expect(splitEndDetail('API Error: 402 {"error":{"code":402}}')).toEqual({ code: null, text: 'API Error: 402 {"error":{"code":402}}' });
    expect(splitEndDetail("Missing bearer or basic authentication in header")).toEqual({ code: null, text: "Missing bearer or basic authentication in header" });
    expect(splitEndDetail(null)).toEqual({ code: null, text: null });
    expect(splitEndDetail("  ")).toEqual({ code: null, text: null });
  });
});
