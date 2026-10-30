import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AccountSwitchSettings, AppSettings, SettingsPatch } from "@crewyard/core";
import { Button } from "@crewyard/ui";
import { Row, Toggle } from "./parts.tsx";

// Same-provider account switching (docs/adr/0009). Off by default. Turning it on the first time
// shows the provider-terms note; accepting it is recorded once, and the daemon refuses to turn it
// on before that (`settings.terms`). Tasks are held out one by one from the crew proposal or the
// Inbox, so this section only says where.

/** Screenshot runs: `accountSwitch=terms` opens the note, `accountSwitch=on` draws the accepted, on state. */
const SHOT = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("accountSwitch") : null;

const shown = (a: AccountSwitchSettings): AccountSwitchSettings => (SHOT === "on" ? { enabled: true, termsAcceptedAt: a.termsAcceptedAt ?? new Date(Date.now() - 2 * 86_400_000).toISOString() } : a);

export function AccountSwitchRows({ settings, save }: { settings: AppSettings; save: (patch: SettingsPatch) => void }) {
  const { t, i18n } = useTranslation("settings");
  const a = shown(settings.accountSwitch);
  const [asking, setAsking] = useState(SHOT === "terms");
  const ids = { title: useId(), text: useId() };
  const turn = (on: boolean) => {
    if (on && a.termsAcceptedAt === null) setAsking(true);
    else save({ accountSwitch: { enabled: on } });
  };
  return (
    <>
      <Row label={t("accountSwitch.label")} hint={t("accountSwitch.hint")}>
        <Toggle label={t("accountSwitch.label")} value={a.enabled} onChange={turn} />
      </Row>
      {asking && (
        <div className="banner banner-warn st-terms" role="alertdialog" aria-labelledby={ids.title} aria-describedby={ids.text}>
          <span className="lbl" id={ids.title}>
            {t("accountSwitch.termsTitle")}
          </span>
          <p id={ids.text}>{t("accountSwitch.terms")}</p>
          <div className="st-terms-acts">
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                setAsking(false);
                save({ accountSwitch: { enabled: true, acceptTerms: true } });
              }}
            >
              {t("accountSwitch.termsAccept")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>
              {t("accountSwitch.termsCancel")}
            </Button>
          </div>
        </div>
      )}
      <Row label={t("accountSwitch.perTask")} hint={t("accountSwitch.perTaskHint")} />
      {a.termsAcceptedAt && <p className="st-note">{t("accountSwitch.termsAccepted", { time: new Date(a.termsAcceptedAt).toLocaleString(i18n.language, { dateStyle: "medium", timeStyle: "short" }) })}</p>}
    </>
  );
}
