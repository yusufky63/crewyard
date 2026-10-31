import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useDaemonLifecycle } from "./ipc.ts";
import { useNav } from "./nav.ts";
import { usePrefs } from "./prefs.ts";
import { screens } from "./registry.ts";
import { useWorkLive } from "./screens/tasks/live.ts";
import { Inspector } from "./shell/Inspector.tsx";
import { layoutVars, sanitizeLayout } from "./shell/layout.ts";
import { Sidebar } from "./shell/Sidebar.tsx";
import { useOpenFolderEvents } from "./shell/openFolder.ts";
import { StatusBar } from "./shell/StatusBar.tsx";
import { TitleBar } from "./shell/TitleBar.tsx";

// Pane sizes go to <html> as custom properties outside React: set once before the first render (so
// nothing shifts at start) and on every change (so dragging a splitter never re-renders a screen).
function applyLayout(): void {
  const s = usePrefs.getState();
  const root = document.documentElement;
  for (const [k, v] of Object.entries(layoutVars(sanitizeLayout(s)))) root.style.setProperty(k, v);
  root.dataset.sidebar = s.sidebarCollapsed ? "rail" : "full";
  root.dataset.inspector = s.inspectorCollapsed ? "collapsed" : "open";
}
applyLayout();
usePrefs.subscribe(applyLayout);

/** Applies theme, density and language to <html>, and keeps the native caption buttons in step. */
function usePresentation(systemLanguage: string): void {
  // Picked one by one, so pane sizes changing while a splitter moves do not re-render the app.
  const theme = usePrefs((s) => s.theme);
  const density = usePrefs((s) => s.density);
  const language = usePrefs((s) => s.language);
  const { i18n } = useTranslation();

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved = theme === "system" ? (media.matches ? "dark" : "light") : theme;
      const root = document.documentElement;
      root.dataset.theme = resolved;
      const css = getComputedStyle(root);
      window.crewyard.setTitleBar({ color: css.getPropertyValue("--bg-canvas").trim(), symbolColor: css.getPropertyValue("--ink-secondary").trim() });
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  useEffect(() => {
    document.documentElement.dataset.density = density;
  }, [density]);

  useEffect(() => {
    const lng = language ?? systemLanguage;
    // lang drives correct Turkish casing for uppercase labels (i → İ).
    document.documentElement.lang = lng;
    if (i18n.language !== lng) void i18n.changeLanguage(lng);
  }, [language, systemLanguage, i18n]);
}

export function App({ systemLanguage, platform }: { systemLanguage: string; platform: string }) {
  usePresentation(systemLanguage);
  useDaemonLifecycle();
  // Task, request and limit events keep every screen fresh and raise Windows toasts.
  useWorkLive();
  // Folders from the command line, Explorer or a drop (PLAN.md §12).
  useOpenFolderEvents();
  const { screen, projectId } = useNav();
  const current = screens.find((s) => s.id === screen) ?? screens.find((s) => s.id === "start");
  const launch = !projectId || current?.scope === "launch";
  const Screen = current?.component;

  return (
    <div className={`app${launch ? " launch" : ""}`} data-platform={platform}>
      <TitleBar />
      <div className="body">
        {!launch && <Sidebar />}
        <main className="main">{Screen && <Screen />}</main>
        {!launch && <Inspector />}
      </div>
      <StatusBar />
    </div>
  );
}
