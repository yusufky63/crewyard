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
import { usePrefs } from "./prefs.ts";

// ?theme= and ?lang= are only set by the main process in screenshot mode.
const query = new URLSearchParams(location.search);
const forcedTheme = query.get("theme");
if (forcedTheme === "dark" || forcedTheme === "light") usePrefs.setState({ theme: forcedTheme });
const forcedLang = query.get("lang");
if (forcedLang === "en" || forcedLang === "tr") usePrefs.setState({ language: forcedLang });
const forcedScreen = query.get("screen");
if (forcedScreen) useNav.setState({ screen: forcedScreen });

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
