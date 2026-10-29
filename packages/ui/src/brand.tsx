import { createElement, useId, type ReactNode } from "react";
import { BRAND_GLYPHS, type BrandNode } from "./brand-icons.gen.ts";

export type BrandId = keyof typeof BRAND_GLYPHS;

export const hasBrandIcon = (id: string): id is BrandId => Object.hasOwn(BRAND_GLYPHS, id);

// Clip path ids get a per-instance prefix, so two copies of one logo never share a DOM id.
function renderNodes(nodes: BrandNode[], prefix: string): ReactNode[] {
  return nodes.map(([tag, attrs, children], i) => {
    const props: Record<string, string | number> = { ...attrs, key: i };
    if (attrs.id) props.id = prefix + attrs.id;
    if (attrs.clipPath) props.clipPath = attrs.clipPath.replace("url(#", `url(#${prefix}`);
    return createElement(tag, props, ...renderNodes(children, prefix));
  });
}

/**
 * The vendor's own mark for a provider (catalog id), runner (RunnerId) or tool ("git", "github"),
 * drawn in the current text color. Renders nothing for an id without a logo.
 */
export function BrandIcon({ id, size = 16, label }: { id: string; size?: number; label?: string }) {
  const prefix = `b${useId().replace(/[^\w-]/g, "")}-`;
  if (!hasBrandIcon(id)) return null;
  const glyph = BRAND_GLYPHS[id];
  return (
    <svg
      className="brand"
      width={size}
      height={size}
      viewBox={glyph.viewBox}
      fill={glyph.fill}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {renderNodes(glyph.nodes, prefix)}
    </svg>
  );
}
