import { useEffect, useState } from "react";
import { Keyboard } from "lucide-react";
import { useTranslation } from "react-i18next";
import { GROUPS, keycaps, keyText, matches, SHORTCUTS, ariaKeys } from "../../keys.ts";
import type { StatusItemDef } from "../../registry.ts";
import { Modal } from "../../screens/providers/Modal.tsx";
import "../keymap/keymap.css";

// The keyboard map (DESIGN.md §7): `?` or F1 anywhere, or the status bar button, opens a list of
// every shortcut. It is drawn from keys.ts, the table the handlers themselves match against.

const SHOT_OPEN = typeof location !== "undefined" && new URLSearchParams(location.search).get("keys") === "open";

/** Typing a `?` into a field is text, not a request for help; F1 always opens the map. */
const typing = (el: EventTarget | null) => el instanceof HTMLElement && Boolean(el.closest("input, textarea, select, [contenteditable]"));

export function KeyboardMap({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation("keys");
  const space = t("space");
  return (
    <Modal title={t("title")} onClose={onClose} wide>
      <p className="muted km-intro">{t("intro")}</p>
      <div className="km-groups">
        {GROUPS.map((g) => (
          <section key={g} className="km-group" aria-labelledby={`km-${g}`}>
            <h3 id={`km-${g}`} className="lbl">
              {t(`group.${g}`)}
            </h3>
            <dl className="km-list">
              {SHORTCUTS.filter((s) => s.group === g).map((s) => (
                <div key={s.id} className="km-row">
                  <dt>{t(`action.${s.id}`)}</dt>
                  <dd aria-label={keycaps(s.id, space).map((c) => c.join(" ")).join(` ${t("or")} `)}>
                    {keycaps(s.id, space).map((caps, i) => (
                      <span key={i} className="km-chord" aria-hidden="true">
                        {i > 0 && <span className="km-or">{t("or")}</span>}
                        {caps.map((c, j) => (
                          <kbd key={j} className="kbd">
                            {c}
                          </kbd>
                        ))}
                      </span>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}

function KeysStatus() {
  const { t } = useTranslation("keys");
  const [open, setOpen] = useState(SHOT_OPEN);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!matches(e, "help") || e.defaultPrevented) return;
      if (e.key !== "F1" && typing(e.target)) return;
      // Another dialog owns the keyboard until it closes.
      if (!open && document.querySelector("dialog[open]")) return;
      e.preventDefault();
      setOpen((o) => !o);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <>
      <button type="button" className="sb" onClick={() => setOpen(true)} title={t("button", { keys: keyText("help") })} aria-keyshortcuts={ariaKeys("help")}>
        <Keyboard size={13} strokeWidth={1.75} aria-hidden="true" />
        {t("short")}
      </button>
      {open && <KeyboardMap onClose={() => setOpen(false)} />}
    </>
  );
}

export const item: StatusItemDef = { id: "keys", side: "end", order: 95, component: KeysStatus };
