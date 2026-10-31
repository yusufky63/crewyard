import { describe, expect, it } from "vitest";
import { PROVIDER_MESSAGE_MAX, providerErrorLine, providerErrorRaw, readProviderError } from "./provider-error.ts";

describe("readProviderError", () => {
  it("reads Anthropic's shape with the status from the runner's prefix", () => {
    const raw = 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 210000 tokens > 200000 maximum"}}';
    expect(readProviderError(raw)).toEqual({ status: 400, message: "prompt is too long: 210000 tokens > 200000 maximum" });
  });

  it("reads OpenAI's shape, whose code is a word, not a status", () => {
    const raw = '429 {"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","param":null,"code":"insufficient_quota"}}';
    expect(readProviderError(raw)).toEqual({ status: 429, message: "You exceeded your current quota, please check your plan and billing details." });
  });

  it("reads Google's shape and takes the status from the body when the prefix has none", () => {
    const raw = '[{"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}]';
    expect(readProviderError(raw)).toEqual({ status: 429, message: "Resource has been exhausted (e.g. check quota)." });
  });

  it("reads the Gemini 402 seen in the Tasks row", () => {
    const raw =
      'API Error: 402 {"error":{"code":402,"message":"Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing.","status":"FAILED_PRECONDITION"}}';
    expect(providerErrorLine(raw)).toBe("402 · Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing.");
  });

  it("reads DeepSeek's OpenAI-compatible shape", () => {
    const raw = 'Error: 402 status code (no body) {"error":{"message":"Insufficient Balance","type":"unknown_error","param":null,"code":"invalid_request_error"}}';
    expect(readProviderError(raw)).toEqual({ status: 402, message: "Insufficient Balance" });
  });

  it("prefers OpenRouter's upstream message over its generic one", () => {
    const raw = JSON.stringify({ error: { code: 429, message: "Provider returned error", metadata: { raw: '{"error":{"message":"Rate limit exceeded for model"}}', provider_name: "Chutes" } } });
    expect(readProviderError(raw)).toEqual({ status: 429, message: "Rate limit exceeded for model" });
    expect(readProviderError(JSON.stringify({ error: { code: 402, message: "Insufficient credits" } }))).toEqual({ status: 402, message: "Insufficient credits" });
  });

  it("reads a plain message or detail body", () => {
    expect(readProviderError('status 503 {"message":"Service Unavailable"}')).toEqual({ status: 503, message: "Service Unavailable" });
    expect(readProviderError('{"detail":"Not authenticated"}')).toEqual({ status: null, message: "Not authenticated" });
  });

  it("returns null for text with no body, so the caller shows it as written", () => {
    expect(readProviderError("spawn opencode ENOENT")).toBeNull();
    expect(readProviderError("")).toBeNull();
    expect(readProviderError(null)).toBeNull();
    expect(readProviderError('{"ok":false}')).toBeNull();
    expect(providerErrorLine("spawn opencode   ENOENT\n")).toBe("spawn opencode ENOENT");
  });

  it("reads a message out of truncated JSON", () => {
    const raw = 'API Error: 402 {"error":{"code":402,"message":"Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage yo';
    expect(readProviderError(raw)).toEqual({ status: 402, message: "Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage yo" });
    expect(readProviderError('{"error":{"message":"say \\"hi\\"\\nnow')).toEqual({ status: null, message: 'say "hi" now' });
  });

  it("caps huge input and strips control and bidi characters", () => {
    const raw = `API Error: 500 ${JSON.stringify({ error: { message: `x‮${"a".repeat(200_000)}` } })}`;
    const e = readProviderError(raw);
    expect(e?.status).toBe(500);
    expect(e?.message.length).toBe(PROVIDER_MESSAGE_MAX);
    expect(e?.message.startsWith("xaaa")).toBe(true);
    expect(e?.message.endsWith("…")).toBe(true);
    expect(providerErrorLine("y".repeat(10_000)).length).toBe(PROVIDER_MESSAGE_MAX);
    expect(providerErrorRaw("z".repeat(10_000)).length).toBe(4_000);
  });

  it("keeps markup as plain text", () => {
    expect(providerErrorLine('{"error":{"message":"<img src=x onerror=alert(1)>"}}')).toBe("<img src=x onerror=alert(1)>");
  });
});
