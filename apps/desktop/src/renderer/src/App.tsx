import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useDaemonLifecycle } from "./ipc.ts";
import { useNav } from "./nav.ts";
import { usePrefs } from "./prefs.ts";
import { screens } from "./registry.ts";
import { useWorkLive } from "./screens/tasks/live.ts";
import { Inspector } from "./shell/Inspector.tsx";
import { Sidebar } from "./shell/Sidebar.tsx";
import { StatusBar } from "./shell/StatusBar.tsx";
import { TitleBar } from "./shell/TitleBar.tsx";

/** Applies theme, density and language to <html>, and keeps the native caption buttons in step. */
function usePresentation(systemLanguage: string): void {
  const { theme, density, language } = usePrefs();
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
