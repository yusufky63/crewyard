import type { AccountSwitchSkipped, AccountSwitchSource, AccountSwitchTrigger, CostEstimate, Headroom } from "@crewyard/core";
import { useDaemon } from "../../ipc.ts";
import { ProvBadge } from "../providers/shared.tsx";
import { FIXTURE } from "./fixture.ts";
import { useFormat } from "./parts.tsx";

// What a same-provider account switch was about (docs/adr/0009): what stopped the source, what the
// target had left and what the step costs there, and who was passed over and why. Every number
// carries its Reported, Estimated or Unknown label. Shared by the Inbox entry and the timeline.

export interface SwitchFactsProps {
  runner: string;
  trigger: AccountSwitchTrigger;
  from: { alias: string };
  to: { alias: string } | null;
  source: AccountSwitchSource;
  headroom: Headroom | null;
  estimate: CostEstimate | null;
  skipped: AccountSwitchSkipped[];
}

export function SwitchFacts(p: SwitchFactsProps) {
  const f = useFormat();
  const t = f.t;
  const name = (alias: string) => `${f.runner(p.runner)} · ${alias}`;
  const from = name(p.from.alias);
  const trigger = t(`accountSwitch.trigger.${p.trigger}`);
  const s = p.source;
  const sourceText = s.cap
    ? t("accountSwitch.sourceCap", { from, trigger, spent: f.usd(s.cap.spentUsd), cap: f.usd(s.cap.capUsd) })
    : s.usedPct !== null && s.window
      ? t("accountSwitch.sourceWindow", { from, trigger, window: f.window(s.window), pct: s.usedPct })
      : t("accountSwitch.source", { from, trigger });
  const e = p.estimate;
  return (
    <span className="sw-facts">
      <span className="sw-line">
        {sourceText} <ProvBadge value={s.provenance} />
      </span>
      {p.to && p.headroom && (
        <span className="sw-line">
          {p.headroom.pct === null ? t("accountSwitch.targetUnknown", { to: name(p.to.alias) }) : t("accountSwitch.target", { to: name(p.to.alias), pct: Math.round(p.headroom.pct), window: f.window(p.headroom.window) })}{" "}
          <ProvBadge value={p.headroom.provenance} />
          {e && (
            <>
              {" · "}
              {e.usd === null ? t("accountSwitch.estimateUnknown") : e.usd === 0 ? t("accountSwitch.noCost") : t("accountSwitch.estimate", { usd: f.usd(e.usd) })} <ProvBadge value={e.provenance} />
            </>
          )}
        </span>
      )}
      {p.skipped.length > 0 && (
        <span className="sw-line muted">
          {t("accountSwitch.skipped", { list: p.skipped.map((x) => t("accountSwitch.skippedItem", { alias: x.alias, reason: t(`accountSwitch.refusal.${x.reason}`) })).join(", ") })}
        </span>
      )}
    </span>
  );
}

/** Screenshot runs draw the global switch as on with `accountSwitch=on` (CREWYARD_SHOT_QUERY). */
const SHOT_ON = FIXTURE && new URLSearchParams(location.search).get("accountSwitch") === "on";

/** Whether Settings has same-provider account switching on; only then does a task's own switch matter. */
export function useAccountSwitchOn(): boolean {
  const settings = useDaemon("settings.get", undefined);
  return SHOT_ON || settings.data?.accountSwitch.enabled === true;
}
