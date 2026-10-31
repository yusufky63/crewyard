"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";
import { THEME_KEY } from "@/lib/theme";

type Choice = "system" | "light" | "dark";
const ORDER: Choice[] = ["system", "light", "dark"];
const LABEL: Record<Choice, string> = { system: "System", light: "Light", dark: "Dark" };
const CHANGED = "crewyard-site:theme-changed";

function read(): Choice {
  const t = document.documentElement.getAttribute("data-theme");
  return t === "light" || t === "dark" ? t : "system";
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGED, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGED, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** "System" removes the attribute, so the prefers-color-scheme blocks in the root layout apply again. */
function apply(choice: Choice): void {
  const root = document.documentElement;
  try {
    if (choice === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch {
    // storage blocked: the choice still holds for this page
  }
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
  window.dispatchEvent(new Event(CHANGED));
}

export function ThemeToggle() {
  const choice = useSyncExternalStore(subscribe, read, () => "system" as Choice);
  const next = ORDER[(ORDER.indexOf(choice) + 1) % ORDER.length]!;
  const Icon = choice === "light" ? Sun : choice === "dark" ? Moon : Monitor;
  return (
    <button type="button" className="theme-btn" onClick={() => apply(next)} aria-label={`Theme: ${LABEL[choice]}. Switch to ${LABEL[next]}`} title={`Theme: ${LABEL[choice]}`}>
      <Icon strokeWidth={1.5} aria-hidden />
    </button>
  );
}
