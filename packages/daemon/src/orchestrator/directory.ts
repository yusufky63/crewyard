import type { AgentCapabilities, CatalogModel, Profile } from "@crewyard/core";

// Where crew proposals get their candidates from. The providers work owns profiles, credentials
// and the catalog; it plugs in by calling `orchestratorFor(ctx).setDirectory(...)`. Until then the
// directory is empty and proposals say `no_candidate` instead of inventing profiles.

export interface Candidate {
  profile: Profile;
  /** Catalog entry for the model this profile runs; null when the catalog has no match. */
  model: CatalogModel | null;
  /** From the runner's last probe. */
  capabilities: AgentCapabilities;
  /** Signed in or key present according to the last probe. */
  ready: boolean;
}

export interface ProfileDirectory {
  candidates(projectId: string): Promise<Candidate[]> | Candidate[];
  /** Decrypted env for one run (API keys, config dirs). Never logged or stored by the orchestrator. */
  envFor(profileId: string): Promise<Record<string, string>> | Record<string, string>;
}

export const EMPTY_DIRECTORY: ProfileDirectory = {
  candidates: () => [],
  envFor: () => ({}),
};
