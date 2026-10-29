import { describe, expect, it } from "vitest";
import { LANGUAGES, pickLanguage, resources } from "./i18n.ts";

// Every screen adds its own namespace; these checks keep English and Turkish in step.

const flatten = (node: unknown, prefix = ""): Record<string, string> => {
  if (typeof node === "string") return { [prefix]: node };
  if (!node || typeof node !== "object") return {};
  return Object.entries(node).reduce<Record<string, string>>((acc, [k, v]) => ({ ...acc, ...flatten(v, prefix ? `${prefix}.${k}` : k) }), {});
};
// i18next plural forms differ per language; compare their base key.
const baseKey = (k: string) => k.replace(/_(zero|one|two|few|many|other)$/, "");
const vars = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();

describe("locales", () => {
  const en = resources.en ?? {};

  it("has the same namespaces in every language", () => {
    for (const lang of LANGUAGES) expect(Object.keys(resources[lang] ?? {}).sort()).toEqual(Object.keys(en).sort());
  });

  for (const ns of Object.keys(en)) {
    it(`keeps keys, text and placeholders in step for "${ns}"`, () => {
      const ref = flatten(en[ns]);
      for (const lang of LANGUAGES) {
        const cur = flatten(resources[lang]?.[ns]);
        expect(new Set(Object.keys(cur).map(baseKey))).toEqual(new Set(Object.keys(ref).map(baseKey)));
        for (const [k, v] of Object.entries(cur)) {
          expect(v.trim(), `${lang}/${ns}:${k} is empty`).not.toBe("");
          const refValue = ref[k] ?? ref[`${baseKey(k)}_other`] ?? "";
          expect(vars(v), `${lang}/${ns}:${k} placeholders`).toEqual(vars(refValue));
        }
      }
    });
  }
});

describe("pickLanguage", () => {
  it("follows the system order and falls back to English", () => {
    expect(pickLanguage(null, ["tr-TR", "en-US"])).toBe("tr");
    expect(pickLanguage(null, ["de-DE", "en-GB"])).toBe("en");
    expect(pickLanguage(null, ["fr-FR"])).toBe("en");
    expect(pickLanguage("en", ["tr-TR"])).toBe("en");
  });
});
