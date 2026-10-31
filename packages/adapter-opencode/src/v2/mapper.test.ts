import { describe, expect, it } from "vitest";
import type { FormInfo, SessionMessage } from "./api.ts";
import { formAnswer, OpenCodeV2Mapper } from "./mapper.ts";

const tokens = (input: number, output: number) => ({ input, output, reasoning: 0, cache: { read: 0, write: 0 } });

describe("OpenCodeV2Mapper", () => {
  it("emits streamed text once, also when the step's end or a resync repeats it", () => {
    const m = new OpenCodeV2Mapper("ses_1", "C:\\w t");
    expect(m.delta("ses_1", "msg_a", 0, "text", "Hel")).toEqual([{ type: "message.delta", text: "Hel" }]);
    expect(m.textEnded("ses_1", "msg_a", 0, "text", "Hello")).toEqual([{ type: "message.delta", text: "lo" }]);
    const history: SessionMessage[] = [{ type: "assistant", id: "msg_a", time: { created: 1 }, content: [{ type: "text", text: "Hello there" }] }];
    expect(m.message("ses_1", history[0]!)).toEqual([{ type: "message.delta", text: " there" }]);
    expect(m.message("ses_1", history[0]!)).toEqual([]);
  });

  it("keys text and reasoning blocks by kind, since their ordinals are counted apart", () => {
    const m = new OpenCodeV2Mapper("ses_1", "C:\\w");
    expect(m.delta("ses_1", "msg_a", 0, "reasoning", "think")).toEqual([{ type: "thought.delta", text: "think" }]);
    expect(m.delta("ses_1", "msg_a", 0, "text", "Hi")).toEqual([{ type: "message.delta", text: "Hi" }]);
    const step: SessionMessage = { type: "assistant", id: "msg_a", time: { created: 1 }, content: [{ type: "reasoning", text: "thinking" }, { type: "text", text: "Hi" }, { type: "tool", id: "call_1", name: "read", state: { status: "running", input: {} } }, { type: "text", text: "Done" }] };
    expect(m.message("ses_1", step)).toEqual([
      { type: "thought.delta", text: "ing" },
      { type: "tool.call", toolCallId: "call_1", title: "read", kind: "read", input: {} },
      { type: "tool.update", toolCallId: "call_1", status: "in_progress" },
      { type: "message.delta", text: "Done" },
    ]);
  });

  it("ignores sessions it does not own and takes in subagent sessions of the root", () => {
    const m = new OpenCodeV2Mapper("ses_1", "C:\\w");
    expect(m.delta("ses_other", "msg_a", 0, "text", "x")).toEqual([]);
    m.sessionSeen({ sessionID: "ses_child", parentID: "ses_1" });
    expect(m.owns("ses_child")).toBe(true);
  });

  it("names a tool from its input start and moves its status forward only", () => {
    const m = new OpenCodeV2Mapper("ses_1", "C:\\w");
    m.toolStarted("ses_1", "call_1", "shell");
    expect(m.toolCalled("ses_1", "call_1", { command: "ls" })).toEqual([
      { type: "tool.call", toolCallId: "call_1", title: "shell", kind: "execute", input: { command: "ls" } },
      { type: "tool.update", toolCallId: "call_1", status: "in_progress" },
    ]);
    expect(m.toolDone("ses_1", "call_1", true, "a\nb")).toEqual([{ type: "tool.update", toolCallId: "call_1", status: "completed", output: "a\nb" }]);
    expect(m.message("ses_1", { type: "assistant", id: "msg_a", time: { created: 1 }, content: [{ type: "tool", id: "call_1", name: "shell", state: { status: "running", input: {} } }] })).toEqual([]);
  });

  it("primes a resumed session's history without emitting it", () => {
    const m = new OpenCodeV2Mapper("ses_1", "C:\\w");
    m.prime("ses_1", [
      { type: "user", id: "msg_u", time: { created: 1 }, text: "hi" },
      { type: "assistant", id: "msg_a", time: { created: 2 }, content: [{ type: "text", text: "old" }] },
    ]);
    expect(m.turn("msg_u")).toEqual([]);
    expect(m.textEnded("ses_1", "msg_a", 0, "text", "old")).toEqual([]);
    expect(m.turn("msg_new")).toEqual([{ type: "turn.started", turnRef: "msg_new" }]);
  });

  it("sums each session's last totals and takes the context from the last step", () => {
    const m = new OpenCodeV2Mapper("ses_1", "C:\\w");
    m.sessionSeen({ sessionID: "ses_2", parentID: "ses_1" });
    m.step("ses_1", { input: 50, output: 5, reasoning: 0, cache: { read: 20, write: 1 } });
    expect(m.sessionUsage("ses_1", 0.01, tokens(50, 5))).toMatchObject([{ tokensIn: 50, tokensOut: 5, contextUsed: 76, costUsd: 0.01, costProvenance: "estimated" }]);
    expect(m.sessionUsage("ses_2", 0.02, tokens(10, 1))).toMatchObject([{ tokensIn: 60, tokensOut: 6, costUsd: 0.03 }]);
    expect(m.sessionUsage("ses_2", 0.02, tokens(10, 1))).toEqual([]);
  });

  it("maps a shell request to its command and a file request to its path", () => {
    const m = new OpenCodeV2Mapper("ses_1", "C:\\w");
    expect(m.permission({ id: "per_1", sessionID: "ses_1", action: "shell", resources: ["git push"], metadata: { command: "git push origin" } })).toEqual([
      { type: "request.approval", requestId: "per_1", toolCallId: null, command: "git push origin", cwd: "C:\\w", paths: [], network: false },
    ]);
    expect(m.permission({ id: "per_1", sessionID: "ses_1", action: "shell", resources: [] })).toEqual([]);
    expect(m.permission({ id: "per_2", sessionID: "ses_1", action: "edit", resources: ["src/a.ts"], source: { type: "tool", messageID: "msg_a", id: "call_9" } })).toMatchObject([{ toolCallId: "call_9", command: null, paths: ["src/a.ts"] }]);
    expect(m.permission({ id: "per_3", sessionID: "ses_1", action: "webfetch", resources: ["https://example.com"] })).toMatchObject([{ command: "webfetch https://example.com", network: true }]);
    expect([...m.pending.keys()]).toEqual(["per_1", "per_2", "per_3"]);
  });

  it("turns a form into one question per field", () => {
    const m = new OpenCodeV2Mapper("ses_1", "C:\\w");
    const form: FormInfo = {
      id: "frm_1",
      sessionID: "ses_1",
      title: "Setup",
      fields: [
        { key: "db", type: "string", title: "Database", options: [{ value: "pg", label: "Postgres" }], custom: false },
        { key: "tests", type: "boolean", title: "Add tests?" },
        { key: "name", type: "string", title: "Project name" },
      ],
    };
    expect(m.form(form)).toEqual([
      {
        type: "request.question",
        requestId: "frm_1",
        questions: [
          { prompt: "Database", options: [{ label: "Postgres" }], allowFreeText: false },
          { prompt: "Add tests?", options: [{ label: "true" }, { label: "false" }], allowFreeText: true },
          { prompt: "Project name", options: [], allowFreeText: true },
        ],
      },
    ]);
    expect(m.form(form)).toEqual([]);
  });
});

describe("formAnswer", () => {
  it("sends option values, booleans, numbers, lists and free text keyed by field", () => {
    const form: FormInfo = {
      id: "frm_1",
      sessionID: "ses_1",
      title: "t",
      fields: [
        { key: "db", type: "string", options: [{ value: "pg", label: "Postgres" }] },
        { key: "tests", type: "boolean" },
        { key: "count", type: "integer" },
        { key: "tags", type: "multiselect", options: [{ value: "a", label: "Alpha" }], custom: true },
        { key: "skip", type: "string" },
      ],
    };
    const answer = formAnswer(form, { kind: "question", answers: [{ selected: ["Postgres"] }, { selected: ["false"] }, { selected: [], text: " 3 " }, { selected: ["Alpha"], text: "beta" }, { selected: [] }] });
    expect(answer).toEqual({ db: "pg", tests: false, count: 3, tags: ["a", "beta"] });
  });
});
