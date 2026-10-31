import { isAbsolute } from "node:path";

// End-to-end mode (apps/desktop/e2e): CREWYARD_E2E=1 swaps the daemon's runners for scripted
// fakes and CREWYARD_E2E_PROFILE points userData at a folder the test creates and removes.
// A packaged build refuses it: the variables are deleted before the daemon inherits the env, so
// an installed app can never be started against fake profiles.

// CREWYARD_E2E_HOME stands in for your home folder when discovering agent files (docs/adr/0015).
export const E2E_VARS = ["CREWYARD_E2E", "CREWYARD_E2E_SCRIPT", "CREWYARD_E2E_PROFILE", "CREWYARD_E2E_HOME"] as const;

export type E2eMode = { enabled: false; refused: boolean } | { enabled: true; refused: false; profile: string };

export function e2eMode(env: NodeJS.ProcessEnv, packaged: boolean): E2eMode {
  const requested = E2E_VARS.some((k) => env[k] !== undefined);
  if (packaged) {
    for (const k of E2E_VARS) delete env[k];
    return { enabled: false, refused: requested };
  }
  if (env.CREWYARD_E2E !== "1") return { enabled: false, refused: false };
  const profile = env.CREWYARD_E2E_PROFILE;
  if (!profile || !isAbsolute(profile)) throw new Error("CREWYARD_E2E_PROFILE must be an absolute path");
  return { enabled: true, refused: false, profile };
}
