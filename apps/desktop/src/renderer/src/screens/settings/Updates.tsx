import { useEffect, useState } from "react";
import { Download, RefreshCw, RotateCcw, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@crewyard/ui";
import type { UpdatePhase, UpdateState } from "../../../../shared/api.ts";
import { formatBytes } from "./model.ts";
import { Fact, Row, Section, Toggle } from "./parts.tsx";

// Settings → Updates (docs/adr/0011-signing-and-auto-update.md). The main process owns the updater;
// this shows its state and passes on your clicks. Nothing downloads or installs without one.

const PHASES: ReadonlyArray<UpdatePhase> = ["off", "idle", "checking", "current", "available", "downloading", "downloaded", "error"];

/** Screenshot runs show a state with `update=<phase>` (CREWYARD_SHOT_QUERY); a normal run has no query. */
export function fixtureUpdate(search: string): UpdateState | null {
  const phase = new URLSearchParams(search).get("update") as UpdatePhase | null;
  if (!phase || !PHASES.includes(phase)) return null;
  const available = { version: "0.1.1", releaseDate: "2026-10-30T12:00:00.000Z", size: 127_926_272 };
  const base: UpdateState = {
    phase,
    off: phase === "off" ? "no_feed" : null,
    current: "0.1.0",
    feed: phase === "off" ? null : "https://updates.crewyard.example/win",
    signed: true,
    publisher: phase === "off" ? null : "CN=Crewyard, O=Crewyard, C=TR",
    autoCheck: phase !== "off",
    checkedAt: phase === "off" || phase === "idle" ? null : "2026-10-30T17:42:00.000Z",
    available: ["available", "downloading", "downloaded", "error"].includes(phase) ? available : null,
    progress: phase === "downloading" ? { percent: 42.4, transferred: 54_240_000, total: 127_926_272, bytesPerSecond: 6_400_000 } : null,
    verifiedBy: phase === "downloaded" ? "CN=Crewyard, O=Crewyard, C=TR" : null,
    error: phase === "error" ? { code: "signature", problem: "tampered", detail: "the installer was changed after it was signed" } : null,
  };
  return base;
}

export function useUpdates(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(() => fixtureUpdate(window.location.search));
  useEffect(() => {
    if (fixtureUpdate(window.location.search)) return;
    let live = true;
    void window.crewyard.updates().then((s) => live && setState(s));
    const off = window.crewyard.on("update.changed", (p) => setState(p as UpdateState));
    return () => {
      live = false;
      off();
    };
  }, []);
  return state;
}

function useFormat() {
  const { i18n } = useTranslation();
  const when = new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" });
  const day = new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" });
  return {
    size: (b: number) => formatBytes(b, i18n.language),
    when: (iso: string) => when.format(new Date(iso)),
    day: (iso: string) => day.format(new Date(iso)),
    pct: (p: number) => new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 0 }).format(Math.floor(p)),
  };
}

/** The one-line state under "Check for updates". */
function StatusLine({ s }: { s: UpdateState }) {
  const { t } = useTranslation("settings");
  const f = useFormat();
  if (s.phase === "off") return <>{t(`updates.off.${s.off ?? "no_feed"}`)}</>;
  if (s.phase === "checking") return <>{t("updates.checking")}</>;
  if (s.phase === "current") return <span className="st-ok">{t("updates.current", { time: s.checkedAt ? f.when(s.checkedAt) : "" })}</span>;
  if (s.available && (s.phase === "available" || s.phase === "downloading" || s.phase === "downloaded")) return <>{t("updates.found", { version: s.available.version })}</>;
  if (s.phase === "error" && s.error) return <span className="pv-error">{t(`updates.error.${s.error.code}`)}</span>;
  return <>{t("updates.never")}</>;
}

function Progress({ s }: { s: UpdateState }) {
  const { t } = useTranslation("settings");
  const f = useFormat();
  const p = s.progress;
  const pct = p ? Math.max(0, Math.min(100, p.percent)) : 0;
  const label = p && p.total > 0 ? t("updates.progress", { pct: f.pct(pct), done: f.size(p.transferred), total: f.size(p.total), speed: f.size(p.bytesPerSecond) }) : t("updates.starting");
  return (
    <div className="up-progress">
      <div className="up-bar" role="progressbar" aria-label={t("updates.downloading")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-valuetext={label}>
        <span style={{ width: `${pct}%` }} />
      </div>
      <span className="mono up-meta">{label}</span>
    </div>
  );
}

/** The offered version: download, progress, verified and ready, or refused. */
function Offer({ s }: { s: UpdateState }) {
  const { t } = useTranslation("settings");
  const f = useFormat();
  const a = s.available;
  if (!a) return null;
  const facts = [a.releaseDate ? t("updates.released", { date: f.day(a.releaseDate) }) : null, a.size ? f.size(a.size) : null].filter(Boolean).join(" · ");
  const refused = s.phase === "error" && s.error;
  return (
    <div className={`up-offer frame${refused ? " up-refused" : ""}`} role="group" aria-label={t("updates.offerLabel", { version: a.version })}>
      <div className="up-head">
        <span className="lbl">{t("updates.newVersion")}</span>
        <span className="up-version mono">{a.version}</span>
        {facts && <span className="up-facts mono muted">{facts}</span>}
      </div>
      {s.phase === "available" && (
        <div className="up-row">
          <p className="up-text">{s.signed ? t("updates.downloadHint") : t("updates.downloadHintUnsigned")}</p>
          <Button size="sm" tone="ok" onClick={() => void window.crewyard.downloadUpdate()}>
            <Download strokeWidth={1.75} />
            {t("updates.download")}
          </Button>
        </div>
      )}
      {s.phase === "downloading" && (
        <div className="up-row">
          <Progress s={s} />
          <Button variant="ghost" tone="bad" size="sm" onClick={() => void window.crewyard.cancelUpdate()}>
            <X strokeWidth={1.75} />
            {t("updates.cancel")}
          </Button>
        </div>
      )}
      {s.phase === "downloaded" && (
        <>
          <p className="up-verified" role="status">
            {s.verifiedBy ? <ShieldCheck size={14} strokeWidth={1.75} className="st-ok" /> : <ShieldAlert size={14} strokeWidth={1.75} className="st-warn" />}
            <span>{s.verifiedBy ? t("updates.verified", { signer: s.verifiedBy }) : t("updates.unverified")}</span>
          </p>
          <div className="up-row">
            <p className="up-text">{t("updates.installHint")}</p>
            <Button variant="primary" onClick={() => void window.crewyard.installUpdate()}>
              <RotateCcw strokeWidth={1.75} />
              {t("updates.install")}
            </Button>
          </div>
        </>
      )}
      {refused && s.error && (
        <div className="up-row">
          <p className="up-error" role="alert">
            <ShieldAlert size={14} strokeWidth={1.75} />
            <span>
              {s.error.code === "signature" && s.error.problem ? t(`updates.refused.${s.error.problem}`) : t(`updates.error.${s.error.code}`)}
              <small className="st-meta mono as-typed">{s.error.detail}</small>
            </span>
          </p>
          {s.error.code !== "signature" && s.error.code !== "checksum" && (
            <Button size="sm" onClick={() => void window.crewyard.downloadUpdate()}>
              <Download strokeWidth={1.75} />
              {t("updates.retry")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export function UpdatesSection({ index }: { index: number }) {
  const { t } = useTranslation("settings");
  const s = useUpdates();
  if (!s) return <Section id="updates" index={index} title={t("sections.updates")}>{null}</Section>;
  const off = s.phase === "off";
  const busy = s.phase === "checking" || s.phase === "downloading";
  const errorWithoutOffer = s.phase === "error" && !s.available && s.error;
  return (
    <Section id="updates" index={index} title={t("sections.updates")}>
      <Fact label={t("updates.version")} value={s.current} />
      <Fact label={t("updates.feed")} value={s.feed ?? t("updates.noFeed")} />
      {!off && <Fact label={t("updates.publisher")} value={s.signed && s.publisher ? t("updates.mustBeSigned", { publisher: s.publisher }) : t("updates.unsignedBuild")} />}
      <Row label={t("updates.check")} hint={<StatusLine s={s} />}>
        <Button size="sm" disabled={off || busy || s.phase === "downloaded"} onClick={() => void window.crewyard.checkForUpdates()}>
          {s.phase === "checking" ? <span className="spin" /> : <RefreshCw strokeWidth={1.75} />}
          {t("updates.checkNow")}
        </Button>
      </Row>
      {errorWithoutOffer && s.error && <p className="st-note mono as-typed muted st-break">{s.error.detail}</p>}
      <Offer s={s} />
      <Row label={t("updates.auto")} hint={off ? t("updates.autoOff") : t("updates.autoHint")}>
        <Toggle label={t("updates.auto")} value={s.autoCheck} disabled={off} onChange={(v) => void window.crewyard.setUpdateAutoCheck(v)} />
      </Row>
    </Section>
  );
}
