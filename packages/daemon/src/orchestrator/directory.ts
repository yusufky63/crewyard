import type { AgentCapabilities, CatalogModel, PeakPricing, Profile, RequestPricing } from "@crewyard/core";

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
  /** The credential (API key) this profile spends on; spend is recorded and capped per credential. */
  credentialId?: string | null;
  /** Hash of the catalog snapshot `model` prices came from, stored with estimated spend. */
  catalogVersion?: string | null;
  /** The provider's peak-hour pricing; estimates multiply `model` prices by its factor inside a window. */
  peak?: PeakPricing | null;
  /** The provider's price for the web searches and page fetches its server runs, billed apart from tokens. */
  requests?: RequestPricing | null;
  /** The profile's "when to use" note for the crew proposal's reason; never sent to an agent. */
  note?: string | null;
  /** Profile preset: offered only for roles that never write. */
  readOnly?: boolean;
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
