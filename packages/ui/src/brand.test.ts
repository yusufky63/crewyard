import { describe, expect, it } from "vitest";
import { RunnerId } from "@crewyard/core";
import catalog from "../../../catalog/providers.json" with { type: "json" };
import { BRAND_GLYPHS, MISSING_BRANDS, type BrandNode } from "./brand-icons.gen.ts";

const TAGS = new Set(["g", "path", "rect", "circle", "ellipse", "polygon", "polyline", "defs", "clipPath"]);
const walk = (nodes: BrandNode[], visit: (n: BrandNode) => void) =>
  nodes.forEach((n) => {
    visit(n);
    walk(n[2], visit);
  });

describe("brand glyphs", () => {
  it("cover every catalog provider", () => {
    const without = catalog.providers.map((p) => p.id).filter((id) => !(id in BRAND_GLYPHS));
    expect(without).toEqual(MISSING_BRANDS);
  });

  it("cover every real runner and the git tools", () => {
    const runners = RunnerId.options.filter((r) => r !== "acp" && r !== "fake");
    for (const id of [...runners, "git", "github"]) expect(BRAND_GLYPHS).toHaveProperty(id);
  });

  it("contain only plain shapes in the text color", () => {
    for (const [id, glyph] of Object.entries(BRAND_GLYPHS)) {
      expect(["currentColor", "none"], id).toContain(glyph.fill);
      walk(glyph.nodes, ([tag, attrs]) => {
        expect(TAGS.has(tag), `${id}: <${tag}>`).toBe(true);
        for (const key of ["fill", "stroke"]) if (attrs[key]) expect(["currentColor", "none"], id).toContain(attrs[key]);
        for (const [key, value] of Object.entries(attrs)) {
          expect(key.startsWith("on") || key === "href", `${id}: ${key}`).toBe(false);
          if (key !== "clipPath") expect(value.includes("url("), `${id}: ${key}`).toBe(false);
        }
      });
    }
  });
});
