import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/500.css";
import "@fontsource/geist-sans/600.css";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "@crewyard/ui/tokens.css";
import "@crewyard/ui/styles.css";
import "./site.css";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Footer } from "@/components/footer";
import { Header } from "@/components/header";
import { SITE } from "@/lib/site";
import { THEME_BOOT, THEME_TOKENS, themeCss } from "@/lib/theme";

const tokenValue = (theme: "dark" | "light", name: string) => THEME_TOKENS[theme].find(([k]) => k === name)?.[1] ?? "#000000";

export const metadata: Metadata = {
  metadataBase: new URL(SITE.url),
  title: { default: `${SITE.name}: run crews of coding agents`, template: `%s · ${SITE.name}` },
  description: SITE.description,
  applicationName: SITE.name,
  authors: [{ name: "Yusuf", url: `https://github.com/${SITE.owner}` }],
  openGraph: { type: "website", siteName: SITE.name, locale: "en_US", url: "/" },
  twitter: { card: "summary_large_image" },
  alternates: { canonical: "/" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: tokenValue("light", "--bg-canvas") },
    { media: "(prefers-color-scheme: dark)", color: tokenValue("dark", "--bg-canvas") },
  ],
  colorScheme: "dark light",
};

const JSON_LD = JSON.stringify({
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "WebSite", name: SITE.name, url: SITE.url, description: SITE.description },
    {
      "@type": "SoftwareApplication",
      name: SITE.name,
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Windows, macOS, Linux",
      url: SITE.url,
      downloadUrl: `${SITE.url}/download`,
      license: "https://opensource.org/licenses/MIT",
      codeRepository: SITE.repoUrl,
    },
  ],
}).replace(/</g, "\\u003c");

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // data-theme is set before paint only when the visitor picked a theme; otherwise the
    // prefers-color-scheme blocks below decide, live, with no script.
    <html lang="en" data-density="comfortable" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
        <style dangerouslySetInnerHTML={{ __html: themeCss() }} />
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON_LD }} />
      </head>
      <body>
        <a className="skip" href="#main">
          Skip to content
        </a>
        <Header />
        <main id="main">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
