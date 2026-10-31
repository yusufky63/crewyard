import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/500.css";
import "@fontsource/geist-sans/600.css";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "@crewyard/ui/tokens.css";
import "@crewyard/ui/styles.css";
import "./app.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App.tsx";
import { initI18n, pickLanguage } from "./i18n.ts";
import { useNav } from "./nav.ts";
import { DRAWER_TABS, usePrefs } from "./prefs.ts";

// ?theme=, ?density= and ?lang= are only set by the main process in screenshot mode.
const query = new URLSearchParams(location.search);
const forcedTheme = query.get("theme");
if (forcedTheme === "dark" || forcedTheme === "light") usePrefs.setState({ theme: forcedTheme });
const forcedDensity = query.get("density");
if (forcedDensity === "compact" || forcedDensity === "comfortable") usePrefs.setState({ density: forcedDensity });
const forcedLang = query.get("lang");
if (forcedLang === "en" || forcedLang === "tr") usePrefs.setState({ language: forcedLang });
const forcedScreen = query.get("screen");
if (forcedScreen) useNav.setState({ screen: forcedScreen });
// Pane layout for screenshots: ?sidebar=rail or a width, ?inspectorW=, ?inspector=collapsed, ?inboxW=.
const forcedSidebar = query.get("sidebar");
if (forcedSidebar === "rail") usePrefs.setState({ sidebarCollapsed: true });
else if (forcedSidebar && Number(forcedSidebar) > 0) usePrefs.setState({ sidebarCollapsed: false, sidebarWidth: Number(forcedSidebar) });
if (Number(query.get("inspectorW")) > 0) usePrefs.setState({ inspectorWidth: Number(query.get("inspectorW")) });
if (query.get("inspector") === "collapsed") usePrefs.setState({ inspectorCollapsed: true });
if (Number(query.get("inboxW")) > 0) usePrefs.setState({ inboxListWidth: Number(query.get("inboxW")) });
// ?drawer=<tab> (assistant, terminal, events, logs, problems) opens the bottom panel on that tab;
// ?drawerH= sets its height. A terminal still starts only from its button.
const forcedDrawer = DRAWER_TABS.find((tab) => tab === query.get("drawer"));
if (forcedDrawer) usePrefs.setState({ drawerOpen: true, drawerTab: forcedDrawer });
if (Number(query.get("drawerH")) > 0) usePrefs.setState({ drawerHeight: Number(query.get("drawerH")) });

// ?project= and ?screen= are screenshot mode too: add the folder to the throwaway profile and open it.
const forcedProject = query.get("project");
if (forcedProject) {
  const project = await window.crewyard.call("projects.add", { path: forcedProject });
  useNav.getState().openProject(project.id);
  const forcedScreen = query.get("screen");
  if (forcedScreen) useNav.getState().go(forcedScreen);
}

const info = await window.crewyard.appInfo();
const systemLanguage = pickLanguage(null, info.locales);
initI18n(pickLanguage(usePrefs.getState().language, info.locales));

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } } });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App systemLanguage={systemLanguage} platform={info.platform} />
    </QueryClientProvider>
  </StrictMode>,
);
