import { CATALOG_RUNNER_KEY, PROFILE_RUNNERS, signInKindFor, usableWith, type CatalogProvider, type CredentialSummary, type ProfileInput, type ProfileRunner } from "@crewyard/core";

// Rules for profiles and aliases. Pure, so the handlers and the tests share one source of truth.

// Aliases become folder names under <dataDir>/profiles/<runner>/<alias>, so they must be safe on
// Windows: no separators, no trailing dot or space, no reserved device names.
const ALIAS = /^[a-z0-9][a-z0-9._-]{0,39}$/i;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

export function checkAlias(alias: string): string {
  const a = alias.trim();
  if (!ALIAS.test(a) || a.endsWith(".") || RESERVED.test(a)) {
    throw new Error("Alias must be 1–40 letters, digits, dots, dashes or underscores, starting with a letter or digit");
  }
  return a;
}

export function checkRunner(runner: string): ProfileRunner {
  const hit = PROFILE_RUNNERS.find((r) => r === runner);
  if (!hit) throw new Error(`Unknown runner: ${runner}`);
  return hit;
}

/**
 * A profile is valid when the catalog says its runner can use the provider without a converter
 * (native, direct or config), the credential belongs to that provider, and the model is listed.
 */
export function validateProfile(input: ProfileInput, provider: CatalogProvider | undefined, credential: CredentialSummary | null): void {
  const runner = checkRunner(input.runner);
  checkAlias(input.alias);
  if (!provider) throw new Error(`Unknown provider: ${input.providerId}`);
  const support = provider.runners[CATALOG_RUNNER_KEY[runner]];
  if (!usableWith(support)) {
    throw new Error(support === "conversion" ? `${provider.name} needs an API format converter for ${runner}, which is not offered yet` : `${runner} cannot use ${provider.name}`);
  }
  if (credential && credential.providerId !== provider.id) throw new Error(`Credential ${credential.alias} belongs to ${credential.providerId}, not ${provider.id}`);
  if (credential && credential.kind === "api_key" && !credential.isSet) throw new Error(`Credential ${credential.alias} has no key yet`);
  const local = provider.group === "local";
  // Claude Code never signs in to claude.ai here (PLAN.md §6): it always runs on a key, except
  // against a local server. Other runners may sign in through their own CLI instead.
  if (!credential && runner === "claude-code" && !local) throw new Error("Claude Code profiles need an API key credential");
  // A non-native route (direct or config) always goes through the provider's key.
  if (!credential && !local && support !== "native") throw new Error(`${runner} reaches ${provider.name} only with an API key`);
  // Own sign-in only where we can start that runner's login for this provider (signInKindFor).
  if (!credential && !local && !signInKindFor(runner, provider.id)) throw new Error(`${runner} has no sign-in of its own for ${provider.name}; add an API key`);
  if (input.defaultModel !== null && provider.models.length > 0 && !provider.models.some((m) => m.id === input.defaultModel)) {
    throw new Error(`${provider.name} has no model ${input.defaultModel}`);
  }
}
