import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// The monorepo root: the site imports the design tokens (design/tokens/*.json) and the shared CSS of
// packages/ui, so Turbopack and output tracing must see the whole workspace, not only apps/web.
const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
];

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // `next dev` would otherwise write its own AGENTS.md into apps/web; the repository's rules for
  // agents live in the root AGENTS.md.
  agentRules: false,
  turbopack: { root: workspaceRoot },
  outputFileTracingRoot: workspaceRoot,
  // Share cards read the Geist WOFF files with fs at request time (lib/og.tsx); a card regenerated
  // on the server needs them traced next to its function.
  outputFileTracingIncludes: {
    "/**": [
      "./node_modules/@fontsource/geist-sans/files/geist-sans-latin-400-normal.woff",
      "./node_modules/@fontsource/geist-sans/files/geist-sans-latin-500-normal.woff",
      "./node_modules/@fontsource/geist-sans/files/geist-sans-latin-600-normal.woff",
      "./node_modules/@fontsource/geist-mono/files/geist-mono-latin-500-normal.woff",
    ],
  },
  // packages/ui ships TypeScript sources; the brand marks come from it.
  transpilePackages: ["@crewyard/ui"],
  experimental: { optimizePackageImports: ["@crewyard/ui", "lucide-react"] },
  images: {
    // Screenshots are committed as already optimized WebP; they are served as they are.
    unoptimized: true,
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default config;
