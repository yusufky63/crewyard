import { describe, expect, it } from "vitest";
import { LOG_LINE_MAX, REDACTED, redactLogLine } from "./redact.ts";

// Every sample below is made up and only has the shape of a real credential.
describe("redactLogLine", () => {
  it.each([
    ["Anthropic key", "spawn failed with sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv in env", "sk-ant-api03"],
    ["Anthropic OAuth token", "token sk-ant-oat01-ZyXwVuTsRqPoNmLk refused", "sk-ant-oat01"],
    ["OpenAI project key", "error: Incorrect API key provided: sk-proj-1234567890abcdefghij", "sk-proj-1234"],
    ["GitHub token", "gh said ghp_0123456789abcdefghijABCDEFGHIJ is bad", "ghp_0123"],
    ["GitHub fine-grained token", "github_pat_11ABCDEFG0123456789_abcdefghijklmnop", "github_pat_11"],
    ["Google API key", "key AIzaSyA1234567890abcdefghijklmnopqrstu rejected", "AIzaSyA"],
    ["Google OAuth token", "refreshing ya29.a0AfH6SMBabcdefghijklmnopqrstu", "ya29.a0"],
    ["JWT", "id_token eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl", "eyJhbGci"],
    ["Bearer header", "request had Bearer abcdef1234567890xyz", "abcdef1234"],
    ["Authorization header", "Authorization: Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpw"],
    ["Cookie header", "cookie: session=abc123def456", "abc123def456"],
    ["URL credentials", "cloning https://user:hunter2secret@github.com/acme/app.git", "hunter2secret"],
    ["query token", "GET https://api.example.com/v1?access_token=abc123xyz&page=2", "abc123xyz"],
    ["env assignment", "OPENAI_API_KEY=not-a-real-key-123 node run.js", "not-a-real-key-123"],
    ["quoted env assignment", 'DEEPSEEK_API_KEY="quoted value here"', "quoted value here"],
    ["JSON field", '{"refresh_token":"r-0123456789","user":"me"}', "r-0123456789"],
    ["JSON secret", '{"clientSecret": "c-s-3cr3t"}', "c-s-3cr3t"],
    ["password flag", "login --password=letmein99", "letmein99"],
    ["private key", "-----BEGIN RSA PRIVATE KEY----- MIIEow -----END RSA PRIVATE KEY-----", "MIIEow"],
  ])("hides a %s", (_name, line, secret) => {
    const out = redactLogLine(line);
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED);
  });

  it("keeps the name of the variable so the line still says what failed", () => {
    expect(redactLogLine("GEMINI_API_KEY=abc123 missing scope")).toBe(`GEMINI_API_KEY=${REDACTED} missing scope`);
    expect(redactLogLine('{"apiKey":"k1","model":"x"}')).toBe(`{"apiKey":"${REDACTED}","model":"x"}`);
  });

  it("leaves ordinary lines, counts and commit hashes alone", () => {
    const lines = [
      "2026-10-31T10:00:00.000Z info daemon ready pid=4120",
      "run 7f3c finished: tokens_in=5120 tokens_out=880",
      "checked out 3f786850e387550fdab836ed7e6dc881de23001b",
      "spawned C:\\Program Files\\nodejs\\node.exe with 3 args",
    ];
    for (const l of lines) expect(redactLogLine(l)).toBe(l);
  });

  it("does not redact twice", () => {
    const once = redactLogLine("Authorization: Bearer abcdef1234567890xyz");
    expect(redactLogLine(once)).toBe(once);
  });

  it("caps a runaway line", () => {
    const out = redactLogLine("x".repeat(LOG_LINE_MAX * 5));
    expect(out.length).toBe(LOG_LINE_MAX + 1);
    expect(out.endsWith("…")).toBe(true);
  });
});
