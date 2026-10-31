import { clampSize, type SplitBounds } from "@crewyard/ui";

// Pane sizes for the shell and the Inbox split (DESIGN.md §4, §5 `Splitter`). The user's sizes
// live in prefs (per window, never in the database); these are the limits they are held to.

/** id of the sidebar <nav>, for aria-controls on its toggle and handle. */
export const SIDEBAR_ID = "app-sidebar";

export const SIDEBAR = { default: 224, min: 184, max: 360, rail: 56, collapseBelow: 136 } as const;
export const INSPECTOR = { default: 380, min: 320, max: 720, collapsed: 44 } as const;
export const INBOX_LIST = { default: 360, min: 280, max: 560 } as const;
/**
 * The bottom panel under the main view (DESIGN.md §4). It never closes inside a project: collapsed it
 * is its 36 px head strip (`strip`), and a drag under `collapseBelow` collapses it to that strip.
 */
export const DRAWER = { default: 280, min: 160, max: 640, collapseBelow: 96, strip: 36 } as const;
/** id of the drawer region, for aria-controls on its toggle and handle. */
export const DRAWER_ID = "activity-drawer";
/** Title bar and status bar heights; the drawer never pushes the main view under MAIN_MIN_HEIGHT. */
const CHROME_HEIGHT = 40 + 28;
export const MAIN_MIN_HEIGHT = 200;

/** Below this the inspector overlays the main view instead of taking a column. */
export const OVERLAY_BELOW = 1280;
/** Below this the sidebar is always the icon rail. */
export const RAIL_BELOW = 1180;
/** The main view never gets narrower than this while the inspector is a column. */
export const MAIN_MIN = 600;
/** As an overlay the inspector still leaves this much of the main view showing. */
const OVERLAY_GAP = 120;
/** The Inbox detail pane never gets narrower than this. */
const INBOX_DETAIL_MIN = 320;

export interface LayoutPrefs {
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  inspectorWidth: number;
  inspectorCollapsed: boolean;
  inboxListWidth: number;
  drawerHeight: number;
  /** Expanded to `drawerHeight`; false is the collapsed head strip, never a hidden panel. */
  drawerOpen: boolean;
}

export const DEFAULT_LAYOUT: LayoutPrefs = {
  sidebarWidth: SIDEBAR.default,
  sidebarCollapsed: false,
  inspectorWidth: INSPECTOR.default,
  inspectorCollapsed: false,
  inboxListWidth: INBOX_LIST.default,
  drawerHeight: DRAWER.default,
  // Collapsed by default (DESIGN.md §2): normal telemetry stays out of the first view, while the
  // strip keeps the tabs and their counts one click away.
  drawerOpen: false,
};

const num = (v: unknown, fallback: number, b: SplitBounds) => (typeof v === "number" && Number.isFinite(v) ? clampSize(v, b) : fallback);

/** What localStorage held, made safe: a hand-edited or older value never breaks the layout. */
export function sanitizeLayout(stored: unknown): LayoutPrefs {
  const s = (stored && typeof stored === "object" ? stored : {}) as Partial<Record<keyof LayoutPrefs, unknown>>;
  return {
    sidebarWidth: num(s.sidebarWidth, SIDEBAR.default, SIDEBAR),
    sidebarCollapsed: s.sidebarCollapsed === true,
    inspectorWidth: num(s.inspectorWidth, INSPECTOR.default, INSPECTOR),
    inspectorCollapsed: s.inspectorCollapsed === true,
    inboxListWidth: num(s.inboxListWidth, INBOX_LIST.default, INBOX_LIST),
    drawerHeight: num(s.drawerHeight, DRAWER.default, DRAWER),
    drawerOpen: s.drawerOpen === true,
  };
}

/** Width of the sidebar column right now: the rail when collapsed or when the window is narrow. */
export function sidebarColumn(viewport: number, l: Pick<LayoutPrefs, "sidebarWidth" | "sidebarCollapsed">): number {
  return viewport <= RAIL_BELOW || l.sidebarCollapsed ? SIDEBAR.rail : l.sidebarWidth;
}

/** How wide the inspector may get in this window, so the main view keeps its minimum. */
export function inspectorBounds(viewport: number, sidebar: number): SplitBounds {
  const room = viewport < OVERLAY_BELOW ? viewport - sidebar - OVERLAY_GAP : viewport - sidebar - MAIN_MIN;
  return { min: INSPECTOR.min, max: Math.max(INSPECTOR.min, Math.min(INSPECTOR.max, room)) };
}

/** How wide the Inbox list may get inside a grid of this width, so the detail keeps its minimum. */
export function inboxListBounds(gridWidth: number, handle: number): SplitBounds {
  return { min: INBOX_LIST.min, max: Math.max(INBOX_LIST.min, Math.min(INBOX_LIST.max, gridWidth - handle - INBOX_DETAIL_MIN)) };
}

/** How tall the drawer may get in a window this high, so the main view keeps its minimum. */
export function drawerBounds(viewportHeight: number): SplitBounds {
  return { min: DRAWER.min, max: Math.max(DRAWER.min, Math.min(DRAWER.max, viewportHeight - CHROME_HEIGHT - MAIN_MIN_HEIGHT)) };
}

/**
 * The CSS custom properties the layout reads. Written on <html> before the first render and on
 * every change, so the panes open at their saved size (no shift at start) and dragging never
 * re-renders the screens.
 */
export function layoutVars(l: LayoutPrefs): Record<string, string> {
  return {
    "--sidebar-w": `${l.sidebarWidth}px`,
    "--inspector-w": `${l.inspectorWidth}px`,
    "--inbox-list-w": `${l.inboxListWidth}px`,
    "--drawer-h": `${l.drawerHeight}px`,
  };
}
