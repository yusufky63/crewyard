import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeftRight, Check, CircleHelp, CircleX, Clock, Gauge, GitPullRequest, Square, Terminal, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CandidateView, LimitWindow, Reason, RoleId } from "@crewyard/core";
import { BrandIcon, Button } from "@crewyard/ui";
import { useMoney, useWhen } from "../providers/shared.tsx";
import { codeKey, type LimitBannerInfo, type StatusIcon, type StatusLine } from "./model.ts";

// Pieces shared by the Tasks screen, the Inbox and the shell inspector.

/** Re-renders every `ms` so elapsed times move on their own; stops when not needed. */
export function useNow(ms: number, active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms, active]);
  return now;
}

export function useFormat() {
  const { t } = useTranslation("tasks");
  const money = useMoney();
  const when = useWhen();
  const role = (r: RoleId | string) => t(`role.${r}`);
  const runner = (r: string) => t(`providers:runner.${r}`, { defaultValue: r });
  const window = (w: LimitWindow | string | null) => (w ? t(`window.${w}`) : t("window.unknown"));
  const usd = (n: number) => money(n, n !== 0 && Math.abs(n) < 0.1 ? 3 : 2);
  /** Reason params carry raw codes (window, provenance, kind, runner); translate them before filling. */
  const reason = (r: Reason) => {
    const p: Record<string, string | number> = { ...(r.params ?? {}) };
    if (typeof p.window === "string") p.window = window(p.window);
    if (typeof p.provenance === "string") p.provenance = t(`providers:provenance.${p.provenance}`);
    if (typeof p.kind === "string") p.kind = t(`kind.${p.kind}`);
    if (typeof p.runner === "string") p.runner = runner(p.runner);
    if (typeof p.usd === "number") p.usd = usd(p.usd);
    if (typeof p.budget === "number") p.budget = usd(p.budget);
    if (typeof p.context === "number") p.context = `${Math.round(p.context / 1000)}k`;
    if (typeof p.needed === "number") p.needed = `${Math.round(p.needed / 1000)}k`;
    return t(`reason.${codeKey(r.code)}`, p);
  };
  return { t, money, usd, when, role, runner, window, reason };
}

/** Runner mark + "Runner · alias", the way every account is named (DESIGN.md "Vendor marks"). */
export function Who({ c, model = true }: { c: Pick<CandidateView, "runner" | "alias" | "model">; model?: boolean }) {
  const f = useFormat();
  return (
    <span className="brand-name">
      <BrandIcon id={c.runner} size={14} />
      <span>
        {f.runner(c.runner)} · {c.alias}
        {model && c.model ? <span className="muted"> · {c.model}</span> : null}
      </span>
    </span>
  );
}

const ICONS: Record<Exclude<StatusIcon, "spinner">, typeof Check> = {
  crew: Users,
  clock: Clock,
  question: CircleHelp,
  terminal: Terminal,
  gauge: Gauge,
  swap: ArrowLeftRight,
  check: Check,
  pr: GitPullRequest,
  x: CircleX,
  square: Square,
};

const TONE_CLASS = { run: "st-run", wait: "st-wait", ok: "st-ok", bad: "st-bad", ink: "st-rev", muted: "muted" } as const;

/** DESIGN.md `StatusLabel`: icon plus text in the state color, never color alone. */
export function StatusLabel({ line }: { line: StatusLine }) {
  const f = useFormat();
  const Icon = line.icon === "spinner" ? null : ICONS[line.icon];
  const text = f.t(`status.${line.key}`, {
    role: line.params.role ? f.role(line.params.role) : "",
    time: line.params.time ? f.when.at(line.params.time) : "",
    target: line.params.target ?? "",
    reason: line.params.reason ? f.t(`endDetail.${line.params.reason}`, { defaultValue: line.params.reason }) : "",
  });
  return (
    <span className={`st ${TONE_CLASS[line.tone]}`}>
      {Icon ? <Icon size={14} strokeWidth={1.75} aria-hidden="true" /> : <span className="spin" aria-hidden="true" />}
      {text}
    </span>
  );
}

/**
 * DESIGN.md `LimitBanner`: amber soft fill, source and reset time, `Hand off now` and `Let it
 * finish`. A reached limit has no "let it finish"; its decision waits in the Inbox.
 */
export function LimitBanner({ info, who, onHandOff, onDismiss, onOpenInbox }: { info: LimitBannerInfo; who: string; onHandOff?: () => void; onDismiss?: () => void; onOpenInbox?: () => void }) {
  const f = useFormat();
  const pct = info.usedPct === null ? null : Math.round(info.usedPct);
  const params = { who, window: f.window(info.window), pct: pct ?? "—", time: info.resetsAt ? f.when.at(info.resetsAt) : "", minutes: info.minutesUntilFull ?? 0 };
  const text =
    info.kind === "reached"
      ? f.t(info.resetsAt ? "banner.reachedResets" : "banner.reached", params)
      : info.kind === "ahead_of_pace"
        ? f.t(info.resetsAt ? "banner.paceResets" : "banner.pace", params)
        : f.t(info.resetsAt ? "banner.nearResets" : "banner.near", params);
  return (
    <div className="banner banner-warn tk-banner" role="status">
      <Gauge size={14} strokeWidth={1.75} aria-hidden="true" />
      <span className="txt">{text}</span>
      <div className="end">
        {info.kind === "reached" ? (
          onOpenInbox && (
            <Button size="sm" onClick={onOpenInbox}>
              {f.t("banner.decide")}
            </Button>
          )
        ) : (
          <>
            {onDismiss && (
              <Button size="sm" variant="ghost" onClick={onDismiss}>
                {f.t("banner.letFinish")}
              </Button>
            )}
            {onHandOff && info.target && (
              <Button size="sm" onClick={onHandOff} title={f.t("banner.handOffTitle", { target: `${f.runner(info.target.runner)} · ${info.target.alias}` })}>
                <ArrowLeftRight size={14} strokeWidth={1.75} aria-hidden="true" />
                {f.t("banner.handOff")}
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Destructive actions confirm in place and name what they stop (DESIGN.md §7 "Close is not stop").
 * The first click asks, the second acts; Esc or "Keep" backs out.
 */
export function ConfirmButton({ label, confirm, onConfirm, disabled, size = "sm" }: { label: string; confirm: string; onConfirm: () => void | Promise<unknown>; disabled?: boolean; size?: "sm" | "md" }) {
  const { t } = useTranslation("tasks");
  const [asking, setAsking] = useState(false);
  if (!asking)
    return (
      <Button size={size} variant="danger" disabled={disabled} onClick={() => setAsking(true)}>
        {label}
      </Button>
    );
  return (
    <span className="tk-confirm" onKeyDown={(e) => e.key === "Escape" && setAsking(false)}>
      <span className="sec">{confirm}</span>
      <Button size={size} variant="ghost" onClick={() => setAsking(false)}>
        {t("action.keep")}
      </Button>
      <Button
        size={size}
        variant="danger"
        autoFocus
        onClick={() => {
          setAsking(false);
          void onConfirm();
        }}
      >
        {t("action.confirmStop")}
      </Button>
    </span>
  );
}

export function ErrorLine({ children }: { children: ReactNode }) {
  return children ? (
    <p className="tk-error" role="alert">
      {children}
    </p>
  ) : null;
}
