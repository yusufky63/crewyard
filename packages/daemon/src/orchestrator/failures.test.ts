import { describe, expect, it } from "vitest";
import { classifyFailure, RETRY, retryDelayMs } from "./failures.ts";

describe("classifyFailure", () => {
  it("never hands off a request every provider would refuse", () => {
    for (const status of [400, 405, 406, 413, 414, 415, 422, 501]) {
      expect(classifyFailure(`API Error: ${status} {"type":"error"}`)).toMatchObject({ kind: "request_invalid", status });
    }
    expect(classifyFailure('{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long"}}').kind).toBe("request_invalid");
    expect(classifyFailure("413 Payload Too Large").kind).toBe("request_invalid");
    expect(classifyFailure("codex turn failed: badRequest").kind).toBe("request_invalid");
  });

  it("reads transient, auth and unknown failures and the Retry-After that came with them", () => {
    expect(classifyFailure("HTTP status 503 Service Unavailable, retry-after: 12")).toEqual({ kind: "transient", status: 503, retryAfterMs: 12_000 });
    expect(classifyFailure('error_status=429 "retry_after_ms": 1500')).toMatchObject({ kind: "transient", status: 429 });
    expect(classifyFailure("Retry-After: 250ms, 429 Too Many Requests").retryAfterMs).toBe(250);
    expect(classifyFailure("overloaded_error").kind).toBe("transient");
    expect(classifyFailure("connect ETIMEDOUT 1.2.3.4:443").kind).toBe("transient");
    expect(classifyFailure("API Error: 401 authentication_error")).toMatchObject({ kind: "auth", status: 401 });
    expect(classifyFailure("boom")).toEqual({ kind: "other", status: null, retryAfterMs: null });
    expect(classifyFailure(null).kind).toBe("other");
    // A bare number is not a status: an exit code or a token count must not read as one.
    expect(classifyFailure("opencode exited (400): done in 413 ms").kind).toBe("other");
  });

  it("reads an empty prepaid balance as a credit stop, never as a crash or a hiccup", () => {
    // Gemini's 402 from the live run, DeepSeek's balance error and OpenAI's quota error (sent as a 429).
    expect(classifyFailure('API Error: 402 {"error":{"code":402,"message":"Your prepayment credits are depleted.","status":"PAYMENT_REQUIRED"}}')).toEqual({ kind: "credit", status: 402, retryAfterMs: null });
    expect(classifyFailure("HTTP status 402 Insufficient Balance").kind).toBe("credit");
    expect(classifyFailure('status: 429 {"error":{"type":"insufficient_quota","message":"You exceeded your current quota"}} retry-after: 5')).toEqual({ kind: "credit", status: 429, retryAfterMs: null });
    expect(classifyFailure("Your credit balance is too low to access the API").kind).toBe("credit");
  });
});

describe("retryDelayMs", () => {
  it("backs off exponentially with jitter under a cap", () => {
    expect(retryDelayMs(1, null, () => 0)).toBe(RETRY.baseMs / 2);
    expect(retryDelayMs(1, null, () => 1)).toBe(RETRY.baseMs);
    expect(retryDelayMs(3, null, () => 1)).toBe(RETRY.baseMs * 4);
    expect(retryDelayMs(30, null, () => 1)).toBe(RETRY.capMs);
    const spread = new Set([0.1, 0.5, 0.9].map((r) => retryDelayMs(2, null, () => r)));
    expect(spread.size).toBe(3);
  });

  it("honours Retry-After only between 1 and 60 seconds", () => {
    expect(retryDelayMs(1, 30_000, () => 0)).toBe(30_000);
    expect(retryDelayMs(1, 60_000, () => 0)).toBe(60_000);
    // Under a second: our own backoff, so a zero header cannot make us hammer the provider.
    expect(retryDelayMs(1, 200, () => 0)).toBe(RETRY.baseMs / 2);
    // Longer than a minute is a limit, not a hiccup: do not hold the step, move on.
    expect(retryDelayMs(1, 3_600_000, () => 0)).toBeNull();
  });
});
