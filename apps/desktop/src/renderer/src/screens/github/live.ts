import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

// Shared by the GitHub screen and its status bar items.

/** Re-reads every github.* query when the daemon finishes a refresh (manual or the 60 s one). */
export function useGithubLive(): void {
  const qc = useQueryClient();
  useEffect(
    () =>
      window.crewyard.on("github.changed", () => {
        void qc.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith("github.") });
      }),
    [qc],
  );
}

/** Re-renders once a minute so "3 min ago" labels move on their own. */
export function useMinuteTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

export function useRelative(): (iso: string, now: number) => string {
  const { t, i18n } = useTranslation("github");
  const rtf = new Intl.RelativeTimeFormat(i18n.language, { numeric: "auto", style: "short" });
  return (iso, now) => {
    const minutes = Math.round((Date.parse(iso) - now) / 60_000);
    if (minutes === 0) return t("time.now");
    if (Math.abs(minutes) < 60) return rtf.format(minutes, "minute");
    const hours = Math.round(minutes / 60);
    if (Math.abs(hours) < 24) return rtf.format(hours, "hour");
    return rtf.format(Math.round(hours / 24), "day");
  };
}

export function useNumber(): (n: number) => string {
  const { i18n } = useTranslation();
  const nf = new Intl.NumberFormat(i18n.language);
  return (n) => nf.format(n);
}
