import { useEffect, useRef } from "react";
import { Shuffle } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AccountSwitchView } from "@crewyard/core";
import { BrandIcon, Button, Panel } from "@crewyard/ui";
import { useInspector } from "../../inspector.ts";
import { SwitchFacts } from "../tasks/AccountSwitch.tsx";
import { act, useWork } from "../tasks/data.ts";
import { FIXTURE } from "../tasks/fixture.ts";
import { useFormat } from "../tasks/parts.tsx";

// Automatic switches to another account of the same provider (docs/adr/0009). Nothing waits on you
// here: each entry says what happened, with its labels, until you dismiss it. "Off for this task"
// holds the task out of further switches; the global switch is in Settings.

/** Screenshot runs: `inbox=switches` scrolls this section into view (CREWYARD_SHOT_QUERY). */
const SHOT = FIXTURE && new URLSearchParams(location.search).get("inbox") === "switches";

/** The project's switches; `switches.changed` refreshes them from useWorkLive, which is always mounted. */
export function useSwitches(projectId: string) {
  return useWork("switches.list", { projectId });
}

function SwitchItem({ s, onError }: { s: AccountSwitchView; onError: (err: unknown) => void }) {
  const { t } = useTranslation("inbox");
  const f = useFormat();
  const inspect = useInspector((x) => x.open);
  const task = useWork("tasks.get", { taskId: s.taskId });
  const go = (fn: () => Promise<unknown>) => void fn().catch(onError);
  const held = task.data?.accountSwitch === false;
  return (
    <div className="ib-item ib-switch">
      <Shuffle size={16} strokeWidth={1.75} aria-hidden="true" className={s.outcome === "failed" ? "ib-warn" : "ib-icon"} />
      <span className="ib-text">
        <span className="t brand-name">
          <BrandIcon id={s.runner} size={14} />
          <span>{t("switch.title", { from: `${f.runner(s.runner)} · ${s.from.alias}`, to: `${f.runner(s.runner)} · ${s.to.alias}` })}</span>
        </span>
        <span className="s">{[task.data?.title, f.t(`accountSwitch.outcome.${s.outcome}`)].filter(Boolean).join(" · ")}</span>
        <SwitchFacts runner={s.runner} trigger={s.trigger} from={s.from} to={s.to} source={s.source} headroom={s.headroom} estimate={s.estimate} skipped={s.skipped} />
        <span className="ib-stall-acts">
          <Button size="sm" onClick={() => inspect({ taskId: s.taskId, memberId: s.memberId, ...(s.toRunId ? { runId: s.toRunId } : {}) })}>
            {t("switch.openTask")}
          </Button>
          <Button size="sm" disabled={held || !task.data} onClick={() => go(() => act("tasks.setAccountSwitch", { taskId: s.taskId, enabled: false }))}>
            {held ? t("switch.offForTaskDone") : t("switch.offForTask")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => go(() => act("switches.dismiss", { switchId: s.id }))}>
            {t("switch.dismiss")}
          </Button>
        </span>
      </span>
      <span className="k">{f.when.ago(s.at)}</span>
    </div>
  );
}

export function SwitchList({ switches, onError }: { switches: AccountSwitchView[]; onError: (err: unknown) => void }) {
  const { t } = useTranslation("inbox");
  const ref = useRef<HTMLDivElement>(null);
  const any = switches.length > 0;
  useEffect(() => {
    if (SHOT && any) ref.current?.scrollIntoView({ block: "start" });
  }, [any]);
  if (!any) return null;
  return (
    <>
      <div className="ib-sub lbl" ref={ref}>{t("switch.section", { count: switches.length })}</div>
      <Panel className="ib-list" aria-live="polite">
        {switches.map((s) => (
          <SwitchItem key={s.id} s={s} onError={onError} />
        ))}
      </Panel>
    </>
  );
}
