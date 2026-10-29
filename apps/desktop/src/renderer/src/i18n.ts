import i18n from "i18next";
import { initReactI18next } from "react-i18next";

// One JSON file per language and namespace: locales/<lang>/<namespace>.json. Each screen owns its
// namespace, so parallel work never edits the same translation file.

export const LANGUAGES = ["en", "tr"] as const;
export type Language = (typeof LANGUAGES)[number];

const files = import.meta.glob<{ default: Record<string, unknown> }>("../locales/*/*.json", { eager: true });

export const resources: Record<string, Record<string, Record<string, unknown>>> = {};
for (const [path, mod] of Object.entries(files)) {
  const m = path.match(/locales\/([^/]+)\/([^/]+)\.json$/);
  if (!m?.[1] || !m[2]) continue;
  (resources[m[1]] ??= {})[m[2]] = mod.default;
}

/** First supported language in the system's preference order; English otherwise. */
export function pickLanguage(pref: Language | null, systemLocales: string[]): Language {
  if (pref) return pref;
  for (const locale of systemLocales) {
    const base = locale.toLowerCase().split(/[-_]/)[0];
    const hit = LANGUAGES.find((l) => l === base);
    if (hit) return hit;
  }
  return "en";
}

export function initI18n(lng: Language): typeof i18n {
  void i18n.use(initReactI18next).init({
    resources,
    lng,
    fallbackLng: "en",
    defaultNS: "common",
    ns: Object.keys(resources.en ?? {}),
    interpolation: { escapeValue: false },
    returnNull: false,
  });
  return i18n;
}
