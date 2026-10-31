import { GENERIC_CARD, OG, OG_ALT, renderCard } from "@/lib/og";

// The site card: static, it reads no data, so it can never fail.
export const alt = OG_ALT;
export const size = OG.size;
export const contentType = "image/png";

export default function Image() {
  return renderCard(GENERIC_CARD);
}
