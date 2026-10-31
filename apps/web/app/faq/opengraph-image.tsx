import { OG, renderCard } from "@/lib/og";

export const alt = "Crewyard FAQ";
export const size = OG.size;
export const contentType = "image/png";

export default function Image() {
  return renderCard({
    eyebrow: "FAQ",
    title: "Questions and answers",
    lead: "Supported systems, cost, agents and providers, approvals, limits, the unsigned pre-release and updates.",
    facts: ["Short answers"],
  });
}
