import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CommandSearch } from "./titlebar/CommandSearch.tsx";
import { Notifications } from "./titlebar/Notifications.tsx";
import { ProjectSwitcher } from "./titlebar/ProjectSwitcher.tsx";
import "./titlebar/titlebar.css";
import { matches } from "../keys.ts";

// Screenshot mode only (the main process sets the query): ?tb=search&tbq=... or ?tb=notifications
// opens a layer so it can be captured.
const shot = typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams();
const SHOT_LAYER = shot.get("tb");

type Layer = "search" | "notifications" | null;

/**
 * Brand, project switcher, command search and notifications (DESIGN.md §4). The bar is a window
 * drag region; every control opts out of it, and the native caption buttons stay on the right.
 */
export function TitleBar() {
  const { t } = useTranslation();
  const [layer, setLayer] = useState<Layer>(SHOT_LAYER === "search" || SHOT_LAYER === "notifications" ? SHOT_LAYER : null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (matches(e, "palette")) {
        e.preventDefault();
        setLayer((l) => (l === "search" ? null : "search"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <header className="titlebar">
      <div className="brand">
        <span className="mark" aria-hidden="true" />
        {t("app.name")}
      </div>
      <ProjectSwitcher />
      <div className="tb-drag" />
      <CommandSearch open={layer === "search"} initialQuery={SHOT_LAYER === "search" ? (shot.get("tbq") ?? "") : ""} onOpen={() => setLayer("search")} onClose={() => setLayer(null)} />
      <div className="tb-drag" />
      <Notifications open={layer === "notifications"} onOpen={() => setLayer("notifications")} onClose={() => setLayer(null)} />
    </header>
  );
}
