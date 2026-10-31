import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Splitter } from "@crewyard/ui";
import { keyText, matches } from "../../keys.ts";
import { useNav } from "../../nav.ts";
import { DRAWER_TABS, usePrefs, type DrawerTab } from "../../prefs.ts";
import { AssistantPanel } from "../../screens/tasks/Assistant.tsx";
import { DRAWER, DRAWER_ID, drawerBounds } from "../layout.ts";
import { EventsPanel } from "./EventsPanel.tsx";
import { LogsPanel } from "./LogsPanel.tsx";
import { hideAfterAssistant } from "./panel.ts";
import { ProblemsTab, useProblems } from "./ProblemsTab.tsx";
import { TerminalTab } from "./TerminalTab.tsx";
import { useTerminals } from "./terminals.ts";
import { focusToggle, takeFocus } from "./focus.ts";
import "./activity.css";

// The bottom panel under the main view (DESIGN.md §4): the task assistant, terminals, the
// project's events, Crewyard's own logs and the project's problems, one tab each. Closed by
// default; closing it or switching tabs only hides a view, so nothing it shows stops. The two
// exceptions say so on their own controls: the assistant's `Stop and close` (docs/adr/0014) and a
// terminal's own close, which asks first (docs/adr/0016). Its views read only while it is open.

function useViewportHeight(): number {
  const [h, setH] = useState(() => window.innerHeight);
  useEffect(() => {
    const on = () => setH(window.innerHeight);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return h;
}

function DrawerSplitter() {
  const { t } = useTranslation("activity");
  const height = usePrefs((s) => s.drawerHeight);
  const setHeight = usePrefs((s) => s.setDrawerHeight);
  const setOpen = usePrefs((s) => s.setDrawerOpen);
  const bounds = drawerBounds(useViewportHeight());
  return (
    <Splitter
      orientation="horizontal"
      value={height}
      min={bounds.min}
      max={bounds.max}
      defaultValue={DRAWER.default}
      edge="start"
      label={t("resize")}
      title={t("resizeHint")}
      controls={DRAWER_ID}
      // A drag far under the minimum, or Enter, closes the panel; it opens again at its last height.
      collapse={{
        collapsed: false,
        size: 0,
        below: DRAWER.closeBelow,
        setCollapsed: (c) => {
          if (!c) return;
          setOpen(false);
          focusToggle();
        },
      }}
      onChange={setHeight}
    />
  );
}

/** Problems still shown, beside the tab's name; red while one of them is a failure. */
function ProblemCount({ projectId }: { projectId: string }) {
  const { t } = useTranslation("activity");
  const counts = useProblems(projectId).counts;
  if (counts.total === 0) return null;
  return (
    <span className={`num drawer-count${counts.danger ? " drawer-count-bad" : ""}`} aria-label={t("problems.countLabel", { count: counts.total })}>
      {counts.total}
    </span>
  );
}

/** Shells still running in this project. */
function TerminalCount({ projectId }: { projectId: string }) {
  const { t } = useTranslation("activity");
  const running = useTerminals((s) => s.sessions.filter((x) => x.projectId === projectId && x.state === "running").length);
  if (running === 0) return null;
  return (
    <span className="num drawer-count" aria-label={t("terminal.countLabel", { count: running })}>
      {running}
    </span>
  );
}

export function ActivityDrawer() {
  const { t } = useTranslation("activity");
  const open = usePrefs((s) => s.drawerOpen);
  const setOpen = usePrefs((s) => s.setDrawerOpen);
  const stored = usePrefs((s) => s.drawerTab);
  const setTab = usePrefs((s) => s.setDrawerTab);
  const projectId = useNav((s) => s.projectId);
  const tab: DrawerTab = DRAWER_TABS.includes(stored) ? stored : "events";
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  if (!open || !projectId) return null;

  const close = () => {
    setOpen(false);
    focusToggle();
  };

  // Tabs after the WAI-ARIA tabs pattern: arrows move and select, Home and End jump.
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const n = DRAWER_TABS.length;
    const i = DRAWER_TABS.indexOf(tab);
    const next = e.key === "ArrowRight" ? (i + 1) % n : e.key === "ArrowLeft" ? (i + n - 1) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    setTab(DRAWER_TABS[next]!);
    tabRefs.current[DRAWER_TABS[next]!]?.focus();
  };

  // Esc inside the panel closes it before anything under it (DESIGN.md §7); a menu or dialog
  // opened from inside handles its own Esc first, and inside a terminal Esc belongs to the shell.
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (!matches(e, "close") || e.defaultPrevented || document.querySelector("dialog[open], [role=menu]")) return;
    if ((e.target as HTMLElement).closest(".xterm")) return;
    e.preventDefault();
    close();
  };

  return (
    <section id={DRAWER_ID} className="drawer" aria-label={t("label")} onKeyDown={onKey} ref={takeFocus}>
      <DrawerSplitter />
      <div className="drawer-head">
        <div className="drawer-tabs" role="tablist" aria-label={t("tabsLabel")}>
          {DRAWER_TABS.map((x) => (
            <button
              key={x}
              ref={(el) => {
                tabRefs.current[x] = el;
              }}
              type="button"
              role="tab"
              id={`drawer-tab-${x}`}
              aria-selected={tab === x}
              aria-controls={`drawer-panel-${x}`}
              tabIndex={tab === x ? 0 : -1}
              onClick={() => setTab(x)}
              onKeyDown={onTabKey}
              data-drawer-tab={tab === x ? "active" : undefined}
            >
              {t(`tab.${x}`)}
              {x === "problems" && <ProblemCount projectId={projectId} />}
              {x === "terminal" && <TerminalCount projectId={projectId} />}
            </button>
          ))}
        </div>
        <span className="drawer-note muted">{t(tab === "assistant" ? "closeNoteAssistant" : tab === "terminal" ? "closeNoteTerminal" : "closeNote")}</span>
        <button type="button" className="drawer-x" onClick={close} aria-label={t("close")} title={t("closeTitle", { keys: keyText("drawer") })}>
          <X size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
      <div className="drawer-body" role="tabpanel" id={`drawer-panel-${tab}`} aria-labelledby={`drawer-tab-${tab}`}>
        {tab === "assistant" && <AssistantPanel key={projectId} projectId={projectId} docked onClose={hideAfterAssistant} />}
        {tab === "terminal" && <TerminalTab projectId={projectId} />}
        {tab === "events" && <EventsPanel projectId={projectId} />}
        {tab === "logs" && <LogsPanel />}
        {tab === "problems" && <ProblemsTab projectId={projectId} />}
      </div>
    </section>
  );
}
