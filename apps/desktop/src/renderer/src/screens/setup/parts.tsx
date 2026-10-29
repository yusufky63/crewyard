import type { ReactNode } from "react";
import { AlertTriangle, Check, X } from "lucide-react";

// Small pieces shared by the wizard's steps. Kept here until a second screen needs them (AGENTS.md).

export type RowState = "ok" | "wait" | "bad" | "run" | "none";

export function StateIcon({ state }: { state: RowState }) {
  if (state === "none") return <span />;
  if (state === "run") return <span className="st st-run"><span className="spin" /></span>;
  const Icon = state === "ok" ? Check : state === "bad" ? X : AlertTriangle;
  return (
    <span className={`st st-${state}`}>
      <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
    </span>
  );
}

/** One line of a check list: state icon, label, value, optional action. */
export function Row({ state, label, children, action }: { state: RowState; label: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="cl">
      <StateIcon state={state} />
      <span className="muted">{label}</span>
      <span className="cl-val">{children}</span>
      <span className="cl-act">{action}</span>
    </div>
  );
}

/** A native checkbox (keyboard and screen readers) drawn as the square .cbox of the design. */
export function CheckBox({ checked, disabled, onChange, label }: { checked: boolean; disabled?: boolean; onChange?: (v: boolean) => void; label: string }) {
  return (
    <label className={`cbox-wrap${disabled ? " disabled" : ""}`}>
      <input type="checkbox" className="cbox-input" checked={checked} disabled={disabled} onChange={(e) => onChange?.(e.target.checked)} aria-label={label} />
      <span className={`cbox${checked ? " on" : ""}`} aria-hidden="true">
        {checked && <Check size={12} strokeWidth={2} />}
      </span>
    </label>
  );
}

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
