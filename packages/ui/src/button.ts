export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
/** A state colour for an action that has one (Turn on in ok, Turn off in warn, Stop in bad); never on primary. */
export type Tone = "ok" | "warn" | "bad";

/**
 * The class list of a `Button`. The primary button stays monochrome, so a tone never reaches it; a disabled button
 * drops its tone, so a blocked Merge under failing checks or a Pause all with nothing to pause never reads as "go"
 * or "look" (DESIGN.md §3 "State colors on actions").
 */
export function buttonClass({ variant = "secondary", size = "md", tone, disabled = false, className = "" }: { variant?: ButtonVariant; size?: "md" | "sm"; tone?: Tone | undefined; disabled?: boolean | undefined; className?: string }): string {
  const v = variant === "secondary" ? "" : ` btn-${variant}`;
  const toned = tone && !disabled && variant !== "primary" ? ` btn-${tone}` : "";
  return `btn${v}${toned}${size === "sm" ? " btn-sm" : ""} ${className}`.trim();
}
