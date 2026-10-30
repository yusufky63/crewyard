import type { Profile } from "@crewyard/core";
import { describe, expect, it } from "vitest";
import { WINDOWS_SYSTEM_VARS } from "@crewyard/proc";
import { buildEnv, redact } from "./env.ts";

const anthropic: Profile = {
  id: "p1",
  alias: "Claude · work",
  runner: "claude-code",
  providerId: "anthropic",
  credential: { kind: "api_key", secretRef: "work" },
  defaultModel: null,
  configDir: "C:\\Users\\Test User\\AppData\\Roaming\\Crewyard\\profiles\\claude-code\\work",
  baseUrl: null,
};
const deepseek: Profile = { ...anthropic, providerId: "deepseek", baseUrl: "https://api.deepseek.com/anthropic", defaultModel: "deepseek-v4" };
const inherited = {
  Path: "C:\\Program Files\\nodejs",
  ANTHROPIC_API_KEY: "from-parent",
  Anthropic_Auth_Token: "mixed-case-from-parent",
  CLAUDE_CONFIG_DIR: "C:\\Users\\Test User\\.claude",
  CLAUDE_CODE_OAUTH_TOKEN: "oauth-from-parent",
  CLAUDE_CODE_USE_BEDROCK: "1",
  CLAUDECODE: "1",
  CLAUDE_CODE_GIT_BASH_PATH: "C:\\Program Files\\Git\\bin\\bash.exe",
};

describe("buildEnv", () => {
  it("drops inherited account and provider variables, keeps the rest, and sets the profile folder", () => {
    const { env } = buildEnv(anthropic, { ANTHROPIC_API_KEY: "sk-ant-own-key-123" }, null, inherited);
    expect(env).toEqual({
      Path: "C:\\Program Files\\nodejs",
      CLAUDE_CODE_GIT_BASH_PATH: "C:\\Program Files\\Git\\bin\\bash.exe",
      CLAUDE_CONFIG_DIR: anthropic.configDir,
      CLAUDE_AGENT_SDK_CLIENT_APP: "crewyard/0.1.0",
      ANTHROPIC_API_KEY: "sk-ant-own-key-123",
    });
  });

  it("gives Anthropic-compatible providers a bearer token, the base URL and every model slot", () => {
    const { env, secrets } = buildEnv(deepseek, { ANTHROPIC_API_KEY: "sk-deepseek-key-1", ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-v4-flash" }, null, inherited);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: "sk-deepseek-key-1",
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_MODEL: "deepseek-v4",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-v4",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v4",
      // An explicit slot from the profile wins over the chosen model.
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-v4-flash",
    });
    expect(secrets).toContain("sk-deepseek-key-1");
  });

  it("sets no key at all for a local provider that has none", () => {
    const { env } = buildEnv({ ...deepseek, credential: { kind: "local", secretRef: null }, baseUrl: "http://127.0.0.1:11434" }, {}, "qwen3-coder", inherited);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_MODEL).toBe("qwen3-coder");
  });
});

describe("redact", () => {
  it("replaces every occurrence of every secret", () => {
    expect(redact("key sk-1234567890 and again sk-1234567890", ["sk-1234567890"])).toBe("key [redacted] and again [redacted]");
  });
});

describe("Windows system variables", () => {
  it("reach the child once each, whatever their spelling in the parent", () => {
    const parent = { ...inherited, SystemRoot: "C:\\Windows", SystemDrive: "C:", ProgramData: "C:\\ProgramData", windir: "C:\\Windows", TEMP: "C:\\T", TMP: "C:\\T", USERPROFILE: "C:\\Users\\Test User", APPDATA: "C:\\A", LOCALAPPDATA: "C:\\L", PATHEXT: ".EXE;.CMD", ComSpec: "C:\\Windows\\system32\\cmd.exe" };
    const { env } = buildEnv(deepseek, { ANTHROPIC_AUTH_TOKEN: "sk-deepseek-123456" }, null, parent);
    for (const name of WINDOWS_SYSTEM_VARS) expect(Object.keys(env).filter((k) => k.toUpperCase() === name.toUpperCase()), name).toHaveLength(1);
    expect(env.Path).toBe(parent.Path);
    expect(env.ComSpec).toBe(parent.ComSpec);
  });
});
