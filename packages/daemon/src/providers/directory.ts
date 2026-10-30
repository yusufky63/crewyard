import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { capabilities as acpCapabilities } from "@crewyard/adapter-acp";
import { capabilities as claudeCapabilities } from "@crewyard/adapter-claude";
import { capabilities as codexCapabilities } from "@crewyard/adapter-codex";
import { capabilities as opencodeCapabilities } from "@crewyard/adapter-opencode";
import { effortSupport, runnerSupport, type AgentCapabilities, type CatalogProvider, type EffortLevel, type Profile, type ProfileRunner, type ProfileSummary } from "@crewyard/core";
import type { Candidate, ProfileDirectory } from "../orchestrator/directory.ts";
import type { ProvidersService } from "./service.ts";

// Turns the providers area's profiles and keys into what the orchestrator runs (PLAN.md D9):
// a candidate per profile for crew proposals, and the env for one run. Keys are decrypted only
// inside envFor and handed straight to the adapter; nothing here logs or stores them.

const CAPABILITIES: Record<ProfileRunner, AgentCapabilities> = {
  "claude-code": claudeCapabilities,
  codex: codexCapabilities,
  opencode: opencodeCapabilities,
  "gemini-cli": acpCapabilities,
};

/** The base URL the runner must call when the provider is not the runner's own vendor. */
export function baseUrlFor(runner: ProfileRunner, provider: CatalogProvider | undefined): string | null {
  if (!provider) return null;
  if (runner === "claude-code") return provider.id === "anthropic" ? null : provider.anthropicBase;
  if (runner === "codex") return provider.id === "openai" ? null : provider.openaiBase;
  // OpenCode ships every models.dev provider; one marked "config" needs a provider block with this base.
  if (runner === "opencode") return provider.runners.opencode === "config" ? provider.openaiBase : null;
  return null;
}

/**
 * The one env name each runner reads the key from, and nothing more: every extra name is one more
 * copy an agent's shell could see (PLAN.md §6). Claude Code reads only its Anthropic names, Codex
 * the `env_key` of the provider block we write, OpenCode the provider's first models.dev name, and
 * Gemini CLI GEMINI_API_KEY.
 */
export function keyNamesFor(runner: ProfileRunner, provider: CatalogProvider | undefined): string[] {
  if (runner === "claude-code") return [provider?.id === "anthropic" ? "ANTHROPIC_API_KEY" : "ANTHROPIC_AUTH_TOKEN"];
  if (runner === "codex") return provider ? [codexEnvKey(provider)] : [];
  if (runner === "gemini-cli") return ["GEMINI_API_KEY"];
  const own = provider?.env[0];
  return own ? [own] : [];
}

/** OpenAI's own Responses endpoint, for an OpenAI profile that brings an API key. */
export const OPENAI_API_BASE = "https://api.openai.com/v1";
/**
 * codex 0.147's built-in `openai` provider has no env_key and app-server ignores OPENAI_API_KEY, so
 * a keyed OpenAI profile gets a provider block of its own. It cannot be named `openai`: codex keeps
 * the built-in and drops a user entry with that id.
 */
export const CODEX_OPENAI_KEY_PROVIDER = "openai-api-key";

export function codexEnvKey(provider: CatalogProvider): string {
  if (provider.id === "openai") return "OPENAI_API_KEY";
  return provider.env[0] ?? `${provider.id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}

/**
 * Codex reaches a non-OpenAI provider only through `model_providers` in its config.toml
 * (wire_api "responses"; codex 0.147 rejects "chat"). The profile folder is ours, so the file is
 * rewritten before each run. An OpenAI profile with a key gets its own provider block too; one
 * that signs in with ChatGPT (no key) stays on the built-in provider.
 *
 * Every profile also gets a shell_environment_policy: codex 0.147 defaults to
 * `ignore_default_excludes = true`, so the agent's commands inherit the key. With false, codex
 * drops every name matching *KEY*, *SECRET* or *TOKEN* from them, and `exclude` names the key
 * variables outright. That also keeps the key out of `logs_2.sqlite`, where codex logs each
 * spawned command's environment at TRACE and has no setting to lower that level.
 */
export function writeCodexConfig(configDir: string, provider: CatalogProvider | undefined, effort: EffortLevel | null = null, hasKey = true): void {
  const file = join(configDir, "config.toml");
  const reasoning = effort && provider && effortSupport("codex", provider.id) === "config" ? effort : null;
  const q = (s: string) => JSON.stringify(s);
  const block = provider ? codexProviderBlock(provider, hasKey) : null;
  const excluded = [...new Set([...(provider ? [codexEnvKey(provider)] : []), "OPENAI_API_KEY", "CODEX_API_KEY"])];
  // Top-level keys first: anything after a [table] header belongs to that table.
  const body = [
    "# Managed by Crewyard for this profile; rewritten before each run.",
    ...(reasoning ? [`model_reasoning_effort = ${q(reasoning)}`] : []),
    ...(block ? [`model_provider = ${q(block.id)}`] : []),
    "",
    "[shell_environment_policy]",
    'inherit = "all"',
    "ignore_default_excludes = false",
    `exclude = [${excluded.map(q).join(", ")}]`,
    ...(block
      ? ["", `[model_providers.${q(block.id)}]`, `name = ${q(block.name)}`, `base_url = ${q(block.base)}`, `env_key = ${q(block.envKey)}`, `wire_api = "responses"`]
      : []),
    "",
  ].join("\n");
  mkdirSync(configDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, file);
}

function codexProviderBlock(provider: CatalogProvider, hasKey: boolean): { id: string; name: string; base: string; envKey: string } | null {
  if (provider.id === "openai") return hasKey ? { id: CODEX_OPENAI_KEY_PROVIDER, name: `${provider.name} (API key)`, base: OPENAI_API_BASE, envKey: codexEnvKey(provider) } : null;
  const base = baseUrlFor("codex", provider);
  return base ? { id: provider.id, name: provider.name, base, envKey: codexEnvKey(provider) } : null;
}

/**
 * Env for a profile's presets, apart from its key: the effort level where the runner reads it
 * from env, and Claude Code's haiku, sonnet and opus slots on an Anthropic-compatible provider.
 * The Claude adapter fills slots left empty here with the run's own model.
 */
export function presetEnv(p: Pick<ProfileSummary, "runner" | "providerId" | "effort" | "modelSlots">, provider: CatalogProvider | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  if (p.effort && effortSupport(p.runner, p.providerId) === "env") env.CLAUDE_CODE_EFFORT_LEVEL = p.effort;
  if (p.runner === "claude-code" && p.modelSlots && baseUrlFor("claude-code", provider)) {
    const { haiku, sonnet, opus } = p.modelSlots;
    if (haiku) {
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = haiku;
      // Older Claude Code builds read the small, fast model from this name instead.
      env.ANTHROPIC_SMALL_FAST_MODEL = haiku;
    }
    if (sonnet) env.ANTHROPIC_DEFAULT_SONNET_MODEL = sonnet;
    if (opus) env.ANTHROPIC_DEFAULT_OPUS_MODEL = opus;
  }
  return env;
}

/** The adapter-facing profile for a stored one; shared by runs and the sign-in flows. */
export function profileFor(svc: ProvidersService, p: ProfileSummary): Profile {
  const provider = svc.catalog.current().catalog.providers.find((x) => x.id === p.providerId);
  const credential = p.credentialId ? svc.credential(p.credentialId) : null;
  return {
    id: p.id,
    alias: p.alias,
    runner: p.runner,
    providerId: p.providerId,
    // No credential means the runner signs in on its own (ChatGPT, Google); never claude.ai (PLAN.md §6).
    credential: credential ? { kind: credential.kind, secretRef: credential.isSet ? credential.id : null } : { kind: "plan_signin", secretRef: null },
    defaultModel: p.defaultModel,
    configDir: p.configDir,
    baseUrl: baseUrlFor(p.runner, provider),
  };
}

export function providersDirectory(svc: ProvidersService): ProfileDirectory {
  const providerOf = (id: string) => svc.catalog.current().catalog.providers.find((p) => p.id === id);
  // A sign-in profile whose last probe found it signed out, or its CLI too old, cannot run yet.
  // Never probed stays ready: the first run tells, as before sign-in probes existed.
  const signedIn = (p: ProfileSummary) => {
    const s = p.credentialId === null ? svc.signInStatus(p.id) : null;
    return !s || s.state === "signed_in" || s.state === "unknown";
  };

  const toCandidate = (p: ProfileSummary): Candidate => {
    const provider = providerOf(p.providerId);
    const credential = p.credentialId ? svc.credential(p.credentialId) : null;
    const profile = profileFor(svc, p);
    const support = provider ? runnerSupport(provider, p.runner) : "none";
    const keyReady = !credential || credential.kind === "local" || credential.isSet;
    // The last key check lists what this key can call; a model it left out is never proposed (B14).
    const listed = credential ? svc.discoveredModels(credential.id) : [];
    const modelUsable = !p.defaultModel || listed.length === 0 || listed.includes(p.defaultModel);
    return {
      profile,
      model: provider?.models.find((m) => m.id === p.defaultModel) ?? null,
      capabilities: CAPABILITIES[p.runner],
      // A provider that needs API-format conversion needs a proxy we do not run; Claude never runs without a key.
      ready: support !== "none" && support !== "conversion" && keyReady && modelUsable && signedIn(p) && !(p.runner === "claude-code" && !credential),
      // Spend is recorded and capped per API key; local providers have no key to cap.
      credentialId: credential?.kind === "api_key" ? credential.id : null,
      catalogVersion: svc.catalog.current().hash,
      note: p.note,
      readOnly: p.readOnly,
    };
  };

  return {
    candidates: () => svc.listProfiles().map(toCandidate),
    async envFor(profileId) {
      const p = svc.listProfiles().find((x) => x.id === profileId);
      if (!p) throw new Error(`Unknown profile: ${profileId}`);
      const provider = providerOf(p.providerId);
      if (p.runner === "codex") writeCodexConfig(p.configDir, provider, p.effort, p.credentialId !== null);
      const presets = presetEnv(p, provider);
      const secret = p.credentialId ? await svc.secrets.get(p.credentialId) : null;
      if (!secret) return presets;
      return { ...presets, ...Object.fromEntries(keyNamesFor(p.runner, provider).map((name) => [name, secret])) };
    },
  };
}
