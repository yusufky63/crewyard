import { Languages, Rows3, SunMoon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { LANGUAGES } from "../i18n.ts";
import { nextTheme, usePrefs } from "../prefs.ts";
import { statusItems } from "../registry.ts";

// System state lives here so the title bar stays short (DESIGN.md §4). Feature items register
// themselves in ./status; theme, density and language switches always sit at the end.

function Preferences() {
  const { t, i18n } = useTranslation();
  const { theme, density, setTheme, setDensity, setLanguage } = usePrefs();
  const current = LANGUAGES.find((l) => l === i18n.language) ?? "en";
  const other = LANGUAGES.find((l) => l !== current) ?? "en";
  return (
    <>
      <button className="sb" onClick={() => setLanguage(other)} title={t("status.languageTitle")}>
        <Languages size={13} strokeWidth={1.75} />
        <b>{t(`status.language.${current}`)}</b>
      </button>
      <button className="sb" onClick={() => setTheme(nextTheme(theme))} title={t("status.themeTitle")}>
        <SunMoon size={13} strokeWidth={1.75} />
        <b>{t(`status.theme.${theme}`)}</b>
      </button>
      <button className="sb" onClick={() => setDensity(density === "compact" ? "comfortable" : "compact")} title={t("status.densityTitle")}>
        <Rows3 size={13} strokeWidth={1.75} />
        <b>{t(`status.density.${density}`)}</b>
      </button>
    </>
  );
}

export function StatusBar() {
  const { t } = useTranslation();
  const start = statusItems.filter((i) => i.side === "start");
  const end = statusItems.filter((i) => i.side === "end");
  return (
    <footer className="statusbar" aria-label={t("status.label")}>
      {start.map(({ id, component: C }) => (
        <C key={id} />
      ))}
      <div className="end">
        {end.map(({ id, component: C }) => (
          <C key={id} />
        ))}
        <Preferences />
      </div>
    </footer>
  );
}
