import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Crosshair, ExternalLink, ListPlus, RotateCw, X } from "lucide-react";
import { pickMessage, pickQuote, type PickedElement, type PreviewTargets, type RunView, type TaskDetail, type TasksTopics } from "@crewyard/core";
import { Button, Label } from "@crewyard/ui";
import type { PreviewRect, PreviewState } from "../../../../shared/api.ts";
import { act, useErrorText, useRecheck, useWork } from "../../screens/tasks/data.ts";
import { FIXTURE } from "../../screens/tasks/fixture.ts";
import { ErrorLine, useFormat } from "../../screens/tasks/parts.tsx";
import { COVERING, previewCandidates, sameRect, visibleRect } from "./model.ts";
import { subscribePreview, usePreview } from "./store.ts";
import "./preview.css";

// The inspector's Preview tab (docs/adr/0013-dev-server-preview.md). It lists where this task's
// dev server may be, loads one only on a click, and lets you pick an element whose HTML and styles
// go to the step's queue as quoted text. The page itself is a view main draws over the frame below;
// nothing from it is ever rendered as HTML here.

const ICON = { size: 14, strokeWidth: 1.75 } as const;
const SHOT = FIXTURE ? new URLSearchParams(location.search).get("preview") : null;
const T0 = Date.now();

const FIXTURE_TARGETS: PreviewTargets = {
  port: 4173,
  printed: [
    { url: "http://localhost:5173/settings", runId: "", at: new Date(T0 - 4 * 60_000).toISOString() },
    { url: "http://127.0.0.1:6006/?path=/story/button--primary", runId: "", at: new Date(T0 - 22 * 60_000).toISOString() },
  ],
};
const FIXTURE_PICK: PickedElement = {
  url: "http://localhost:5173/settings",
  selector: "main > form.settings > div.actions > button.primary",
  html: '<button class="primary" type="submit" disabled="">\n  <svg class="icon" aria-hidden="true"></svg>\n  Save changes\n</button>',
  htmlChars: 98,
  truncated: false,
  styles: [
    { name: "display", value: "inline-flex" },
    { name: "height", value: "34px" },
    { name: "padding", value: "0px 14px" },
    { name: "border-radius", value: "6px" },
    { name: "background-color", value: "rgb(37, 99, 235)" },
    { name: "color", value: "rgb(255, 255, 255)" },
    { name: "font-size", value: "13px" },
    { name: "gap", value: "6px" },
    { name: "align-items", value: "center" },
  ],
  width: 132,
  height: 34,
};
const FIXTURE_STATE = (taskId: string): PreviewState => ({ taskId, url: "http://localhost:5173/settings", title: "Settings", loading: false, failed: null, blocked: null, picking: false });

/** Sends the frame's visible part to main every frame it changes; null while hidden or covered. */
function useFramePlacement(frame: React.RefObject<HTMLDivElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active || FIXTURE) return;
    let last: PreviewRect | null = null;
    let raf = 0;
    const tick = () => {
      const el = frame.current;
      const clip = el?.closest(".inspector");
      let next: PreviewRect | null = null;
      if (el && clip && !document.querySelector(COVERING)) next = visibleRect(el.getBoundingClientRect(), clip.getBoundingClientRect());
      if (!sameRect(next, last)) {
        last = next;
        window.crewyard.previewBounds(next);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.crewyard.previewBounds(null);
    };
  }, [frame, active]);
}

/** Re-reads the address list when a run of this task prints something that looks like a local server. */
function useTargetsRefresh(taskId: string): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (FIXTURE) return;
    return window.crewyard.on("runs.event", (p) => {
      const { taskId: id, event } = p as TasksTopics["runs.event"];
      if (id !== taskId || event.type !== "tool.update" || !event.output) return;
      if (/localhost|127\.0\.0\.1|\[::|0\.0\.0\.0/.test(event.output)) void qc.invalidateQueries({ queryKey: ["preview.targets", { taskId }] });
    });
  }, [qc, taskId]);
}

function Status({ state }: { state: PreviewState }) {
  const { t } = useTranslation("preview");
  let line: string | null = null;
  let tone = "muted";
  if (state.picking) {
    line = t("picking");
    tone = "accent";
  } else if (state.failed) {
    line = state.failed.code === -1 ? t("crashed", { description: state.failed.description }) : t("failed", { url: state.failed.url, description: state.failed.description });
    tone = "bad";
  } else if (state.blocked) {
    line = t(`blocked.${state.blocked.reason}`, { url: state.blocked.url });
    tone = "warn";
  } else if (state.loading) line = t("loading");
  return (
    <p className={`pv-status ${tone}`} role="status">
      {line}
    </p>
  );
}

function PickDraft({ detail, run, pick, onDone }: { detail: TaskDetail; run: RunView | null; pick: PickedElement; onDone: (queued: boolean) => void }) {
  const { t } = useTranslation("preview");
  const errorText = useErrorText();
  const recheck = useRecheck();
  const noteId = useId();
  const quoteId = useId();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canQueue = Boolean(run) && run!.endReason !== "completed" && !detail.cancelledAt;
  const queue = async () => {
    if (!run) return;
    setBusy(true);
    setError(null);
    try {
      await act("runs.message", { runId: run.id, text: pickMessage(pick, note), sessionId: run.nativeSessionId });
      onDone(true);
    } catch (err) {
      setError(errorText(err));
      recheck(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ins-sec pv-pick">
      <Label>{t("picked")}</Label>
      <p className="mono pv-selector as-typed">{t("pickedSize", { selector: pick.selector, width: pick.width, height: pick.height })}</p>
      {pick.truncated && <p className="muted ins-small">{t("pickedCut")}</p>}
      <span className="muted ins-small" id={quoteId}>
        {t("quoteLabel")}
      </span>
      <pre className="pv-quote" aria-labelledby={quoteId} tabIndex={0}>
        {pickQuote(pick)}
      </pre>
      <label className="lbl" htmlFor={noteId}>
        {t("note")}
      </label>
      <textarea id={noteId} className="pv-note" rows={2} value={note} maxLength={2000} placeholder={t("notePlaceholder")} onChange={(e) => setNote(e.target.value)} />
      <div className="ins-buttons">
        <Button variant="primary" disabled={!canQueue || busy} onClick={() => void queue()}>
          <ListPlus aria-hidden="true" />
          {t("queue")}
        </Button>
        <Button variant="ghost" onClick={() => onDone(false)}>
          {t("discard")}
        </Button>
      </div>
      <p className="muted ins-small">{canQueue ? t("queueHint") : run ? t("runDone") : t("noRun")}</p>
      <ErrorLine>{error}</ErrorLine>
    </div>
  );
}

export function PreviewTab({ detail, run }: { detail: TaskDetail; run: RunView | null }) {
  const { t } = useTranslation("preview");
  const f = useFormat();
  const live = usePreview((s) => s.state);
  const state = SHOT === "loaded" || SHOT === "picked" ? FIXTURE_STATE(detail.id) : live;
  const query = useWork("preview.targets", { taskId: detail.id }, { enabled: !FIXTURE });
  const targets = FIXTURE ? FIXTURE_TARGETS : query.data;
  const candidates = targets ? previewCandidates(targets) : [];
  const loadedHere = state.taskId === detail.id && state.url !== null;
  const frame = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<PickedElement | null>(SHOT === "picked" ? FIXTURE_PICK : null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(subscribePreview, []);
  useTargetsRefresh(detail.id);
  useFramePlacement(frame, loadedHere);
  useEffect(() => window.crewyard.on("preview.focus", () => frame.current?.focus()), []);

  const load = async (url: string) => {
    setError(null);
    setNotice(null);
    const res = await window.crewyard.previewOpen(detail.id, url);
    if (!res.ok) setError(t(`refused.${res.reason}`));
  };
  const startPick = async () => {
    if (state.picking) return window.crewyard.previewCancelPick();
    setError(null);
    setNotice(null);
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
    const res = await window.crewyard.previewPick(accent);
    if (res.ok) setPick(res.pick);
    else if (res.reason === "invalid") setError(t("pickInvalid"));
    else if (res.reason === "failed") setError(t("pickFailed"));
  };

  return (
    <>
      <div className="ins-sec pv-servers">
        <Label>{t("servers")}</Label>
        {candidates.length === 0 ? (
          <p className="muted ins-empty">{t("empty")}</p>
        ) : (
          <ul className="pv-list">
            {candidates.map((c) => {
              const current = loadedHere && state.url !== null && sameOrigin(state.url, c.url);
              const who = c.runId ? detail.runs.find((r) => r.id === c.runId) : undefined;
              const time = c.at ? f.when.ago(c.at) : "";
              return (
                <li key={c.url}>
                  <span className="mono pv-url as-typed" title={c.url}>
                    {c.url}
                  </span>
                  <span className="muted pv-src">{c.source === "port" ? t("source.port") : who ? t("source.printed", { who: `${f.role(who.role)} · ${f.runner(who.runner)}`, time }) : t("source.printedUnknown", { time })}</span>
                  <Button size="sm" aria-label={t("loadLabel", { url: c.url })} aria-pressed={current} onClick={() => void load(c.url)}>
                    {current ? t("loaded") : t("load")}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        <ErrorLine>{error}</ErrorLine>
      </div>
      {/* The pick sits above the page, so it shows the moment you click, without scrolling. */}
      {pick && (
        <PickDraft
          detail={detail}
          run={run}
          pick={pick}
          onDone={(queued) => {
            setPick(null);
            setNotice(queued ? t("queued") : null);
          }}
        />
      )}
      <div className="ins-sec pv-view">
        {loadedHere && (
          <div className="pv-bar">
            <span className="mono pv-current as-typed" title={state.url ?? ""}>
              {state.url}
            </span>
            <div className="pv-tools">
              <Button size="sm" variant="ghost" aria-label={t("reload")} title={t("reload")} onClick={() => window.crewyard.previewReload()}>
                <RotateCw {...ICON} aria-hidden="true" />
              </Button>
              <Button size="sm" aria-pressed={state.picking} disabled={state.loading && !state.picking} onClick={() => void startPick()}>
                <Crosshair {...ICON} aria-hidden="true" />
                {state.picking ? t("cancelPick") : t("pick")}
              </Button>
              <Button size="sm" variant="ghost" aria-label={t("external")} title={t("external")} onClick={() => window.crewyard.previewOpenExternal()}>
                <ExternalLink {...ICON} aria-hidden="true" />
              </Button>
              <Button size="sm" variant="ghost" aria-label={t("unload")} title={t("unload")} onClick={() => window.crewyard.previewClose()}>
                <X {...ICON} aria-hidden="true" />
              </Button>
            </div>
          </div>
        )}
        <Status state={state} />
        <div
          ref={frame}
          className={`pv-frame${loadedHere ? " on" : ""}${state.picking ? " picking" : ""}`}
          tabIndex={loadedHere ? 0 : -1}
          role={loadedHere ? "region" : undefined}
          aria-label={loadedHere ? t("frame", { url: state.url }) : undefined}
          onKeyDown={(e) => {
            if (e.key === "Enter" && loadedHere) {
              e.preventDefault();
              window.crewyard.previewFocus();
            }
          }}
        >
          {!loadedHere && <p className="muted pv-frame-empty">{t("frameEmpty")}</p>}
        </div>
        {notice && (
          <p className="muted ins-small" role="status">
            {notice}
          </p>
        )}
        <p className="muted ins-small">{t("closeNote")}</p>
      </div>
    </>
  );
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}
