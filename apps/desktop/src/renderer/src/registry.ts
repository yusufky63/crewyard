import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";

// Screens and status-bar items register themselves by file location, so each screen can be built
// in its own folder without touching shared files:
//   src/renderer/src/screens/<id>/screen.ts   exports `screen: ScreenDef`
//   src/renderer/src/shell/status/<id>.tsx     exports `item: StatusItemDef`
//   src/renderer/src/shell/sidebar/<id>.tsx    exports `block: SidebarBlockDef`

export interface ScreenDef {
  id: string;
  /** "launch" screens show without a project and hide the sidebar; "project" screens appear in the sidebar. */
  scope: "launch" | "project";
  order: number;
  /** i18n key in the `common` namespace for the sidebar label, e.g. "nav.tasks". */
  navKey?: string;
  icon?: LucideIcon;
  /** Shows a count badge in the sidebar when > 0 (Inbox only, per DESIGN.md). */
  useBadge?: () => number;
  component: ComponentType;
}

export interface StatusItemDef {
  id: string;
  side: "start" | "end";
  order: number;
  component: ComponentType;
}

/** Blocks pinned under the sidebar nav, e.g. the accounts limits block (DESIGN.md §4). */
export interface SidebarBlockDef {
  id: string;
  order: number;
  component: ComponentType;
}

const screenModules = import.meta.glob<{ screen: ScreenDef }>("./screens/*/screen.ts", { eager: true });
const statusModules = import.meta.glob<{ item: StatusItemDef }>("./shell/status/*.tsx", { eager: true });
const sidebarModules = import.meta.glob<{ block: SidebarBlockDef }>("./shell/sidebar/*.tsx", { eager: true });

export const sidebarBlocks: SidebarBlockDef[] = Object.values(sidebarModules)
  .map((m) => m.block)
  .sort((a, b) => a.order - b.order);

export const screens: ScreenDef[] = Object.values(screenModules)
  .map((m) => m.screen)
  .sort((a, b) => a.order - b.order);

export const statusItems: StatusItemDef[] = Object.values(statusModules)
  .map((m) => m.item)
  .sort((a, b) => a.order - b.order);

export const projectScreens = screens.filter((s) => s.scope === "project");
