import { run, which } from "@crewyard/proc";

// Reuses the gh CLI sign-in (PLAN.md §10): the token is read once with `gh auth token` and kept in
// memory. It is never written to disk, logged or returned over IPC.

export type GhState = "ok" | "no_gh" | "signed_out";

export function createTokenSource(): { get(): Promise<string | null>; state(): GhState; reset(): void } {
  let token: string | null = null;
  let state: GhState = "signed_out";
  let pending: Promise<string | null> | null = null;

  const read = async (): Promise<string | null> => {
    const gh = await which("gh");
    if (!gh) {
      state = "no_gh";
      return null;
    }
    const res = await run(gh, ["auth", "token", "--hostname", "github.com"], { timeoutMs: 15_000 });
    const value = res.code === 0 ? res.stdout.trim() : "";
    state = value ? "ok" : "signed_out";
    return value || null;
  };

  return {
    async get() {
      if (token) return token;
      pending ??= read().finally(() => (pending = null));
      token = await pending;
      return token;
    },
    state: () => state,
    // After a 401 the next call reads the token again, e.g. once the user ran `gh auth login`.
    reset() {
      token = null;
    },
  };
}
