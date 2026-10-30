import { useState } from "react";
import { useTranslation } from "react-i18next";
import { HIBERNATION_LIMITS, type AppSettings, type SettingsPatch } from "@crewyard/core";
import { Row, Toggle } from "./parts.tsx";

// Hibernation: a run whose process sits idle (in practice, waiting on your answer) has the process
// stopped after this many minutes, freeing memory and its slot; it wakes by session id. The daemon
// enforces the same bounds (HIBERNATION_LIMITS).

export function HibernationRows({ settings, save }: { settings: AppSettings; save: (patch: SettingsPatch) => void }) {
  const { t } = useTranslation("settings");
  const h = settings.hibernation;
  const { min, max } = HIBERNATION_LIMITS.idleMinutes;
  // Keyed by the saved value below, so a save elsewhere resets the draft.
  const [draft, setDraft] = useState(String(h.idleMinutes));
  const parsed = Number(draft);
  const valid = draft.trim() !== "" && Number.isInteger(parsed) && parsed >= min && parsed <= max;
  const commit = () => {
    if (valid && parsed !== h.idleMinutes) save({ hibernation: { idleMinutes: parsed } });
    else if (!valid) setDraft(String(h.idleMinutes));
  };
  return (
    <>
      <Row label={t("hibernation.label")} hint={t("hibernation.hint")}>
        <Toggle label={t("hibernation.label")} value={h.enabled} onChange={(v) => save({ hibernation: { enabled: v } })} />
      </Row>
      <Row label={t("hibernation.after")} hint={t("hibernation.afterHint", { min, max })}>
        <label className="st-number">
          <input
            type="number"
            className="pv-input mono"
            inputMode="numeric"
            min={min}
            max={max}
            step={1}
            value={draft}
            disabled={!h.enabled}
            aria-label={t("hibernation.after")}
            aria-invalid={!valid}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.key === "Enter" && commit()}
          />
          <span className="lbl">{t("stalls.minutes")}</span>
        </label>
      </Row>
    </>
  );
}
