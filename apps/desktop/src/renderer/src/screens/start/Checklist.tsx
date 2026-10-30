import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, Circle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button, Panel } from "@crewyard/ui";
import { useDaemon } from "../../ipc.ts";
import { useNav } from "../../nav.ts";
import { goInProject, startNewTask } from "../../shell/titlebar/actions.ts";
import { openSetup } from "../setup/draft.ts";
import { AGENT_TOOLS, checklist, showChecklist, type ChecklistItemId } from "./checklist.ts";
import { MACHINE_PANEL_ID } from "./Machine.tsx";

const MACHINE_STALE = 5 * 60_000;

function focusMachine(): void {
  const el = document.getElementById(MACHINE_PANEL_ID);
  el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  el?.focus({ preventScroll: true });
}

/** Getting started (PLAN.md §11.1): until the first task finishes, each open item links to where it gets done. */
export function Checklist() {
  const { t } = useTranslation("start");
  const qc = useQueryClient();
  const go = useNav((s) => s.go);
  const tools = {
    claude: useDaemon("machine.tool", { id: "claude" }, { staleTime: MACHINE_STALE }).data,
    codex: useDaemon("machine.tool", { id: "codex" }, { staleTime: MACHINE_STALE }).data,
    opencode: useDaemon("machine.tool", { id: "opencode" }, { staleTime: MACHINE_STALE }).data,
    gemini: useDaemon("machine.tool", { id: "gemini" }, { staleTime: MACHINE_STALE }).data,
  };
  const accounts = useDaemon("providers.accounts", undefined);
  const profiles = useDaemon("providers.profiles", undefined);
  const credentials = useDaemon("providers.credentials", undefined);
  const auth = useDaemon("github.auth", undefined, { staleTime: MACHINE_STALE });
  const tasks = useDaemon("tasks.list", {});
  const projects = useDaemon("projects.list", undefined).data ?? [];
  const recent = projects[0]?.id ?? null;

  if (!showChecklist(tasks.data)) return null;
  const items = checklist({
    agents: Object.fromEntries(AGENT_TOOLS.map((id) => [id, tools[id as keyof typeof tools]])),
    accounts: accounts.data,
    profiles: profiles.data,
    credentials: credentials.data,
    githubSignedIn: auth.data?.signedIn,
    tasks: tasks.data,
  });
  const left = items.filter((i) => i.done !== true).length;

  // Providers works without a project; GitHub and Tasks need one, so they open the most recent.
  const where: Record<ChecklistItemId, { label: string; run(): void } | null> = {
    agents: { label: t("checklist.go.machine"), run: focusMachine },
    plan: { label: t("checklist.go.providers"), run: () => (recent ? void goInProject(qc, recent, "providers") : go("providers")) },
    github: recent ? { label: t("checklist.go.github"), run: () => void goInProject(qc, recent, "github") } : { label: t("checklist.go.machine"), run: focusMachine },
    claudeKey: { label: t("checklist.go.providers"), run: () => (recent ? void goInProject(qc, recent, "providers") : go("providers")) },
    firstTask: recent ? { label: t("checklist.go.task"), run: () => void startNewTask(qc, recent) } : { label: t("checklist.go.project"), run: () => openSetup("local") },
  };

  return (
    <Panel className="checklist">
      <div className="ph">
        <h2>{t("checklist.title")}</h2>
        <span className="end lbl">{left === 0 ? t("checklist.allDone") : t("checklist.left", { count: left, total: items.length })}</span>
      </div>
      <ol className="cl-list">
        {items.map((item, i) => {
          const link = item.done === false ? where[item.id] : null;
          return (
            <li key={item.id} className="sysrow cl-row">
              <span className={item.done ? "st st-ok" : item.done === null ? "st st-run" : "st muted"}>
                {item.done ? <Check size={16} strokeWidth={1.75} aria-hidden="true" /> : item.done === null ? <span className="spin" /> : <Circle size={14} strokeWidth={1.75} aria-hidden="true" />}
              </span>
              <span className="cl-text">
                <span className="cl-label">
                  <span className="lbl">{String(i + 1).padStart(2, "0")}</span> {t(`checklist.items.${item.id}.label`)}
                  <span className="sr-only-text">{item.done === true ? t("checklist.doneSr") : item.done === null ? t("checklist.checkingSr") : t("checklist.openSr")}</span>
                </span>
                {item.done === false && <span className="muted cl-hint">{t(`checklist.items.${item.id}.hint`)}</span>}
              </span>
              {link ? (
                <Button size="sm" variant="ghost" onClick={link.run}>
                  {link.label}
                  <ArrowRight size={14} strokeWidth={1.75} aria-hidden="true" />
                </Button>
              ) : (
                <span />
              )}
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}
