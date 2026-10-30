import { afterEach, describe, expect, it } from "vitest";
import { normalize, startFakeModel, USAGE, type FakeModel } from "./fake-model.ts";

// The conformance suite itself needs the runner CLIs and stays out of `pnpm check`; the fake model
// it drives them with is checked here, so a broken stream shows up before anyone runs the suite.

let fake: FakeModel | null = null;
afterEach(async () => {
  await fake?.close();
  fake = null;
});

const post = (path: string, body: unknown) => fetch(`${fake!.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** The JSON payloads of an SSE body, with their `event:` names where the format has them. */
async function events(res: Response): Promise<Array<{ event: string | null; data: unknown }>> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((block) => block.includes("data: "))
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? null;
      const data = /^data: (.*)$/m.exec(block)?.[1] ?? "";
      return { event, data: data === "[DONE]" ? data : (JSON.parse(data) as unknown) };
    });
}

describe("normalize", () => {
  it("counts tool rounds since the last user message in every format", () => {
    const responses = normalize("responses", "/v1/responses", {
      model: "m",
      tools: [{ type: "function", name: "shell_command" }, { type: "namespace", tools: [{ name: "inner" }] }],
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "go [[cf:x]]" }] },
        { type: "function_call", call_id: "c1", name: "shell_command", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "done" },
      ],
    });
    expect(responses).toMatchObject({ tools: ["shell_command", "inner"], lastUserText: "go [[cf:x]]", toolRounds: 1, toolResults: [{ callId: "c1", name: "shell_command", text: "done" }] });

    const messages = normalize("messages", "/v1/messages", {
      model: "m",
      stream: true,
      tools: [{ name: "Bash" }],
      messages: [
        { role: "user", content: [{ type: "text", text: "<system-reminder>x</system-reminder>" }, { type: "text", text: "go" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "ok" }] }, { type: "text", text: "reminder" }] },
      ],
    });
    // Text next to a tool result is not a new user turn, so the round count survives it.
    expect(messages).toMatchObject({ stream: true, lastUserText: "<system-reminder>x</system-reminder>\ngo", toolRounds: 1, toolResults: [{ name: "Bash", text: "ok" }] });

    const chat = normalize("chat", "/v1/chat/completions", {
      model: "m",
      tools: [{ type: "function", function: { name: "bash" } }],
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "go" },
        { role: "assistant", content: null, tool_calls: [{ id: "k1", function: { name: "bash", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "k1", content: "out" },
      ],
    });
    expect(chat).toMatchObject({ tools: ["bash"], transcript: "go\nout", toolRounds: 1, toolResults: [{ name: "bash" }] });

    const gemini = normalize("gemini", "/v1beta/models/gemini-2.5-flash:streamGenerateContent", {
      tools: [{ functionDeclarations: [{ name: "run_shell_command" }] }],
      generationConfig: { responseMimeType: "application/json" },
      contents: [
        { role: "user", parts: [{ text: "go" }] },
        { role: "model", parts: [{ functionCall: { id: "g1", name: "run_shell_command", args: {} } }] },
        { role: "user", parts: [{ functionResponse: { id: "g1", name: "run_shell_command", response: { output: "fine" } } }] },
      ],
    });
    expect(gemini).toMatchObject({ model: "gemini-2.5-flash", stream: true, wantsJson: true, toolRounds: 1, toolResults: [{ name: "run_shell_command", text: '{"output":"fine"}' }] });
  });
});

describe("startFakeModel", () => {
  it("streams a Responses function call with usage", async () => {
    fake = await startFakeModel(() => ({ kind: "tool", name: "shell_command", args: { command: "echo hi" } }));
    const evs = await events(await post("/v1/responses", { model: "m", input: "hi" }));
    expect(evs.map((e) => e.event)).toEqual(["response.created", "response.output_item.added", "response.output_item.done", "response.completed"]);
    const done = evs.at(-1)!.data as { response: { output: Array<{ name: string; arguments: string }>; usage: { input_tokens: number } } };
    expect(done.response.output[0]).toMatchObject({ name: "shell_command", arguments: '{"command":"echo hi"}' });
    expect(done.response.usage.input_tokens).toBe(USAGE.input);
    expect(fake.requests).toHaveLength(1);
  });

  it("streams Anthropic text and tool_use blocks, and counts tokens", async () => {
    fake = await startFakeModel(() => ({ kind: "tool", name: "Bash", args: { command: "ls" }, text: "Running it." }));
    const evs = await events(await post("/v1/messages?beta=true", { model: "m", stream: true, messages: [{ role: "user", content: "hi" }] }));
    expect(evs.map((e) => e.event)).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_stop", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
    expect(evs[7]!.data).toMatchObject({ delta: { stop_reason: "tool_use" }, usage: { output_tokens: USAGE.output } });
    const counted = (await (await post("/v1/messages/count_tokens", {})).json()) as { input_tokens: number };
    expect(counted.input_tokens).toBe(USAGE.input);
  });

  it("streams chat completion chunks with a usage chunk and [DONE]", async () => {
    fake = await startFakeModel(() => ({ kind: "text", text: "hello" }));
    const evs = await events(await post("/v1/chat/completions", { model: "m", stream: true, messages: [{ role: "user", content: "hi" }] }));
    expect(evs.at(-1)!.data).toBe("[DONE]");
    expect(evs.at(-2)!.data).toMatchObject({ choices: [], usage: { prompt_tokens: USAGE.input } });
    expect(evs.some((e) => JSON.stringify(e.data).includes('"content":"hello"'))).toBe(true);
  });

  it("answers Gemini JSON side requests so the turn ends", async () => {
    fake = await startFakeModel(() => ({ kind: "tool", name: "run_shell_command", args: {} }));
    const res = await post("/v1beta/models/gemini-2.5-flash:generateContent", { contents: [{ role: "user", parts: [{ text: "who speaks next" }] }], generationConfig: { responseMimeType: "application/json" } });
    const body = (await res.json()) as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
    expect(JSON.parse(body.candidates[0]!.content.parts[0]!.text)).toMatchObject({ next_speaker: "user" });
  });

  it("holds a hanging stream open until the server closes, and reports unknown paths", async () => {
    fake = await startFakeModel(() => ({ kind: "hang", text: "working" }));
    const res = await post("/v1/chat/completions", { model: "m", stream: true, messages: [] });
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain("chat.completion.chunk");
    const missing = await post("/v2/whatever", {});
    expect(missing.status).toBe(404);
    expect(fake.unknown).toEqual(["POST /v2/whatever"]);
    await fake.close();
    fake = null;
    await expect(reader.read()).rejects.toThrow();
  });
});
