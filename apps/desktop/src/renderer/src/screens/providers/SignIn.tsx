import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Copy, ExternalLink, LogIn, LogOut, RefreshCw, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@crewyard/ui";
import type { ProfileSummary, SignInSession, SignInStatus } from "@crewyard/core";
import { call } from "../../ipc.ts";
import { useProvidersQuery as useDaemon } from "./data.ts";
import { useWhen } from "./shared.tsx";

// Sign-in for profiles that use the runner's own subscription login (PLAN.md §6). The CLI does the
// whole browser flow; this only starts it, shows where it stands and opens the page codex hands us.

const errorText = (err: unknown) => (err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err));

/** Status of every sign-in profile, and the sessions in flight (polled only while one waits). */
export function useSignIn() {
  const status = useDaemon("providers.signInStatus", undefined);
  const sessions = useDaemon("providers.signInSessions", undefined, {
    refetchInterval: (q) => ((q.state.data ?? []).some((s) => s.state === "starting" || s.state === "waiting") ? 1_500 : false),
  });
  return { status: status.data ?? [], sessions: sessions.data ?? [] };
}

/** "Plus", "Pro", "Team"...; an unknown plan name is shown as codex sent it. */
export function usePlanLabel() {
  const { t } = useTranslation("providers");
  return (plan: string | null) => (plan ? t(`signIn.plan.${plan}`, { defaultValue: plan }) : null);
}

/** One short line: "Signed in · Plus", "Signed out", "Needs an update", "Not checked yet". */
export function SignInBadge({ status }: { status: SignInStatus | undefined }) {
  const { t } = useTranslation("providers");
  const planLabel = usePlanLabel();
  if (!status) return null;
  const cls = status.state === "signed_in" ? "st st-ok" : status.state === "blocked" ? "st st-bad" : status.state === "signed_out" ? "st st-wait" : "st muted";
  const plan = status.state === "signed_in" ? planLabel(status.plan) : null;
  return (
    <span className={cls}>
      {t(`signIn.state.${status.state}`)}
      {plan ? ` · ${plan}` : ""}
    </span>
  );
}

const pending = (s: SignInSession | undefined) => s?.state === "starting" || s?.state === "waiting";

export function SignInControl({ profile, status, session, compact = false }: { profile: ProfileSummary; status: SignInStatus; session: SignInSession | undefined; compact?: boolean }) {
  const { t } = useTranslation("providers");
  const when = useWhen();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const provider = t(`signIn.kind.${status.kind}`);

  const refresh = () => qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("providers.") });
  const act = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  const start = (mode: "browser" | "deviceCode") =>
    act(mode, async () => {
      const s = await call("providers.signInStart", { profileId: profile.id, mode });
      // Codex hands us the page; Gemini CLI opens the browser on its own.
      if (s.state === "waiting" && s.url && !s.browserOpened) window.open(s.url, "_blank", "noopener");
    });
  const signOut = () => {
    if (!window.confirm(t("signIn.signOutConfirm", { alias: profile.alias, provider, path: profile.configDir }))) return;
    void act("signOut", () => call("providers.signOut", { profileId: profile.id }));
  };
  const copy = (text: string) =>
    void navigator.clipboard.writeText(text).then(
      () => setCopied(true),
      () => setCopied(false),
    );

  const waiting = pending(session);
  const checked = status.probedAt ? t("signIn.checked", { time: when.ago(status.probedAt) }) : t("signIn.neverChecked");

  return (
    <div className={`si${compact ? " si-compact" : ""}`}>
      <div className="si-line">
        <SignInBadge status={status} />
        <span className="muted">{checked}</span>
        {status.cliVersion && <span className="muted mono">{t("signIn.version", { version: status.cliVersion })}</span>}
        <div className="end">
          {!waiting && status.state !== "blocked" && status.state !== "signed_in" && (
            <>
              {status.kind === "chatgpt" && (
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void start("deviceCode")}>
                  {t("signIn.deviceCode")}
                </Button>
              )}
              <Button size="sm" tone="ok" disabled={busy !== null} onClick={() => void start("browser")}>
                <LogIn size={14} strokeWidth={1.75} />
                {busy === "browser" ? t("signIn.starting") : t("signIn.start", { provider })}
              </Button>
            </>
          )}
          {!waiting && (
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void act("probe", () => call("providers.signInProbe", { profileId: profile.id }))}>
              <RefreshCw size={14} strokeWidth={1.75} />
              {busy === "probe" ? t("signIn.checking") : t("signIn.check")}
            </Button>
          )}
          {!waiting && status.state === "signed_in" && !compact && (
            <Button size="sm" variant="danger" disabled={busy !== null} onClick={signOut}>
              <LogOut size={14} strokeWidth={1.75} />
              {t("signIn.signOut")}
            </Button>
          )}
        </div>
      </div>

      {status.state === "blocked" && status.update && (
        <div className="si-box" role="status">
          <span>{t("signIn.update", { current: status.update.current ?? t("signIn.unknownVersion"), min: status.update.min })}</span>
          <div className="si-cmd">
            <code className="mono">{status.update.command}</code>
            <Button size="sm" variant="ghost" onClick={() => copy(status.update!.command)} aria-label={t("signIn.copyCommand")}>
              <Copy size={14} strokeWidth={1.75} />
              {copied ? t("signIn.copied") : t("signIn.copy")}
            </Button>
          </div>
          <span className="muted">{t("signIn.updateThen")}</span>
        </div>
      )}
      {status.state === "blocked" && !status.update && status.problem && <p className="pv-error">{status.problem}</p>}
      {status.state !== "blocked" && status.problem && <p className="muted si-note">{status.problem}</p>}

      {waiting && session && (
        <div className="si-box" role="status" aria-live="polite">
          <span>
            {session.state === "starting"
              ? t("signIn.startingRunner", { runner: t(`runner.${profile.runner}`) })
              : session.browserOpened
                ? t("signIn.waitingOpened", { runner: t(`runner.${profile.runner}`), provider })
                : t("signIn.waiting", { provider })}
          </span>
          {session.userCode && (
            <span>
              {t("signIn.code")} <code className="mono si-code">{session.userCode}</code>
            </span>
          )}
          <div className="si-actions">
            {session.url && (
              <Button size="sm" variant="ghost" onClick={() => window.open(session.url!, "_blank", "noopener")}>
                <ExternalLink size={14} strokeWidth={1.75} />
                {t("signIn.openPage")}
              </Button>
            )}
            <Button size="sm" variant="ghost" tone="bad" disabled={busy !== null} onClick={() => void act("cancel", () => call("providers.signInCancel", { profileId: profile.id }))}>
              <X size={14} strokeWidth={1.75} />
              {t("signIn.cancel")}
            </Button>
          </div>
          <span className="muted">{t("signIn.private")}</span>
        </div>
      )}
      {session?.state === "failed" && status.state !== "blocked" && <p className="pv-error">{t("signIn.failed", { message: session.error ?? "" })}</p>}
      {error && <p className="pv-error">{error}</p>}
    </div>
  );
}
