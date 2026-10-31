import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Keyboard } from "lucide-react";
import { useTranslation } from "react-i18next";
import { GROUPS, keycaps, keyText, matches, sequenceStep, SHORTCUTS, ariaKeys, type SequenceState, type ShortcutId } from "../../keys.ts";
import { useNav } from "../../nav.ts";
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

/** G then a letter jumps to a project screen (DESIGN.md §7). */
const JUMPS: Array<[ShortcutId, () => string]> = [
  ["go.tasks", () => "tasks"],
  ["go.inbox", () => "inbox"],
  ["go.crew", () => "crew"],
  ["go.limits", () => "limits"],
  ["go.providers", () => "providers"],
  ["go.github", () => "github"],
  ["go.guide", () => "guide"],
];

/** The Guide teaches from Start too, so its jump works without a project. */
const WITHOUT_PROJECT = new Set(["guide"]);

function KeysStatus() {
  const { t } = useTranslation("keys");
  const [open, setOpen] = useState(SHOT_OPEN);
  const seq = useRef<SequenceState>({ prefix: null, at: 0 });
  useEffect(() => {
    const onJump = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || typing(e.target) || document.querySelector("dialog[open], [role=menu]")) return;
      const step = sequenceStep(seq.current, e, Date.now());
      seq.current = step.state;
      const to = JUMPS.find(([id]) => id === step.id)?.[1]();
      // Project screens need an open project; on Start only the Guide's jump works.
      if (!to || (!useNav.getState().projectId && !WITHOUT_PROJECT.has(to))) return;
      e.preventDefault();
      useNav.getState().go(to);
    };
    window.addEventListener("keydown", onJump);
    return () => window.removeEventListener("keydown", onJump);
  }, []);
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
      {/* In the body, not the status bar, so it does not take on the bar's mono, no-wrap type. */}
      {open && createPortal(<KeyboardMap onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

export const item: StatusItemDef = { id: "keys", side: "end", order: 95, component: KeysStatus };
