import { useEffect } from "react";
import { PanelBottomClose, PanelBottomOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ariaKeys, keyText, matches } from "../../keys.ts";
import { useNav } from "../../nav.ts";
import { usePrefs } from "../../prefs.ts";
import type { StatusItemDef } from "../../registry.ts";
import { DRAWER_TOGGLE_ID, focusOnOpen, focusToggle } from "../activity/focus.ts";
import { toggleAssistant, togglePanelTab } from "../activity/panel.ts";
import { DRAWER_ID } from "../layout.ts";

// Opens and closes the bottom panel (DESIGN.md §4), here and with Ctrl J; Ctrl ` (or Ctrl Shift T),
// Ctrl Shift M and Ctrl Shift A open it on the Terminal, Problems and Assistant tabs. Only inside
// a project, where the panel lives. Closing it hides the view; nothing it shows stops.

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
      if (usePrefs.getState().drawerOpen) focusToggle();
      else focusOnOpen();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [projectId, toggle]);

  if (!projectId) return null;
  const Icon = open ? PanelBottomClose : PanelBottomOpen;
  const title = t(open ? "toggle.hide" : "toggle.show", { keys: keyText("drawer") });
  return (
    <button type="button" id={DRAWER_TOGGLE_ID} className="sb" onClick={toggle} aria-expanded={open} aria-controls={open ? DRAWER_ID : undefined} aria-keyshortcuts={ariaKeys("drawer")} title={title}>
      <Icon size={13} strokeWidth={1.75} aria-hidden="true" />
      {t("toggle.label")}
    </button>
  );
}

export const item: StatusItemDef = { id: "activity", side: "end", order: 60, component: ActivityStatus };
