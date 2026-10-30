import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Splitter } from "@crewyard/ui";
import { keyText, matches } from "../../keys.ts";
import { useNav } from "../../nav.ts";
import { usePrefs, type DrawerTab } from "../../prefs.ts";
import { DRAWER, DRAWER_ID, drawerBounds } from "../layout.ts";
import { EventsPanel } from "./EventsPanel.tsx";
import { LogsPanel } from "./LogsPanel.tsx";
import { focusToggle, takeFocus } from "./focus.ts";
import "./activity.css";

// The Activity drawer under the main view (DESIGN.md §4): the project's events and Crewyard's own
// logs. Closed by default; closing only hides it, so nothing it shows ever stops. Its panels read
// only while it is open. The terminal view is not built (DESIGN.md §4).

const TABS: DrawerTab[] = ["events", "logs"];

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
      // A drag far under the minimum, or Enter, closes the drawer; it opens again at its last height.
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

export function ActivityDrawer() {
  const { t } = useTranslation("activity");
  const open = usePrefs((s) => s.drawerOpen);
  const setOpen = usePrefs((s) => s.setDrawerOpen);
  const stored = usePrefs((s) => s.drawerTab);
  const setTab = usePrefs((s) => s.setDrawerTab);
  const projectId = useNav((s) => s.projectId);
  const tab: DrawerTab = TABS.includes(stored) ? stored : "events";
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  if (!open || !projectId) return null;

  const close = () => {
    setOpen(false);
    focusToggle();
  };

  // Tabs after the WAI-ARIA tabs pattern: arrows move and select, Home and End jump.
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = TABS.indexOf(tab);
    const next = e.key === "ArrowRight" ? (i + 1) % TABS.length : e.key === "ArrowLeft" ? (i + TABS.length - 1) % TABS.length : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    setTab(TABS[next]!);
    tabRefs.current[TABS[next]!]?.focus();
  };

  // Esc inside the drawer closes it before anything under it (DESIGN.md §7); a menu or dialog
  // opened from inside handles its own Esc first.
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (!matches(e, "close") || e.defaultPrevented || document.querySelector("dialog[open], [role=menu]")) return;
    e.preventDefault();
    close();
  };

  return (
    <section id={DRAWER_ID} className="drawer" aria-label={t("label")} onKeyDown={onKey} ref={takeFocus}>
      <DrawerSplitter />
      <div className="drawer-head">
        <div className="drawer-tabs" role="tablist" aria-label={t("tabsLabel")}>
          {TABS.map((x) => (
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
            </button>
          ))}
        </div>
        <span className="drawer-note muted">{t("closeNote")}</span>
        <button type="button" className="drawer-x" onClick={close} aria-label={t("close")} title={t("closeTitle", { keys: keyText("drawer") })}>
          <X size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
      <div className="drawer-body" role="tabpanel" id={`drawer-panel-${tab}`} aria-labelledby={`drawer-tab-${tab}`}>
        {tab === "events" ? <EventsPanel projectId={projectId} /> : <LogsPanel />}
      </div>
    </section>
  );
}
