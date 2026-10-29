import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";

/** Native <dialog>: focus stays inside, Esc closes, and focus returns to the opener afterwards. */
export function Modal({ title, onClose, children, footer, wide = false }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const { t } = useTranslation("providers");
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    // showModal() focuses the first control (the close button); move to the field that matters.
    d?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => d?.close();
  }, []);
  return (
    <dialog ref={ref} className={`pv-modal panel${wide ? " wide" : ""}`} aria-label={title} 
      onCancel={(e) => {
        // Let React unmount the dialog instead of the browser closing it underneath us.
        e.preventDefault();
        onClose();
      }}
    >
      <div className="pv-modal-head">
        <h2>{title}</h2>
        <button type="button" className="pv-x" onClick={onClose} aria-label={t("dialog.close")}>
          <X size={16} strokeWidth={1.75} />
        </button>
      </div>
      <div className="pv-modal-body">{children}</div>
      {footer && <div className="pv-modal-foot">{footer}</div>}
    </dialog>
  );
}

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="pv-field">
      <label className="lbl" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && <div className="pv-hint">{hint}</div>}
    </div>
  );
}
