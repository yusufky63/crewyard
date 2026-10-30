import { useEffect } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { usePrefs } from "../../prefs.ts";
import type { SidebarBlockDef } from "../../registry.ts";
import { SIDEBAR_ID } from "../layout.ts";
import { useNarrow } from "../useMedia.ts";
import { ariaKeys, keyText, matches } from "../../keys.ts";

// Collapse to the icon rail and back (DESIGN.md §4), last in the sidebar. Ctrl B does the same
// from anywhere in a project; below 1180 px the rail is forced, so both step aside.

function CollapseToggle() {
  const { t } = useTranslation();
  const collapsed = usePrefs((s) => s.sidebarCollapsed);
  const toggle = usePrefs((s) => s.toggleSidebar);
  const narrow = useNarrow();

  useEffect(() => {
    if (narrow) return;
    const onKey = (e: KeyboardEvent) => {
      if (matches(e, "sidebar") && !e.defaultPrevented) {
        e.preventDefault();
        usePrefs.getState().toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [narrow]);

  if (narrow) return null;
  const title = `${collapsed ? t("layout.sidebar.expandTitle") : t("layout.sidebar.collapseTitle")} (${keyText("sidebar")})`;
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose;
  return (
    <button type="button" className="nav nav-collapse" onClick={toggle} title={title} aria-label={title} aria-expanded={!collapsed} aria-controls={SIDEBAR_ID} aria-keyshortcuts={ariaKeys("sidebar")}>
      <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
      <span className="t">{t("layout.sidebar.collapse")}</span>
      <span className="kbd">{keyText("sidebar")}</span>
    </button>
  );
}

export const block: SidebarBlockDef = { id: "collapse", order: 100, component: CollapseToggle };
