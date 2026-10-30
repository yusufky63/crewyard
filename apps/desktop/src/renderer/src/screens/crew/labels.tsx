import type { ReactNode } from "react";
import { ArrowLeftRight, Check, CircleDashed, CircleHelp, Clock, Gauge, GitPullRequest, Moon, Pause, RotateCcw, Square, SquareTerminal, Users, X, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { RunnerId, TaskStatus } from "@crewyard/core";
import { useFormat } from "../tasks/parts.tsx";
import type { Fact, MemberStatus, NodeLoop } from "./model.ts";

// Status labels follow the mapping table in DESIGN.md §5: an icon and text in the state color.

type Tone = "run" | "wait" | "ok" | "bad" | "rev" | "muted";

const MEMBER: Record<MemberStatus, { tone: Tone; icon: LucideIcon | "spin" }> = {
  proposed: { tone: "rev", icon: Users },
  queued: { tone: "wait", icon: Clock },
  running: { tone: "run", icon: "spin" },
  needs_answer: { tone: "wait", icon: CircleHelp },
  needs_approval: { tone: "wait", icon: SquareTerminal },
  limited: { tone: "bad", icon: Gauge },
  paused: { tone: "muted", icon: Pause },
  hibernated: { tone: "muted", icon: Moon },
  handing_off: { tone: "wait", icon: ArrowLeftRight },
  done: { tone: "ok", icon: Check },
  failed: { tone: "bad", icon: X },
  stopped: { tone: "muted", icon: Square },
  interrupted: { tone: "wait", icon: RotateCcw },
  cancelled: { tone: "muted", icon: Square },
  standby: { tone: "muted", icon: CircleDashed },
};

const TASK: Record<TaskStatus, { tone: Tone; icon: LucideIcon | "spin" }> = {
  proposed: { tone: "rev", icon: Users },
  failed: { tone: "bad", icon: X },
  needs_input: { tone: "wait", icon: CircleHelp },
  limited: { tone: "bad", icon: Gauge },
  handing_off: { tone: "wait", icon: ArrowLeftRight },
  running: { tone: "run", icon: "spin" },
  queued: { tone: "wait", icon: Clock },
  review: { tone: "ok", icon: Check },
  merged: { tone: "rev", icon: GitPullRequest },
  done: { tone: "ok", icon: Check },
  cancelled: { tone: "muted", icon: Square },
};

function Label({ tone, icon, text }: { tone: Tone; icon: LucideIcon | "spin"; text: string }) {
  const Icon = icon === "spin" ? null : icon;
  return (
    <span className={`st st-${tone}`}>
      {Icon ? <Icon size={13} strokeWidth={1.75} aria-hidden="true" /> : <span className="spin" aria-hidden="true" />}
      {text}
    </span>
  );
}

export function MemberStatusLabel({ status }: { status: MemberStatus }) {
  const { t } = useTranslation("crew");
  return <Label {...MEMBER[status]} text={t(`status.${status}`)} />;
}

export function TaskStatusLabel({ status }: { status: TaskStatus }) {
  const { t } = useTranslation("crew");
  return <Label {...TASK[status]} text={t(`taskStatus.${status}`)} />;
}

export const memberTone = (s: MemberStatus) => MEMBER[s].tone;

export interface LoopLabel {
  /** Headline on the node's bottom border: the fix attempt or the verdict. */
  tag: string | null;
  tone: "wait" | "ok" | "bad";
  /** Replaces the node's fact line: why the loop last went on or stopped, or the reviewed commit. */
  fact: string | null;
  stale: boolean;
}

export function useFormatters() {
  const { t, i18n } = useTranslation("crew");
  const tasks = useFormat();
  const compact = new Intl.NumberFormat(i18n.language, { notation: "compact", maximumFractionDigits: 1 });
  const usd = new Intl.NumberFormat(i18n.language, { style: "currency", currency: "USD", maximumFractionDigits: 2, minimumFractionDigits: 2 });
  const time = new Intl.DateTimeFormat(i18n.language, { hour: "2-digit", minute: "2-digit" });

  /** Every cost carries its provenance (AGENTS.md UI rules). */
  const cost = (value: number | null, provenance: "reported" | "estimated" | "unknown") =>
    value === null || provenance === "unknown" ? t("fact.costUnknown") : t(`fact.cost.${provenance}`, { usd: usd.format(value) });

  const fact = (f: Fact): string => {
    switch (f.code) {
      case "usage":
        return t("fact.usage", { tokens: compact.format(f.tokens), cost: cost(f.usd, f.provenance) });
      case "estimate":
        return t("fact.estimate", { cost: cost(f.usd, f.provenance) });
      case "blocked":
        return t(`blocked.${f.reason.code}`, { defaultValue: t("blocked.other"), ...f.reason.params });
      case "after":
        return t("fact.after", { steps: f.steps });
      case "no_candidate":
        return t("fact.noCandidate");
      case "standby_for":
        return f.more > 0 ? t("fact.standbyMore", { step: f.step, count: f.more }) : t("fact.standby", { step: f.step });
      case "branch":
        return f.base ? t("fact.branch", { base: f.base, branch: f.branch }) : f.branch;
      case "kind":
        return t("fact.kind", { kind: t(`kind.${f.kind}`), size: f.size });
      case "queued_messages":
        return t("fact.queuedMessages", { count: f.count });
    }
  };

  const loop = (l: NodeLoop): LoopLabel =>
    l.code === "attempts"
      ? { tag: l.attempt > 0 ? t("loop.attempt", { attempt: l.attempt, max: l.max }) : null, tone: l.tone, fact: l.last ? tasks.reason(l.last) : null, stale: false }
      : { tag: t(`loop.verdict.${l.verdict}`), tone: l.verdict === "pass" ? "ok" : "wait", fact: l.sha ? t("loop.commit", { sha: l.sha }) : t("loop.noCommit"), stale: l.stale };

  /** The fact line as one string, for the list view and tooltips. */
  const loopLine = (l: LoopLabel) => [l.tag, l.fact, l.stale ? t("loop.stale") : null].filter(Boolean).join(" · ");

  return { fact, cost, loop, loopLine, time: (iso: string) => time.format(new Date(iso)) };
}

export function runnerName(t: (k: string) => string, runner: RunnerId | null): string {
  return runner ? t(`runner.${runner}`) : t("runner.none");
}

export function Kbd({ children }: { children: ReactNode }) {
  return <span className="kbd">{children}</span>;
}
