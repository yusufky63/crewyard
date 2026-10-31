import { useTranslation } from "react-i18next";
import type { RequestView } from "@crewyard/core";
import { riskTone } from "./model.ts";

/**
 * Low, Medium or High risk as a tone chip: the colour repeats the word, never replaces it (DESIGN.md §8). Shared by
 * the Inbox and the title bar's notifications, so a risk level reads the same in both.
 */
export function RiskBadge({ risk }: { risk: NonNullable<RequestView["risk"]> }) {
  const { t } = useTranslation("inbox");
  return <span className={`badge badge-${riskTone(risk)}`}>{t(`risk.${risk}`)}</span>;
}
