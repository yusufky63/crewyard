import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Plus, SendHorizontal, Sparkles, Square, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { ASSISTANT_LIMITS, TASK_PRESETS, type AssistantProfileOption, type AssistantView, type TaskPresetId } from "@crewyard/core";
import { BrandIcon, Button, Label, Panel, ProvenanceBadge } from "@crewyard/ui";
import { matches } from "../../keys.ts";
import { takeAssistantFocus } from "../../shell/activity/panel.ts";
import { AutopilotStrip } from "./Autopilot.tsx";
import { Conversation } from "./assistant/Conversation.tsx";
import { DraftCard } from "./assistant/DraftCard.tsx";
import { GoalDraftCard } from "./assistant/GoalDraftCard.tsx";
import { useAssistantError } from "./assistant/errors.ts";
import { InfoTip } from "./assistant/InfoTip.tsx";
import { byteMeter, excerpt, liveState, quoted } from "./assistant/model.ts";
import { act, useWork } from "./data.ts";
import "./assistant.css";

// DESIGN.md `TaskAssistant` (docs/adr/0014): a terminal-style conversation with a read-only agent
// that drafts tasks. Agent text is shown through the text-only Markdown reader, never as markup. A
// draft becomes a task only on `Add as draft`, and that task still waits for its crew approval.

export { DraftCard };

function pickProfile(view: AssistantView | undefined, options: AssistantProfileOption[], chosen: string | null): string | null {
  const ok = options.filter((o) => o.unavailable === null);
  if (chosen && ok.some((o) => o.profileId === chosen)) return chosen;
  if (view?.profileId && ok.some((o) => o.profileId === view.profileId)) return view.profileId;
  return ok[0]?.profileId ?? null;
}

/** `docked`: inside the bottom panel's Assistant tab, which gives it its height and frame. */
export function AssistantPanel({ projectId, onClose, docked = false }: { projectId: string; onClose(): void; docked?: boolean }) {
  const { t } = useTranslation("assistant");
  const errorText = useAssistantError();
  const qc = useQueryClient();
  const key = ["assistant.get", { projectId }];
  // Read fresh on every open: changes while the panel was closed (the stop it just asked for) went unheard.
  const view = useWork("assistant.get", { projectId }, { refetchOnMount: "always" });
  const profiles = useWork("assistant.profiles", { projectId }, { staleTime: 30_000 });
  const presets = useWork("assistant.presets", { projectId }, { staleTime: 60_000 });
  const [chosen, setChosen] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const ids = { input: useId(), profile: useId() };

  // Live updates: the daemon batches streamed text into a few events a second.
  useEffect(() => {
    return window.crewyard.on("assistant.changed", (p) => {
      if ((p as { projectId?: string }).projectId === projectId) void qc.invalidateQueries({ queryKey: ["assistant.get", { projectId }] });
    });
  }, [projectId, qc]);

  useEffect(() => {
    if (!docked || takeAssistantFocus()) input.current?.focus();
  }, [docked]);

  const v = view.data;
  const options = profiles.data ?? [];
  const live = v ? v.state !== "idle" : false;
  const profileId = live && v?.profileId ? v.profileId : pickProfile(v, options, chosen);
  const lines = v?.lines ?? [];
  const drafts = (v?.drafts ?? []).filter((d) => d.status !== "discarded");
  // Newest first: the open goal draft is the one the composer holds (docs/adr/0022).
  const goalDrafts = (v?.goalDrafts ?? []).filter((d) => d.status !== "discarded").reverse();
  const lastLine = lines.at(-1);
  const turn = liveState(v, busy);
  const working = v?.state === "working" || v?.state === "starting";
  const meter = byteMeter(text, ASSISTANT_LIMITS.messageBytes);

  // Follow the conversation while you are at its end; scrolling up to read stops that.
  const atEnd = useRef(true);
  useEffect(() => {
    const el = log.current;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [lines.length, lastLine?.text, turn?.phase, turn?.tool]);

  // One polite announcement per finished reply, never per streamed word (DESIGN.md §8).
  const prevState = useRef(v?.state);
  const fresh = view.isFetchedAfterMount;
  useEffect(() => {
    // A cached view from before this panel opened is not a change you just saw happen.
    if (!fresh) {
      prevState.current = undefined;
      return;
    }
    if (prevState.current === "working" && v?.state === "waiting") setAnnounce(t("announce.replied", { count: drafts.filter((d) => d.status === "open").length }));
    if (v && v.state === "idle" && prevState.current && prevState.current !== "idle" && v.ended) setAnnounce(t(`notice.ended.${v.ended}`));
    prevState.current = v?.state;
  }, [v, drafts, t, fresh]);

  const set = (next: AssistantView) => qc.setQueryData(key, next);

  /** Sends one message; `fromBox` clears the box once the daemon took it. */
  const sendText = async (message: string, fromBox: boolean) => {
    if (!message || !profileId || busy) return;
    setBusy(true);
    setError(null);
    atEnd.current = true;
    try {
      set(await act("assistant.send", { projectId, profileId, text: message }));
      if (fromBox) setText("");
      atEnd.current = true;
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
      if (fromBox) input.current?.focus();
    }
  };

  const send = (e?: FormEvent) => {
    e?.preventDefault();
    if (meter.over) return;
    void sendText(text.trim(), true);
  };

  const close = () => {
    // Closing stops the session; the conversation and drafts stay for next time.
    void act("assistant.stop", { projectId }).catch(() => undefined);
    onClose();
  };

  /** Stops the reply in progress and the session; the conversation stays and the next message resumes it. */
  const stop = async () => {
    setError(null);
    try {
      set(await act("assistant.stop", { projectId }));
    } catch (err) {
      setError(errorText(err));
    }
    input.current?.focus();
  };

  const addPreset = async (presetId: TaskPresetId) => {
    setError(null);
    try {
      set(await act("assistant.preset", { projectId, presetId }));
    } catch (err) {
      setError(errorText(err));
    }
  };

  const clear = async () => {
    setError(null);
    try {
      set(await act("assistant.clear", { projectId }));
    } catch (err) {
      setError(errorText(err));
    }
  };

  const quote = (reply: string) => {
    const next = quoted(reply, text);
    setText(next);
    requestAnimationFrame(() => {
      const el = input.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.length, next.length);
      el.scrollTop = el.scrollHeight;
    });
  };

  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (!matches(e, "close") || e.defaultPrevented || document.querySelector("dialog[open], [role=menu]")) return;
    e.preventDefault();
    close();
  };

  const onInputKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (matches(e, "assistant.send") || matches(e, "submit")) {
      e.preventDefault();
      send();
    }
  };

  const running = options.find((o) => o.profileId === profileId);
  const idle = v?.idleMinutes ?? 30;

  const Frame = docked ? "div" : Panel;
  return (
    <Frame className={docked ? "as-panel as-docked" : "as-panel"} role="region" aria-label={t("label")} onKeyDown={onKey}>
      <div className="as-head">
        <Label>{t("title")}</Label>
        {live && v ? (
          <span className="as-run mono" title={t("runningOn")}>
            {v.runner && <BrandIcon id={v.runner} size={14} />}
            <span className="as-typed">{v.profileAlias ?? running?.alias ?? ""}</span>
            {v.model && <span className="muted as-typed">· {v.model}</span>}
          </span>
        ) : (
          <label className="chip tk-field" htmlFor={ids.profile}>
            {t("profile")}
            <select id={ids.profile} value={profileId ?? ""} onChange={(e) => setChosen(e.target.value)} disabled={options.length === 0}>
              {options.length === 0 && <option value="">{t("noProfiles")}</option>}
              {options.map((o) => (
                <option key={o.profileId} value={o.profileId} disabled={o.unavailable !== null}>
                  {o.alias}
                  {o.model ? ` · ${o.model}` : ""}
                  {o.unavailable ? ` (${t(`unavailable.${o.unavailable}`)})` : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        {v && <StateChip state={v.state} />}
        <span className="badge as-readonly" title={t("readOnlyTitle")}>
          {t("readOnly")}
        </span>
        {v && <Spend view={v} />}
        <div className="end">
          <Button size="sm" variant="ghost" onClick={() => void clear()} disabled={!v?.conversationId}>
            {t("new")}
          </Button>
          <Button size="sm" tone="bad" onClick={close} title={t("closeTitle")}>
            <X aria-hidden="true" />
            {t("close")}
          </Button>
        </div>
      </div>

      <AutopilotStrip projectId={projectId} />

      <div className="as-body">
        <div className="as-term">
          <Conversation
            view={v}
            sending={busy}
            logRef={log}
            onScroll={() => {
              const el = log.current;
              if (el) atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            }}
            onQuote={quote}
            onDrafts={(reply) => void sendText(t("actions.draftsMessage", { excerpt: excerpt(reply) }), false)}
            canDraft={Boolean(profileId) && !busy}
          />
          <form className="as-compose" onSubmit={send}>
            <div className="as-box" data-over={meter.over ? "" : undefined}>
              <textarea
                id={ids.input}
                ref={input}
                className="mono"
                rows={2}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onInputKey}
                placeholder={t("placeholder")}
                aria-label={t("input")}
                aria-describedby={`${ids.input}-hint`}
                spellCheck={false}
              />
              {/* Beside the text, not under it: the box stays two lines tall in a 280 px panel. */}
              <div className="as-box-bar">
                <span className="as-keys-line">
                  {meter.near && (
                    <span className={`num as-bytes${meter.over ? " as-bytes-over" : ""}`} title={t("bytesTitle")}>
                      {t("bytes", { kb: (meter.bytes / 1000).toFixed(1), cap: ASSISTANT_LIMITS.messageBytes / 1000 })}
                    </span>
                  )}
                  <span className="as-keys" id={`${ids.input}-hint`}>
                    {t("keysShort")}
                  </span>
                  <InfoTip label={t("about")}>
                    <span>{t("keys")}</span>
                    <span>{t("note", { minutes: idle })}</span>
                  </InfoTip>
                </span>
                <span className="as-box-acts">
                  {working && (
                    <Button size="sm" tone="bad" onClick={() => void stop()} title={t("stopTitle")}>
                      <Square aria-hidden="true" />
                      {t("stop")}
                    </Button>
                  )}
                  <Button type="submit" size="sm" variant="primary" disabled={!text.trim() || !profileId || busy || meter.over}>
                    <SendHorizontal aria-hidden="true" />
                    {t("send")}
                  </Button>
                </span>
              </div>
            </div>
          </form>
          {error && (
            <p className="tk-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <section className="as-drafts" aria-label={t("drafts.label")}>
          <Presets
            suggested={presets.data?.suggested ?? []}
            onPick={(id) => void addPreset(id)}
            onSuggest={() => void sendText(t("suggest.message"), false)}
            estimate={running?.suggestEstimate ?? null}
            canSuggest={Boolean(profileId) && !busy && !working}
          />
          <div className="as-drafts-head">
            <Label>{t("drafts.title")}</Label>
            <span className="badge num">{drafts.length + goalDrafts.length}</span>
          </div>
          {drafts.length + goalDrafts.length === 0 && <p className="muted as-drafts-empty">{t("drafts.empty")}</p>}
          {goalDrafts.map((d) => (
            <GoalDraftCard key={d.id} draft={d} projectId={projectId} />
          ))}
          {drafts.map((d, i) => (
            <DraftCard key={d.id} draft={d} index={i + 1} />
          ))}
        </section>
      </div>
      <div className="sr" aria-live="polite">
        {announce}
      </div>
    </Frame>
  );
}

function Presets({
  suggested,
  onPick,
  onSuggest,
  estimate,
  canSuggest,
}: {
  suggested: Array<{ id: TaskPresetId; reason: string; count?: number }>;
  onPick(id: TaskPresetId): void;
  onSuggest(): void;
  estimate: AssistantProfileOption["suggestEstimate"] | null;
  canSuggest: boolean;
}) {
  const { t } = useTranslation("assistant");
  const picked = new Set(suggested.map((s) => s.id));
  const rest = TASK_PRESETS.filter((p) => !picked.has(p.id));
  const ids = { title: useId(), forProject: useId(), why: useId() };
  // Ready-made tasks first (local, free), then the one priced action, each easy to tell apart.
  return (
    <div className="as-presets">
      <div className="as-sec-head">
        <Label id={ids.title}>{t("presets.title")}</Label>
        <span className="muted tk-small">{t("presets.free")}</span>
      </div>
      {suggested.length > 0 && (
        <div className="as-preset-group" data-suggested="">
          <span className="badge badge-info" id={ids.forProject}>
            {t("presets.forProject")}
          </span>
          <ul className="as-preset-rows" aria-labelledby={ids.forProject}>
            {suggested.map((s) => (
              <li key={s.id} className="as-preset-item">
                <button type="button" className="as-preset-row" aria-describedby={`${ids.why}-${s.id}`} onClick={() => onPick(s.id)}>
                  <Plus aria-hidden="true" />
                  <span className="as-preset-name">{t(`presets.items.${s.id}`)}</span>
                </button>
                <span className="as-preset-why" id={`${ids.why}-${s.id}`}>
                  {t(`presets.reason.${s.reason}`, { count: s.count ?? 0 })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <ul className="as-preset-rows" aria-labelledby={ids.title}>
        {rest.map((p) => (
          <li key={p.id} className="as-preset-item">
            <button type="button" className="as-preset-row" onClick={() => onPick(p.id)}>
              <Plus aria-hidden="true" />
              <span className="as-preset-name">{t(`presets.items.${p.id}`)}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="as-suggest">
        <Button className="as-suggest-btn" onClick={onSuggest} disabled={!canSuggest} title={t("suggest.title")}>
          <Sparkles aria-hidden="true" />
          {t("suggest.button")}
        </Button>
        <span className="as-suggest-meta">
          <span className="muted">{t("suggest.lead")}</span>
          {estimate && (
            <span className="as-spend">
              {estimate.label === "plan" ? (
                <span className="badge">{t("spend.plan")}</span>
              ) : (
                <>
                  <span className="num">{estimate.usd === null ? t("spend.noPrice") : t("suggest.about", { usd: estimate.usd.toFixed(4) })}</span>
                  <ProvenanceBadge provenance={estimate.label === "unknown" ? "unknown" : "estimated"}>{t(estimate.label === "unknown" ? "spend.unknown" : "spend.estimated")}</ProvenanceBadge>
                </>
              )}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

function StateChip({ state }: { state: AssistantView["state"] }) {
  const { t } = useTranslation("assistant");
  const tone = state === "working" || state === "starting" ? " badge-info" : state === "waiting" ? " badge-ok" : "";
  return (
    <span className={`badge as-state as-state-${state}${tone}`}>
      {(state === "working" || state === "starting") && <span className="spin" aria-hidden="true" />}
      {t(`state.${state}`)}
    </span>
  );
}

function Spend({ view }: { view: AssistantView }) {
  const { t, i18n } = useTranslation("assistant");
  const s = view.spend;
  // Nothing spent yet (no message sent, or only presets picked): no number to show.
  if (s.tokensIn + s.tokensOut === 0 && !s.usd) return null;
  const tokens = new Intl.NumberFormat(i18n.language).format(s.tokensIn + s.tokensOut);
  if (s.label === "plan")
    return (
      <span className="as-spend" title={t("spend.planTitle")}>
        <span className="num">{t("spend.tokens", { tokens })}</span>
        <span className="badge">{t("spend.plan")}</span>
      </span>
    );
  return (
    <span className="as-spend" title={t("spend.title")}>
      <span className="num">{s.usd === null ? t("spend.noPrice") : `$${s.usd.toFixed(s.usd < 1 ? 4 : 2)}`}</span>
      <ProvenanceBadge provenance={s.label === "reported" ? "reported" : s.label === "unknown" ? "unknown" : "estimated"}>{t(`spend.${s.label}`)}</ProvenanceBadge>
    </span>
  );
}
