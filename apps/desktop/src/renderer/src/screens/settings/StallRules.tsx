import { useState } from "react";
import { useTranslation } from "react-i18next";
import { STALL_LIMITS, type SettingsPatch, type StallSettings } from "@crewyard/core";
import { Row } from "./parts.tsx";

// Stall rules (feature scan A7), under Notifications: when a quiet run, a repeating failure or an
// unanswered request becomes an Inbox item, and how long the same item stays quiet afterwards.
// 0 turns a rule off; the daemon enforces the same bounds (STALL_LIMITS).

type Key = keyof StallSettings;

function NumberField({ k, value, unit, onCommit }: { k: Key; value: number; unit: string; onCommit: (v: number) => void }) {
  const { t } = useTranslation("settings");
  const { min, max } = STALL_LIMITS[k];
  // Keyed by the saved value, so a save elsewhere resets the draft.
  const [draft, setDraft] = useState(String(value));
  const parsed = Number(draft);
  const valid = draft.trim() !== "" && Number.isInteger(parsed) && parsed >= min && parsed <= max;
  const commit = () => {
    if (valid && parsed !== value) onCommit(parsed);
    else if (!valid) setDraft(String(value));
  };
  return (
    <label className="st-number">
      <input
        type="number"
        className="pv-input mono"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={draft}
        aria-label={t(`stalls.${k}`)}
        aria-invalid={!valid}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
      <span className="lbl">{unit}</span>
    </label>
  );
}

export function StallRules({ stalls, save }: { stalls: StallSettings; save: (patch: SettingsPatch) => void }) {
  const { t } = useTranslation("settings");
  const field = (k: Key, unit: string) => <NumberField key={`${k}${stalls[k]}`} k={k} value={stalls[k]} unit={unit} onCommit={(v) => save({ stalls: { [k]: v } })} />;
  return (
    <>
      <Row label={t("stalls.title")} hint={t("stalls.hint")} />
      <Row label={t("stalls.noEventsMinutes")} hint={t("stalls.noEventsHint")}>
        {field("noEventsMinutes", t("stalls.minutes"))}
      </Row>
      <Row label={t("stalls.sameFailureCount")} hint={t("stalls.sameFailureHint")}>
        {field("sameFailureCount", t("stalls.runs"))}
      </Row>
      <Row label={t("stalls.requestMinutes")} hint={t("stalls.requestHint")}>
        {field("requestMinutes", t("stalls.minutes"))}
      </Row>
      <Row label={t("stalls.cooldownMinutes")} hint={t("stalls.cooldownHint")}>
        {field("cooldownMinutes", t("stalls.minutes"))}
      </Row>
    </>
  );
}
