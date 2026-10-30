import en from "../renderer/locales/en/desktop.json";
import tr from "../renderer/locales/tr/desktop.json";

// Text for the tray, toasts and native dialogs. The main process has no i18next: it reads the
// `desktop` namespace the renderer also ships (so the i18n test keeps both languages complete) and
// follows the language the renderer reports, or the Windows display language before that.

export type MainLanguage = "en" | "tr";
const TABLES: Record<MainLanguage, unknown> = { en, tr };

export function pickMainLanguage(locales: readonly string[]): MainLanguage {
  for (const l of locales) {
    const base = l.toLowerCase().split(/[-_]/)[0];
    if (base === "en" || base === "tr") return base;
  }
  return "en";
}

function lookup(table: unknown, key: string): string | null {
  let node: unknown = table;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) return null;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : null;
}

export type Translate = (key: string, vars?: Record<string, string | number>) => string;

export function translator(lang: MainLanguage): Translate {
  return (key, vars = {}) => {
    const text = lookup(TABLES[lang], key) ?? lookup(TABLES.en, key) ?? key;
    return text.replace(/\{\{(\w+)\}\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
  };
}
