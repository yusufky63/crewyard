import type { Profile } from "@crewyard/core";
import { resolveBin } from "@crewyard/proc";
import { withAppServer, type Launcher } from "./appserver.ts";
import type { GetAccountResponse } from "./protocol/index.ts";

// Account state for the accounts UI, through codex's own `account/read` and `account/logout`.
// Only the account type and plan leave this module: codex also returns the account email, which
// the app does not show (PLAN.md §6: alias, runner, plan label, probe time).

export interface CodexAccount {
  /** codex-cli version from the initialize handshake. */
  version: string | null;
  /** "chatgpt" is a subscription sign-in; "apiKey" and "amazonBedrock" bring their own key. */
  kind: "chatgpt" | "apiKey" | "amazonBedrock" | "none";
  /** ChatGPT plan as codex names it ("plus", "pro", "team"...); null for other kinds. */
  plan: string | null;
  /** codex says this folder needs an OpenAI sign-in before it can run. */
  requiresOpenaiAuth: boolean;
}

export async function readAccount(profile: Pick<Profile, "configDir">, launcher: Launcher = {}): Promise<CodexAccount> {
  const command = launcher.command ?? (await resolveBin("codex"));
  if (!command) throw new Error("codex is not installed or not on PATH");
  return withAppServer({ ...launcher, command }, { codexHome: profile.configDir }, async (server) => {
    const res = await server.rpc.request<GetAccountResponse>("account/read", { refreshToken: false }, { timeoutMs: 30_000 });
    const account = res.account;
    return {
      version: server.cliVersion,
      kind: account?.type ?? "none",
      plan: account?.type === "chatgpt" && account.planType !== "unknown" ? account.planType : null,
      requiresOpenaiAuth: res.requiresOpenaiAuth,
    };
  });
}

/**
 * Lets codex remove its own credentials for this folder (file or OS keyring, whichever it used),
 * so nothing is left behind once the caller deletes the folder.
 */
export async function logout(profile: Pick<Profile, "configDir">, launcher: Launcher = {}): Promise<void> {
  const command = launcher.command ?? (await resolveBin("codex"));
  if (!command) throw new Error("codex is not installed or not on PATH");
  await withAppServer({ ...launcher, command }, { codexHome: profile.configDir }, async (server) => {
    await server.rpc.request("account/logout", undefined, { timeoutMs: 30_000 });
  });
}
