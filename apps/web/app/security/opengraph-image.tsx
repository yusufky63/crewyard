import { OG, renderCard } from "@/lib/og";

export const alt = "Crewyard security: keys, sign-in, local connections and approvals";
export const size = OG.size;
export const contentType = "image/png";

export default function Image() {
  return renderCard({
    eyebrow: "Security",
    title: "Your keys stay with the runner",
    lead: "Encrypted API keys passed only as environment variables, no TCP listener, and your approval for every outward step.",
    facts: ["DPAPI", "Keychain", "Secret Service"],
  });
}
