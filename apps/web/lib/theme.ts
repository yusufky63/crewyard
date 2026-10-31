// The site follows the visitor's system theme unless they pick one. packages/ui/tokens.css (the app's
// generated tokens) only colours :root[data-theme=...], because the app always sets the attribute; the
// site leaves it unset for "system", so this file builds the matching prefers-color-scheme blocks
// from the same design/tokens JSON. Names follow scripts/build-tokens.mjs (color.bg.canvas ->
// --bg-canvas), and theme.test.ts checks every value against tokens.css, so the two cannot drift.
import dark from "../../../design/tokens/dark.json";
import light from "../../../design/tokens/light.json";

type TokenNode = { [key: string]: TokenNode | string | number | undefined; $value?: string | number };

export type ThemeName = "dark" | "light";

/** [css variable, value] for every token of a theme file, in file order. */
export function themeVariables(tokens: TokenNode, prefix: string[] = []): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(tokens)) {
    if (key.startsWith("$") || value === undefined || typeof value !== "object") continue;
    const path = [...prefix, key];
    if ("$value" in value && value.$value !== undefined) {
      out.push([`--${(path[0] === "color" ? path.slice(1) : path).join("-")}`, String(value.$value)]);
    } else {
      out.push(...themeVariables(value, path));
    }
  }
  return out;
}

export const THEME_TOKENS: Record<ThemeName, Array<[string, string]>> = {
  dark: themeVariables(dark as TokenNode),
  light: themeVariables(light as TokenNode),
};

/** Whether the site's own theme-dependent switches (screenshot variants) show the dark or the light one. */
const SWITCHES: Record<ThemeName, string> = {
  dark: "--show-dark: block; --show-light: none;",
  light: "--show-dark: none; --show-light: block;",
};

const block = (theme: ThemeName) => `color-scheme: ${theme}; ${SWITCHES[theme]} ${THEME_TOKENS[theme].map(([k, v]) => `${k}: ${v};`).join(" ")}`;

/**
 * CSS for the <style> in the root layout: dark by default, light when the system asks for it, each
 * only while no theme was picked (no data-theme attribute). A picked theme takes tokens.css's own
 * blocks; the switches for it are here too.
 */
export function themeCss(): string {
  return [
    `:root:not([data-theme]) { ${block("dark")} }`,
    `@media (prefers-color-scheme: light) { :root:not([data-theme]) { ${block("light")} } }`,
    `:root[data-theme="dark"] { ${SWITCHES.dark} }`,
    `:root[data-theme="light"] { ${SWITCHES.light} }`,
  ].join("\n");
}

/** localStorage key for a picked theme; absent means "follow the system". */
export const THEME_KEY = "crewyard-site:theme";

/** Runs before the first paint, so a picked theme never flashes the other one. */
export const THEME_BOOT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t==="dark"||t==="light")document.documentElement.setAttribute("data-theme",t);}catch(e){}})();`;
