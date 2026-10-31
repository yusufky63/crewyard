import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Panel } from "@crewyard/ui";

type Tone = "ok" | "warn" | "bad";

/**
 * `lang` on an option keeps an endonym in its own casing under uppercase labels ("English", not "ENGLİSH").
 * `tone` colours an option while it is the chosen one (On in ok, a kill switch's On in bad); its word still says it.
 */
export function Seg<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled = false,
}: {
  value: T;
  options: Array<{ value: T; label: string; lang?: string; tone?: Tone }>;
  onChange: (v: T) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          lang={o.lang}
          className={o.tone ? `seg-${o.tone}` : undefined}
          aria-pressed={o.value === value}
          disabled={disabled}
          onClick={() => o.value !== value && onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * On / Off as a segmented pair, the switch of this design (DESIGN.md §1, R2). A chosen On shows in ok by default
 * (owner, 2026-10-31: "turn off veya turn on ... ilgili renkler kullan"); a switch whose On stops things, such as
 * Stop Autopilot, passes `onTone="bad"`. A chosen Off stays neutral: off is an ordinary choice for most settings.
 */
export function Toggle({ value, onChange, label, disabled = false, onTone = "ok" }: { value: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; onTone?: Tone }) {
  const { t } = useTranslation("settings");
  return (
    <Seg
      value={value ? "on" : "off"}
      label={label}
      disabled={disabled}
      options={[
        { value: "on", label: t("on"), tone: onTone },
        { value: "off", label: t("off") },
      ]}
      onChange={(v) => onChange(v === "on")}
    />
  );
}

export function Row({ label, hint, children, id }: { label: string; hint?: ReactNode; children?: ReactNode; id?: string }) {
  return (
    <div className="st-row">
      <div className="st-text">
        <div className="st-label" id={id}>
          {label}
        </div>
        {hint && <div className="st-hint">{hint}</div>}
      </div>
      {children && <div className="st-ctl">{children}</div>}
    </div>
  );
}

export function Section({ id, index, title, children }: { id: string; index: number; title: string; children: ReactNode }) {
  return (
    <section id={`settings-${id}`} aria-labelledby={`settings-${id}-title`} className="st-section">
      <Panel>
        <div className="ph">
          <span className="lbl">{String(index).padStart(2, "0")}</span>
          <h2 id={`settings-${id}-title`}>{title}</h2>
        </div>
        <div className="st-body">{children}</div>
      </Panel>
    </section>
  );
}

/** A label and a path or value in mono, as typed or as on disk (`.as-typed`, DESIGN.md §3). */
export function Fact({ label, value, action }: { label: string; value: ReactNode; action?: ReactNode }) {
  return (
    <div className="st-fact">
      <span className="lbl">{label}</span>
      <span className="st-fact-v mono as-typed">{value}</span>
      {action && <span className="st-fact-a">{action}</span>}
    </div>
  );
}
