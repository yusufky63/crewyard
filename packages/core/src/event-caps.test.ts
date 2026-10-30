import { describe, expect, it } from "vitest";
import { capEvent, capText, EVENT_LIMITS, looksBinary, utf8Length } from "./event-caps.ts";
import type { AgentEvent } from "./events.ts";

const env = { runId: "r1", seq: 1, at: "2026-10-30T00:00:00Z", source: { adapter: "fake" as const, cliVersion: null } };

describe("capText", () => {
  it("counts UTF-8 bytes, Turkish letters and emoji-range pairs included", () => {
    expect(utf8Length("abc")).toBe(3);
    expect(utf8Length("ığüşöç")).toBe(12);
    expect(utf8Length("\u{1F600}")).toBe(4);
    expect(utf8Length("€")).toBe(3);
  });

  it("leaves text under the cap alone", () => {
    expect(capText("short", 10)).toEqual({ text: "short", bytes: null, binary: false });
  });

  it("keeps the head within the cap, never splits a character, and says how big it was", () => {
    const s = "ş".repeat(10_000);
    const r = capText(s, 1_000);
    expect(r.bytes).toBe(20_000);
    expect(utf8Length(r.text)).toBeLessThanOrEqual(1_000);
    expect(r.text.endsWith("\n[truncated, 20000 bytes]")).toBe(true);
    expect(r.text.replace(/\n\[.*$/, "")).toMatch(/^ş+$/);
    const pairs = capText("\u{1F600}".repeat(1_000), 101);
    expect(pairs.text.replace(/\n\[.*$/, "").length % 2).toBe(0);
  });

  it("names where the full text was kept", () => {
    expect(capText("x".repeat(100), 60, "C:\\Data\\out 1.txt").text).toMatch(/\[truncated, 100 bytes; full text in C:\\Data\\out 1\.txt\]$/);
  });

  it("replaces binary content with a marker and no head", () => {
    const pdf = `%PDF-1.7\n${"\0\u00ff\ufffd\u0001".repeat(50_000)}`;
    expect(looksBinary(pdf)).toBe(true);
    expect(looksBinary("\u001b[32mok\u001b[0m\r\n\tdone")).toBe(false);
    expect(capText(pdf, 1_000)).toEqual({ text: `[binary output, ${utf8Length(pdf)} bytes]`, bytes: utf8Length(pdf), binary: true });
  });
});

describe("capEvent", () => {
  it("caps a huge tool output, offers the full text for keeping and passes small events through untouched", () => {
    const big = "line\n".repeat(100_000);
    const kept: string[] = [];
    const { event, cut } = capEvent({ ...env, type: "tool.update", toolCallId: "t", status: "completed", output: big }, EVENT_LIMITS, (field, full) => {
      kept.push(`${field}:${full.length}`);
      return "C:\\Data\\run 1.txt";
    });
    expect(event.type === "tool.update" && utf8Length(event.output!)).toBeLessThanOrEqual(EVENT_LIMITS.text);
    expect(event.type === "tool.update" && event.output).toMatch(/full text in C:\\Data\\run 1\.txt\]$/);
    expect(cut).toEqual([{ field: "output", bytes: 500_000, binary: false }]);
    expect(kept).toEqual(["output:500000"]);

    const small: AgentEvent = { ...env, type: "message.delta", text: "hi" };
    expect(capEvent(small)).toEqual({ event: small, cut: [] });
  });

  it("never keeps binary output, even when asked", () => {
    let asked = false;
    const { event } = capEvent({ ...env, type: "tool.update", toolCallId: "t", status: "completed", output: "\0".repeat(200_000) }, EVENT_LIMITS, () => ((asked = true), "x"));
    expect(asked).toBe(false);
    expect(event.type === "tool.update" && event.output).toBe("[binary output, 200000 bytes]");
  });

  it("replaces an oversized tool input with a marker object and caps lists and lines", () => {
    const { event, cut } = capEvent({ ...env, type: "tool.call", toolCallId: "t", title: "Write", kind: "edit", input: { content: "a".repeat(100_000) } });
    expect(event.type === "tool.call" && event.input).toMatchObject({ truncated: true, bytes: 100_014 });
    expect(cut.map((c) => c.field)).toEqual(["input"]);

    const plan = capEvent({ ...env, type: "plan.update", steps: Array.from({ length: 2_000 }, (_, i) => ({ title: `s${i}`, status: "pending" as const })) });
    expect(plan.event.type === "plan.update" && plan.event.steps).toHaveLength(EVENT_LIMITS.items);

    const approval = capEvent({ ...env, type: "request.approval", requestId: "q", toolCallId: null, command: `echo ${"x".repeat(50_000)}`, cwd: null, paths: [], network: false });
    expect(approval.event.type === "request.approval" && utf8Length(approval.event.command!)).toBeLessThanOrEqual(EVENT_LIMITS.line);
  });

  it("does not change the event it was given", () => {
    const ev: AgentEvent = { ...env, type: "message.delta", text: "z".repeat(200_000) };
    capEvent(ev);
    expect(ev.type === "message.delta" && ev.text.length).toBe(200_000);
  });
});
