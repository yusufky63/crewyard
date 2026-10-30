import { useTranslation } from "react-i18next";
import { Splitter } from "@crewyard/ui";
import { useNav } from "../nav.ts";
import { usePrefs } from "../prefs.ts";
import { projectScreens, sidebarBlocks, type ScreenDef } from "../registry.ts";
import { SIDEBAR, SIDEBAR_ID } from "./layout.ts";
import { useNarrow } from "./useMedia.ts";

function NavItem({ screen, rail }: { screen: ScreenDef; rail: boolean }) {
  const { t } = useTranslation();
  const { screen: current, go } = useNav();
  const count = screen.useBadge?.() ?? 0;
  const Icon = screen.icon;
  const label = screen.navKey ? t(screen.navKey) : screen.id;
  return (
    <button className="nav" aria-current={current === screen.id ? "page" : undefined} onClick={() => go(screen.id)} title={rail ? (count > 0 ? `${label} · ${count}` : label) : undefined}>
      {Icon && <Icon size={16} strokeWidth={1.75} />}
      <span className="t">{label}</span>
      {count > 0 && <span className="count">{count}</span>}
    </button>
  );
}

/** The handle on the sidebar's right edge; its own component so a drag re-renders only this. */
function SidebarSplitter() {
  const { t } = useTranslation();
  const width = usePrefs((s) => s.sidebarWidth);
  const collapsed = usePrefs((s) => s.sidebarCollapsed);
  const setWidth = usePrefs((s) => s.setSidebarWidth);
  const setCollapsed = usePrefs((s) => s.setSidebarCollapsed);
  return (
    <Splitter
      value={width}
      min={SIDEBAR.min}
      max={SIDEBAR.max}
      defaultValue={SIDEBAR.default}
      edge="end"
      label={t("layout.sidebar.resize")}
      title={t("layout.resetHint")}
      controls={SIDEBAR_ID}
      collapse={{ collapsed, size: SIDEBAR.rail, below: SIDEBAR.collapseBelow, setCollapsed }}
      onChange={setWidth}
    />
  );
}

/**
 * Expanded (resizable by its right edge) or the 56 px icon rail (DESIGN.md §4). Below 1180 px it is
 * always the rail and the handle hides. Width and state come from <html> custom properties.
 */
export function Sidebar() {
  const { t } = useTranslation();
  const collapsed = usePrefs((s) => s.sidebarCollapsed);
  const narrow = useNarrow();
  const rail = collapsed || narrow;
  return (
    <div className={`sidebar-col${rail ? " rail" : ""}`}>
      <nav id={SIDEBAR_ID} className={`sidebar${rail ? " rail" : ""}`} aria-label={t("nav.label")}>
        <div className="nav-list">
          {projectScreens.map((s) => (
            <NavItem key={s.id} screen={s} rail={rail} />
          ))}
        </div>
        {/* Blocks sit at the bottom; the first one takes the free space above it. */}
        <div className="sidebar-blocks">
          {sidebarBlocks.map(({ id, component: Block }) => (
            <Block key={id} />
          ))}
        </div>
      </nav>
      {!narrow && <SidebarSplitter />}
    </div>
  );
}
