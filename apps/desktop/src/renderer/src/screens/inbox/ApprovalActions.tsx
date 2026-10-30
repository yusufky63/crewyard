import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { RequestAnswer, RequestView } from "@crewyard/core";
import { Button } from "@crewyard/ui";
import { canAllowAlways, denyAnswer } from "./model.ts";
import "./inbox.css";

// The answer buttons of a tool approval, shared by the Inbox and the inspector. A deny can carry a
// reason, which reaches the agent through its runner's deny path (feature scan F17), so it
// changes course instead of asking for the same call again.

export function ApprovalActions({ q, answer }: { q: RequestView; answer: (a: RequestAnswer) => Promise<void> }) {
  const { t } = useTranslation("inbox");
  const [reason, setReason] = useState("");
  const command = q.payload.kind === "approval" ? q.payload.command : null;
  const id = `ib-reason-${q.id}`;
  return (
    <>
      <div className="ib-reason">
        <label className="lbl" htmlFor={id}>
          {t("detail.denyReason")}
        </label>
        <textarea id={id} className="ib-note-input" rows={2} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("detail.denyReasonHint")} />
      </div>
      <div className="ib-actions">
        <Button variant="primary" onClick={() => void answer({ kind: "approval", decision: "allow_once" })}>
          {t("action.approveOnce")}
        </Button>
        {canAllowAlways(q.risk) && command && (
          <Button onClick={() => void answer({ kind: "approval", decision: "allow_always" })} title={t("action.allowAlwaysTitle", { command })}>
            {t("action.allowAlways")}
          </Button>
        )}
        <Button variant="ghost" onClick={() => void answer(denyAnswer(reason))}>
          {reason.trim() ? t("action.denyWithReason") : t("action.deny")}
        </Button>
      </div>
      {!canAllowAlways(q.risk) && <p className="ib-note">{t("detail.noAlwaysHigh")}</p>}
    </>
  );
}
