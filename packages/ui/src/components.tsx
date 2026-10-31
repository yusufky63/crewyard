import type { ButtonHTMLAttributes, CSSProperties, HTMLAttributes, ReactNode } from "react";
import type { Provenance } from "@crewyard/core";
import { tickClasses } from "./meter.ts";

type Variant = "primary" | "secondary" | "ghost" | "danger";
/** A state colour for an action that has one (Turn on in ok, Turn off in warn, Stop in bad); never on primary. */
export type Tone = "ok" | "warn" | "bad";

export function Button({
  variant = "secondary",
  size = "md",
  tone,
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "md" | "sm"; tone?: Tone }) {
  const v = variant === "secondary" ? "" : ` btn-${variant}`;
  const toned = tone && variant !== "primary" ? ` btn-${tone}` : "";
  return <button type="button" className={`btn${v}${toned}${size === "sm" ? " btn-sm" : ""} ${className}`.trim()} {...rest} />;
}

export function Panel({ className = "", ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`panel ${className}`.trim()} {...rest} />;
}

export function Label({ className = "", ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={`lbl ${className}`.trim()} {...rest} />;
}

export function Dot({ color }: { color: string }) {
  return <i className="dot" style={{ "--c": color } as CSSProperties} aria-hidden="true" />;
}

/** Every quota or cost number carries one of these. The label text comes from the caller (i18n). */
export function ProvenanceBadge({ provenance, children }: { provenance: Provenance; children: ReactNode }) {
  return <span className={`badge badge-${provenance}`}>{children}</span>;
}

export function TickMeter({
  value,
  ticks = 48,
  size = "md",
  color = "var(--accent)",
  label,
}: {
  value: number | null;
  ticks?: number;
  size?: "md" | "sm" | "xs";
  color?: string;
  label: string;
}) {
  const unknown = value === null;
  const classes = tickClasses(value, ticks);
  const cls = ["meter", size === "md" ? "" : size, unknown ? "unknown" : ""].filter(Boolean).join(" ");
  return (
    <div
      className={cls}
      style={{ "--n": ticks, "--c": color } as CSSProperties}
      role="meter"
      aria-label={label}
      aria-valuemin={unknown ? undefined : 0}
      aria-valuemax={unknown ? undefined : 100}
      aria-valuenow={unknown ? undefined : Math.round(value)}
    >
      {classes.map((c, i) => (
        <i key={i} className={c} />
      ))}
      {!unknown && size === "md" && <span className="handle" style={{ left: `${Math.min(100, Math.max(0, value))}%` }} />}
    </div>
  );
}
