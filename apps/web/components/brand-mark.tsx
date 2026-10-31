"use client";

import { BrandIcon } from "@crewyard/ui";

// The vendor marks the app shows (packages/ui, generated from models.dev and simple-icons). A client
// component because the package's barrel also exports stateful primitives; optimizePackageImports in
// next.config.ts keeps only the brand module in the bundle. Marks stay monochrome, next to the name.
export function BrandMark({ id, size = 16, label }: { id: string; size?: number; label?: string }) {
  return <BrandIcon id={id} size={size} {...(label ? { label } : {})} />;
}
