import { useTranslation } from "react-i18next";
import { useNav } from "../nav.ts";
import { projectScreens, sidebarBlocks, type ScreenDef } from "../registry.ts";

function NavItem({ screen }: { screen: ScreenDef }) {
  const { t } = useTranslation();
  const { screen: current, go } = useNav();
  const count = screen.useBadge?.() ?? 0;
  const Icon = screen.icon;
  return (
    <button className="nav" aria-current={current === screen.id ? "page" : undefined} onClick={() => go(screen.id)}>
      {Icon && <Icon size={16} strokeWidth={1.75} />}
      <span className="t">{screen.navKey ? t(screen.navKey) : screen.id}</span>
      {count > 0 && <span className="count">{count}</span>}
    </button>
  );
}

export function Sidebar() {
  const { t } = useTranslation();
  return (
    <nav className="sidebar" aria-label={t("nav.label")}>
      <div className="nav-list">
        {projectScreens.map((s) => (
          <NavItem key={s.id} screen={s} />
        ))}
      </div>
      {/* Blocks sit at the bottom; the first one takes the free space above it. */}
      <div className="sidebar-blocks">
        {sidebarBlocks.map(({ id, component: Block }) => (
          <Block key={id} />
        ))}
      </div>
    </nav>
  );
}
