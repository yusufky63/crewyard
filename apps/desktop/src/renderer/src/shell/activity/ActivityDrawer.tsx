import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { PanelBottomClose, PanelBottomOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import type { AssistantView } from "@crewyard/core";
import { Splitter } from "@crewyard/ui";
import { ariaKeys, keyText, matches } from "../../keys.ts";
import { useNav } from "../../nav.ts";
import { DRAWER_TABS, usePrefs, type DrawerTab } from "../../prefs.ts";
import { AssistantPanel } from "../../screens/tasks/Assistant.tsx";
import { useWork } from "../../screens/tasks/data.ts";
import { DRAWER, DRAWER_ID, drawerBounds } from "../layout.ts";
import { EventsPanel } from "./EventsPanel.tsx";
import { LogsPanel } from "./LogsPanel.tsx";
import { collapsePanel, hideAfterAssistant, takeAssistantFocus, togglePanel, toggleTitleKey } from "./panel.ts";
import { ProblemsTab, useProblems } from "./ProblemsTab.tsx";
import { TerminalTab } from "./TerminalTab.tsx";
import { useTerminals } from "./terminals.ts";
import { PANEL_TOGGLE_ID, takeFocus } from "./focus.ts";
import "./activity.css";

// The bottom panel under the main view (DESIGN.md §4): the task assistant, terminals, the
// project's events, Crewyard's own logs and the project's problems, one tab each. Inside a project
// it never closes: the toggle at the right end of its head collapses it to that head strip, whose
// tabs and counts stay, and expands it again to its last height (owner, 2026-10-31: "tam
// kapanmasın"). Collapsing or switching tabs only hides a view, so nothing it shows stops, the
// assistant included. Two controls stop what they show and say so: the assistant's `Stop and close`
// (docs/adr/0014) and a terminal's own close, which asks first (docs/adr/0016). Its views read only
// while it is expanded; the strip's counts and the assistant's state keep reading.

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
  const open = usePrefs((s) => s.drawerOpen);
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
      title={t(open ? "resizeCollapseHint" : "resizeExpandHint")}
      controls={DRAWER_ID}
      // A drag far under the minimum, or Enter, collapses the panel to its strip; dragging the strip
      // up, Enter again or Up expands it to its last height. The handle stays, so focus stays on it.
      collapse={{
        collapsed: !open,
        size: DRAWER.strip,
        below: DRAWER.collapseBelow,
        setCollapsed: (c) => setOpen(!c),
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

/**
 * The task assistant's state for the strip, read while its view is out of sight (the panel collapsed,
 * or another tab in view): a session still working, and spending, or a reply waiting for you shows
 * beside the tab's name. A reply that arrives then is announced once, politely; in view, the
 * assistant announces its own replies (DESIGN.md §8).
 */
function useAssistantStrip(projectId: string, inView: boolean): { state: AssistantView["state"] | null; announce: string } {
  const { t } = useTranslation("assistant");
  const qc = useQueryClient();
  // The same query as the assistant's own view, so the two share one read.
  const view = useWork("assistant.get", { projectId }, { enabled: projectId !== "" });
  const [announce, setAnnounce] = useState("");
  useEffect(() => {
    return window.crewyard.on("assistant.changed", (p) => {
      if ((p as { projectId?: string }).projectId === projectId) void qc.invalidateQueries({ queryKey: ["assistant.get", { projectId }] });
    });
  }, [projectId, qc]);

  const state = view.data?.state ?? null;
  const waiting = (view.data?.drafts ?? []).filter((d) => d.status === "open").length;
  const prev = useRef(state);
  useEffect(() => {
    if (!inView && prev.current === "working" && state === "waiting") setAnnounce(t("announce.replied", { count: waiting }));
    prev.current = state;
  }, [state, inView, waiting, t]);
  // The live region empties again after a while, at once when the assistant comes into view, so the
  // next reply is a change a screen reader hears and an old one is never read out again.
  useEffect(() => {
    if (!announce) return;
    const timer = setTimeout(() => setAnnounce(""), inView ? 0 : 5000);
    return () => clearTimeout(timer);
  }, [announce, inView]);
  return { state, announce };
}

/** The assistant's state beside its tab's name, as a word; nothing once it has stopped. */
function AssistantState({ state }: { state: AssistantView["state"] | null }) {
  const { t } = useTranslation("assistant");
  if (!state || state === "idle") return null;
  return <span className={`drawer-count drawer-state drawer-state-${state}`}>{t(`state.${state}`)}</span>;
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
  const root = useRef<HTMLElement>(null);
  const assistantInView = open && tab === "assistant";
  const assistant = useAssistantStrip(projectId ?? "", assistantInView);

  // A shortcut that expanded the panel or moved it to a tab puts focus on that tab. A layout effect,
  // so it runs before the assistant's own mount effect. The assistant stays mounted while the panel
  // is collapsed on its tab (below), so when its shortcut or button expands it again there is no new
  // mount to focus the message box: this puts focus there, and the mount effect then finds nothing to do.
  useLayoutEffect(() => {
    if (!open) return;
    takeFocus(root.current);
    const box = tab === "assistant" ? root.current?.querySelector<HTMLTextAreaElement>(".as-input textarea") : null;
    if (box && takeAssistantFocus()) box.focus();
  }, [open, tab]);

  if (!projectId) return null;

  // A tab click in the strip expands the panel on that tab; focus stays on the tab.
  const pick = (x: DrawerTab) => {
    setTab(x);
    if (!open) setOpen(true);
  };

  // Tabs after the WAI-ARIA tabs pattern: arrows move and select, Home and End jump. In the strip they
  // select without expanding, so a keyboard pass never opens the panel; Enter or a click does.
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const n = DRAWER_TABS.length;
    const i = DRAWER_TABS.indexOf(tab);
    const next = e.key === "ArrowRight" ? (i + 1) % n : e.key === "ArrowLeft" ? (i + n - 1) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    setTab(DRAWER_TABS[next]!);
    tabRefs.current[DRAWER_TABS[next]!]?.focus();
  };

  // Esc inside the expanded panel collapses it before anything under it closes (DESIGN.md §7); a
  // menu or dialog opened from inside handles its own Esc first, and inside a terminal Esc belongs to
  // the shell. In the strip Esc goes on to the layer under it.
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (!open || !matches(e, "close") || e.defaultPrevented || document.querySelector("dialog[open], [role=menu]")) return;
    if ((e.target as HTMLElement).closest(".xterm")) return;
    e.preventDefault();
    collapsePanel();
  };

  const toggleTitle = t(toggleTitleKey(open, tab), { keys: keyText("drawer") });
  const ToggleIcon = open ? PanelBottomClose : PanelBottomOpen;

  return (
    <section id={DRAWER_ID} className="drawer" data-collapsed={open ? undefined : ""} aria-label={t("label")} onKeyDown={onKey} ref={root}>
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
              aria-controls={open && tab === x ? `drawer-panel-${x}` : undefined}
              tabIndex={tab === x ? 0 : -1}
              onClick={() => pick(x)}
              onKeyDown={onTabKey}
              data-drawer-tab={tab === x ? "active" : undefined}
            >
              {t(`tab.${x}`)}
              {x === "assistant" && !assistantInView && <AssistantState state={assistant.state} />}
              {x === "problems" && <ProblemCount projectId={projectId} />}
              {x === "terminal" && <TerminalCount projectId={projectId} />}
            </button>
          ))}
        </div>
        {/* The strip makes no claim about what stopped: the assistant's own Stop and close collapses
            the panel too, right after stopping it. */}
        <span className="drawer-note muted">{t(!open ? "collapsedNote" : tab === "assistant" ? "collapseNoteAssistant" : tab === "terminal" ? "collapseNoteTerminal" : "collapseNote")}</span>
        <button
          type="button"
          id={PANEL_TOGGLE_ID}
          className="drawer-x drawer-toggle"
          onClick={togglePanel}
          aria-label={toggleTitle}
          title={toggleTitle}
          aria-expanded={open}
          aria-controls={DRAWER_ID}
          aria-keyshortcuts={ariaKeys("drawer")}
        >
          <ToggleIcon size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
      {/* Collapsed on the Assistant tab, its view stays mounted but hidden, so a message you were
          typing, the profile you picked and the scroll position are still there when it expands.
          The other views unmount as before: they read only while they can be seen. */}
      {(open || tab === "assistant") && (
        <div className="drawer-body" role="tabpanel" id={`drawer-panel-${tab}`} aria-labelledby={`drawer-tab-${tab}`} hidden={!open}>
          {/* The assistant's own Stop and close stops it first, then collapses the panel here. */}
          {tab === "assistant" && <AssistantPanel key={projectId} projectId={projectId} docked onClose={hideAfterAssistant} />}
          {tab === "terminal" && <TerminalTab projectId={projectId} />}
          {tab === "events" && <EventsPanel projectId={projectId} />}
          {tab === "logs" && <LogsPanel />}
          {tab === "problems" && <ProblemsTab projectId={projectId} />}
        </div>
      )}
      <div id="drawer-assistant-announce" className="drawer-sr" aria-live="polite">
        {assistant.announce}
      </div>
    </section>
  );
}
