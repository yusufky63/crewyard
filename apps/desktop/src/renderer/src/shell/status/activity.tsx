import { useEffect } from "react";
import { PanelBottomClose, PanelBottomOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ariaKeys, keyText, matches } from "../../keys.ts";
import { useNav } from "../../nav.ts";
import { usePrefs } from "../../prefs.ts";
import type { StatusItemDef } from "../../registry.ts";
import { DRAWER_TOGGLE_ID } from "../activity/focus.ts";
import { toggleAssistant, togglePanel, togglePanelTab } from "../activity/panel.ts";
import { DRAWER_ID } from "../layout.ts";

// Expands and collapses the bottom panel (DESIGN.md §4), here and with Ctrl J; Ctrl ` (or Ctrl
// Shift T), Ctrl Shift M and Ctrl Shift A expand it on the Terminal, Problems and Assistant tabs and
// collapse it when it already shows that tab. Only inside a project, where the panel lives; it never
// closes there, and collapsing it stops nothing.

function ActivityStatus() {
  const { t } = useTranslation("activity");
  const open = usePrefs((s) => s.drawerOpen);
  const toggle = usePrefs((s) => s.toggleDrawer);
  const projectId = useNav((s) => s.projectId);

  useEffect(() => {
    if (!projectId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || document.querySelector("dialog[open]")) return;
      if (matches(e, "panel.terminal") || matches(e, "panel.problems")) {
        e.preventDefault();
        togglePanelTab(matches(e, "panel.terminal") ? "terminal" : "problems");
        return;
      }
      if (matches(e, "assistant")) {
        e.preventDefault();
        toggleAssistant(projectId);
        return;
      }
      if (!matches(e, "drawer")) return;
      e.preventDefault();
      togglePanel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [projectId]);

  if (!projectId) return null;
  const Icon = open ? PanelBottomClose : PanelBottomOpen;
  const title = t(open ? "toggle.collapse" : "toggle.expand", { keys: keyText("drawer") });
  // A click here keeps focus on this button, so it can be pressed again; the shortcut moves focus.
  return (
    <button type="button" id={DRAWER_TOGGLE_ID} className="sb" onClick={toggle} aria-expanded={open} aria-controls={DRAWER_ID} aria-keyshortcuts={ariaKeys("drawer")} title={title}>
      <Icon size={13} strokeWidth={1.75} aria-hidden="true" />
      {t("toggle.label")}
    </button>
  );
}

export const item: StatusItemDef = { id: "activity", side: "end", order: 60, component: ActivityStatus };
