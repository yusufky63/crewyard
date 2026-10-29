import type { Profile } from "@crewyard/core";

// The SDK `env` option replaces the child's whole environment, so we build it ourselves:
// inherited variables minus anything that could pick another account or provider, then the
// profile's folder and key. Keys only ever travel here, never on a command line.

/** Inherited variables that would override the profile's account, provider or nesting state. */
const STRIPPED = [
  /^ANTHROPIC_/,
  /^CLAUDE_CONFIG_DIR$/,
  /^CLAUDE_CODE_OAUTH_TOKEN$/,
  /^CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY)$/,
  // Set when Crewyard itself was started from a Claude Code session; the child is not nested.
  /^CLAUDECODE$/,
  /^CLAUDE_CODE_ENTRYPOINT$/,
  /^CLAUDE_CODE_SSE_PORT$/,
];

/** Model slots Claude Code reads for background and subagent calls (same set as cc-switch presets). */
const MODEL_SLOTS = ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_SMALL_FAST_MODEL"];

export const CLIENT_APP = "crewyard/0.1.0";

export interface ChildEnv {
  env: Record<string, string>;
  /** Secret values placed in env, so callers can scrub them from error text. */
  secrets: string[];
}

/**
 * `secrets` is StartRequest.env: the key arrives as ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN
 * (either name works). Anthropic itself gets ANTHROPIC_API_KEY; a profile with a base URL is an
 * Anthropic-compatible provider and gets ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL, because
 * those providers expect a bearer token. Other entries (model slot overrides) pass through.
 */
export function buildEnv(profile: Profile, secrets: Record<string, string>, model: string | null, inherited: NodeJS.ProcessEnv = process.env): ChildEnv {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(inherited)) {
    if (value === undefined) continue;
    // Windows env names are case-insensitive, so compare upper-cased.
    if (STRIPPED.some((re) => re.test(name.toUpperCase()))) continue;
    env[name] = value;
  }

  const { ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ...rest } = secrets;
  const key = ANTHROPIC_API_KEY ?? ANTHROPIC_AUTH_TOKEN ?? null;
  Object.assign(env, rest);
  env.CLAUDE_CONFIG_DIR = profile.configDir;
  env.CLAUDE_AGENT_SDK_CLIENT_APP = CLIENT_APP;

  if (profile.baseUrl) {
    env.ANTHROPIC_BASE_URL = profile.baseUrl;
    if (key) env.ANTHROPIC_AUTH_TOKEN = key;
    // A third-party endpoint does not know Claude model ids, so every slot points at the chosen model.
    const chosen = model ?? profile.defaultModel;
    if (chosen) for (const slot of MODEL_SLOTS) env[slot] ??= chosen;
  } else if (key) {
    env.ANTHROPIC_API_KEY = key;
  }

  return { env, secrets: Object.values(secrets).filter((v) => v.length >= 8) };
}

/** Replaces every secret value in a string; used on error text and stderr before it leaves the adapter. */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join("[redacted]");
  return out;
}
