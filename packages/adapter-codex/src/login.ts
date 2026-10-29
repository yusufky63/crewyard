import type { Profile } from "@crewyard/core";
import { AppServer, type Launcher } from "./appserver.ts";
import type { AccountLoginCompletedNotification, LoginAccountParams, LoginAccountResponse } from "./protocol/index.ts";

// Sign-in always goes through codex's own login (PLAN.md §6). We hand the UI a URL to open and,
// for the device-code flow, a code to show; codex stores the tokens under the profile's CODEX_HOME.
// We never see them.

export type LoginMode = "chatgpt" | "deviceCode";

export interface LoginSession {
  loginId: string;
  mode: LoginMode;
  /** Open this in the user's browser. */
  url: string;
  /** Device-code flow only: the code the user types after signing in. */
  userCode: string | null;
  /** Settles once: success, failure, cancel, timeout or the app-server exiting. */
  completed: Promise<{ success: boolean; error: string | null }>;
  cancel(): Promise<void>;
}

export interface LoginOptions {
  mode?: LoginMode;
  /** How long to keep the app-server (and its local callback listener) alive. Default 15 minutes. */
  timeoutMs?: number;
  launcher?: Launcher;
}

/**
 * Starts `account/login/start` in an app-server bound to the profile's folder and keeps that
 * process alive until codex reports the outcome. The "chatgpt" mode makes codex listen on a local
 * port for the OAuth callback; "deviceCode" needs no listener.
 */
export async function startLogin(profile: Profile, opts: LoginOptions = {}): Promise<LoginSession> {
  const mode = opts.mode ?? "chatgpt";
  const server = await AppServer.launch(opts.launcher ?? {}, { codexHome: profile.configDir });
  let settle!: (r: { success: boolean; error: string | null }) => void;
  const completed = new Promise<{ success: boolean; error: string | null }>((resolve) => (settle = resolve));
  let loginId: string | null = null;
  let finished = false;
  const finish = (r: { success: boolean; error: string | null }) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    settle(r);
    void server.close();
  };
  const early: AccountLoginCompletedNotification[] = [];
  server.rpc.onNotification((method, params) => {
    if (method !== "account/login/completed") return;
    const p = params as AccountLoginCompletedNotification;
    if (loginId === null) early.push(p);
    else if (p.loginId === null || p.loginId === loginId) finish({ success: p.success, error: p.error });
  });
  server.rpc.onClose(() => finish({ success: false, error: "codex app-server exited before sign-in finished" }));
  const timer = setTimeout(() => {
    if (loginId) void server.rpc.request("account/login/cancel", { loginId }, { timeoutMs: 5_000 }).catch(() => undefined);
    finish({ success: false, error: "sign-in timed out" });
  }, opts.timeoutMs ?? 15 * 60_000);

  try {
    await server.initialize({ experimentalApi: false });
    const params: LoginAccountParams = mode === "chatgpt" ? { type: "chatgpt" } : { type: "chatgptDeviceCode" };
    const res = await server.rpc.request<LoginAccountResponse>("account/login/start", params, { timeoutMs: 60_000 });
    let session: Omit<LoginSession, "completed" | "cancel">;
    if (res.type === "chatgpt") session = { loginId: res.loginId, mode, url: res.authUrl, userCode: null };
    else if (res.type === "chatgptDeviceCode") session = { loginId: res.loginId, mode, url: res.verificationUrl, userCode: res.userCode };
    else throw new Error(`unexpected login response type ${res.type}`);
    loginId = session.loginId;
    for (const p of early.splice(0)) if (p.loginId === null || p.loginId === loginId) finish({ success: p.success, error: p.error });
    return {
      ...session,
      completed,
      cancel: async () => {
        if (finished) return;
        await server.rpc.request("account/login/cancel", { loginId: session.loginId }, { timeoutMs: 5_000 }).catch(() => undefined);
        finish({ success: false, error: "cancelled" });
      },
    };
  } catch (err) {
    finish({ success: false, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
