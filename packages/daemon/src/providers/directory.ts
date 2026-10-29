import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { capabilities as acpCapabilities } from "@crewyard/adapter-acp";
import { capabilities as claudeCapabilities } from "@crewyard/adapter-claude";
import { capabilities as codexCapabilities } from "@crewyard/adapter-codex";
import { capabilities as opencodeCapabilities } from "@crewyard/adapter-opencode";
import { runnerSupport, type AgentCapabilities, type CatalogProvider, type Profile, type ProfileRunner, type ProfileSummary } from "@crewyard/core";
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
  return null;
}

/** Env names the key is exposed under: the provider's own (opencode reads these) plus what each runner expects. */
export function keyNamesFor(runner: ProfileRunner, provider: CatalogProvider | undefined): string[] {
  const names = new Set(provider?.env ?? []);
  if (runner === "claude-code") names.add(provider?.id === "anthropic" ? "ANTHROPIC_API_KEY" : "ANTHROPIC_AUTH_TOKEN");
  if (runner === "codex" && provider?.id === "openai") names.add("OPENAI_API_KEY");
  if (runner === "gemini-cli") names.add("GEMINI_API_KEY");
  return [...names];
}

/**
 * Codex reaches a non-OpenAI provider only through `model_providers` in its config.toml
 * (wire_api "responses"; codex 0.147 rejects "chat"). The profile folder is ours, so the file is
 * rewritten before each run; for OpenAI itself any earlier file is removed.
 */
export function writeCodexConfig(configDir: string, provider: CatalogProvider | undefined): void {
  const file = join(configDir, "config.toml");
  const base = baseUrlFor("codex", provider);
  if (!provider || !base) {
    if (existsSync(file)) rmSync(file, { force: true });
    return;
  }
  const envKey = provider.env[0] ?? `${provider.id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
  const q = (s: string) => JSON.stringify(s);
  const body = [
    "# Managed by Crewyard for this profile; rewritten before each run.",
    `model_provider = ${q(provider.id)}`,
    "",
    `[model_providers.${q(provider.id)}]`,
    `name = ${q(provider.name)}`,
    `base_url = ${q(base)}`,
    `env_key = ${q(envKey)}`,
    `wire_api = "responses"`,
    "",
  ].join("\n");
  mkdirSync(configDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, file);
}

export function providersDirectory(svc: ProvidersService): ProfileDirectory {
  const providerOf = (id: string) => svc.catalog.current().catalog.providers.find((p) => p.id === id);

  const toCandidate = (p: ProfileSummary): Candidate => {
    const provider = providerOf(p.providerId);
    const credential = p.credentialId ? svc.credential(p.credentialId) : null;
    const profile: Profile = {
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
    const support = provider ? runnerSupport(provider, p.runner) : "none";
    const keyReady = !credential || credential.kind === "local" || credential.isSet;
    return {
      profile,
      model: provider?.models.find((m) => m.id === p.defaultModel) ?? null,
      capabilities: CAPABILITIES[p.runner],
      // A provider that needs API-format conversion needs a proxy we do not run; Claude never runs without a key.
      ready: support !== "none" && support !== "conversion" && keyReady && !(p.runner === "claude-code" && !credential),
      // Spend is recorded and capped per API key; local providers have no key to cap.
      credentialId: credential?.kind === "api_key" ? credential.id : null,
      catalogVersion: svc.catalog.current().hash,
    };
  };

  return {
    candidates: () => svc.listProfiles().map(toCandidate),
    async envFor(profileId) {
      const p = svc.listProfiles().find((x) => x.id === profileId);
      if (!p) throw new Error(`Unknown profile: ${profileId}`);
      const provider = providerOf(p.providerId);
      if (p.runner === "codex") writeCodexConfig(p.configDir, provider);
      const secret = p.credentialId ? await svc.secrets.get(p.credentialId) : null;
      if (!secret) return {};
      return Object.fromEntries(keyNamesFor(p.runner, provider).map((name) => [name, secret]));
    },
  };
}
