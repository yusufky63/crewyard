import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { PROVIDERS_CHANGED, type CatalogProvider, type Money, type ProfileRunner, type Provenance } from "@crewyard/core";
import { ProvenanceBadge } from "@crewyard/ui";

// Helpers shared by the Providers and Limits screens and the sidebar accounts block (all owned by
// the providers work), so the three never disagree on colors, labels or money formatting.

/** Refetches every providers.* query when the daemon reports a change in this area. */
export function useProvidersLive(): void {
  const qc = useQueryClient();
  useEffect(
    () =>
      window.crewyard.on(PROVIDERS_CHANGED, () => {
        void qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("providers.") });
      }),
    [qc],
  );
}

export const RUNNER_COLOR: Record<ProfileRunner, string> = {
  "claude-code": "var(--series-claude)",
  codex: "var(--series-codex)",
  "gemini-cli": "var(--series-gemini)",
  opencode: "var(--series-opencode)",
};

/** The runner hue for a provider's own first-party runner; everything else is the neutral series. */
export function providerColor(providerId: string): string {
  if (providerId === "anthropic") return RUNNER_COLOR["claude-code"];
  if (providerId === "openai") return RUNNER_COLOR.codex;
  if (providerId === "google") return RUNNER_COLOR["gemini-cli"];
  return "var(--series-other)";
}

export function useMoney() {
  const { i18n } = useTranslation();
  return (m: Money | number, digits = 2) => {
    const { amount, currency } = typeof m === "number" ? { amount: m, currency: "USD" } : m;
    try {
      return new Intl.NumberFormat(i18n.language, { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(amount);
    } catch {
      return `${amount.toFixed(digits)} ${currency}`;
    }
  };
}

/** Per-million price as models.dev lists it; up to 3 decimals so $0.435 keeps its precision. */
export function usePrice() {
  const { i18n } = useTranslation();
  return (usd: number) => new Intl.NumberFormat(i18n.language, { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 3 }).format(usd);
}

export function useWhen() {
  const { i18n } = useTranslation();
  const rtf = new Intl.RelativeTimeFormat(i18n.language, { numeric: "auto" });
  const dtf = new Intl.DateTimeFormat(i18n.language, { weekday: "short", hour: "2-digit", minute: "2-digit" });
  return {
    ago: (iso: string) => {
      const minutes = Math.round((Date.parse(iso) - Date.now()) / 60_000);
      if (Math.abs(minutes) < 60) return rtf.format(minutes, "minute");
      const hours = Math.round(minutes / 60);
      if (Math.abs(hours) < 24) return rtf.format(hours, "hour");
      return rtf.format(Math.round(hours / 24), "day");
    },
    at: (iso: string) => dtf.format(new Date(iso)),
    date: (iso: string) => new Intl.DateTimeFormat(i18n.language, { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso)),
  };
}

export function ProvBadge({ value }: { value: Provenance }) {
  const { t } = useTranslation("providers");
  return <ProvenanceBadge provenance={value}>{t(`provenance.${value}`)}</ProvenanceBadge>;
}

/** Newest models first, so the table shows what a provider currently offers. */
export const newestModels = (p: CatalogProvider, n = 2) => [...p.models].sort((a, b) => (b.released ?? "").localeCompare(a.released ?? "")).slice(0, n);
