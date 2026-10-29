// Pure tick layout for TickMeter, kept separate so it can be tested without a DOM.

export const WARN_PCT = 80;
export const CRIT_PCT = 95;

export type TickClass = "" | "tall" | "on" | "w" | "cr" | "th" | "tall on" | "tall w" | "tall cr" | "tall th";

export function tickClasses(valuePct: number | null, ticks = 48): TickClass[] {
  const filled = valuePct === null ? 0 : Math.round((Math.min(100, Math.max(0, valuePct)) / 100) * ticks);
  const warnAt = Math.round((WARN_PCT / 100) * ticks);
  const critAt = Math.round((CRIT_PCT / 100) * ticks);
  return Array.from({ length: ticks }, (_, i) => {
    const tall = ticks === 48 && i % 6 === 0 ? "tall" : "";
    let fill = "";
    if (valuePct !== null && i < filled) fill = i >= critAt ? "cr" : i >= warnAt ? "w" : "on";
    else if (valuePct !== null && (i === warnAt || i === critAt)) fill = "th";
    return [tall, fill].filter(Boolean).join(" ") as TickClass;
  });
}
