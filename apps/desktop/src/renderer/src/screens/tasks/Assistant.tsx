import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { TASK_PRESETS, type AssistantDraftView, type AssistantLine, type AssistantProfileOption, type AssistantView, type TaskKind, type TaskPresetId, type TaskSize } from "@crewyard/core";
import { BrandIcon, Button, Label, Panel, ProvenanceBadge } from "@crewyard/ui";
import { matches } from "../../keys.ts";
import { useNav } from "../../nav.ts";
import { takeAssistantFocus } from "../../shell/activity/panel.ts";
import { AutopilotStrip } from "./Autopilot.tsx";
import { act, useWork } from "./data.ts";
import "./assistant.css";

// DESIGN.md `TaskAssistant` (docs/adr/0014): a terminal-style conversation with a read-only agent
// that drafts tasks. Everything the agent says is plain text here, never markup. A draft becomes a
// task only on `Add as draft`, and that task still waits for its crew approval.

const KINDS: TaskKind[] = ["code", "research", "review", "docs"];
const SIZES: Array<TaskSize | ""> = ["", "S", "M", "L"];

/** Daemon errors arrive as codes ("assistant.daily_cap", "admission.memory"); keys use underscores. */
function useAssistantError(): (err: unknown) => string {
  const { t } = useTranslation("assistant");
  return (err) => {
    const code = (err instanceof Error ? err.message : String(err)).replace(/^.*Error: /, "").trim();
    return t(`errors.${code.replace(/\./g, "_")}`, { defaultValue: t("errors.other", { message: code }) });
  };
}

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
  const lastLine = lines.at(-1);

  // Follow the conversation while you are at its end; scrolling up to read stops that.
  const atEnd = useRef(true);
  useEffect(() => {
    const el = log.current;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [lines.length, lastLine?.text]);

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

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const message = text.trim();
    if (!message || !profileId || busy) return;
    setBusy(true);
    setError(null);
    try {
      set(await act("assistant.send", { projectId, profileId, text: message }));
      setText("");
      atEnd.current = true;
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
      input.current?.focus();
    }
  };

  const close = () => {
    // Closing stops the session; the conversation and drafts stay for next time.
    void act("assistant.stop", { projectId }).catch(() => undefined);
    onClose();
  };

  const addPreset = async (presetId: TaskPresetId) => {
    setError(null);
    try {
      set(await act("assistant.preset", { projectId, presetId }));
    } catch (err) {
      setError(errorText(err));
    }
  };

  /** One message with a fixed request; its estimated cost is on the button before you press it. */
  const suggest = async () => {
    if (!profileId || busy) return;
    setBusy(true);
    setError(null);
    try {
      set(await act("assistant.send", { projectId, profileId, text: t("suggest.message") }));
      atEnd.current = true;
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
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

  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (!matches(e, "close") || e.defaultPrevented || document.querySelector("dialog[open], [role=menu]")) return;
    e.preventDefault();
    close();
  };

  const onInputKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (matches(e, "assistant.send") || matches(e, "submit")) {
      e.preventDefault();
      void send();
    }
  };

  const running = options.find((o) => o.profileId === profileId);

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
        {v && <Spend view={v} />}
        <div className="end">
          <Button size="sm" variant="ghost" onClick={() => void clear()} disabled={!v?.conversationId}>
            {t("new")}
          </Button>
          <Button size="sm" onClick={close} title={t("closeTitle")}>
            <X aria-hidden="true" />
            {t("close")}
          </Button>
        </div>
      </div>

      <AutopilotStrip projectId={projectId} />

      <div className="as-body">
        <div className="as-term">
          <div
            className="as-log mono"
            role="log"
            aria-live="off"
            aria-label={t("conversation")}
            tabIndex={0}
            ref={log}
            onScroll={(e) => {
              const el = e.currentTarget;
              atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            }}
          >
            {lines.length === 0 && (
              <div className="as-hint">
                <p>{t("empty.lead")}</p>
                <p className="muted">{t("empty.example")}</p>
              </div>
            )}
            {lines.map((l) => (
              <Line key={l.id} line={l} />
            ))}
            {v?.ended === "failed" && v.detail && (
              <p className="as-line as-fail">
                <span className="as-who">{t("failed")}</span>
                <span className="as-text">{v.detail}</span>
              </p>
            )}
          </div>
          <form className="as-input" onSubmit={(e) => void send(e)}>
            <span className="as-prompt mono" aria-hidden="true">
              &gt;
            </span>
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
            <Button type="submit" size="sm" disabled={!text.trim() || !profileId || busy}>
              {t("send")}
            </Button>
          </form>
          <div className="as-foot">
            <Label id={`${ids.input}-hint`}>{t("keys")}</Label>
            <Label>{t("note", { minutes: v?.idleMinutes ?? 30 })}</Label>
          </div>
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
            onSuggest={() => void suggest()}
            estimate={running?.suggestEstimate ?? null}
            canSuggest={Boolean(profileId) && !busy && v?.state !== "working" && v?.state !== "starting"}
          />
          <div className="as-drafts-head">
            <Label>{t("drafts.title")}</Label>
            <span className="muted num">{drafts.length}</span>
          </div>
          {drafts.length === 0 && <p className="muted as-drafts-empty">{t("drafts.empty")}</p>}
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
  const reasons = [...new Set(suggested.map((s) => t(`presets.reason.${s.reason}`, { count: s.count ?? 0 })))];
  return (
    <div className="as-presets">
      <Label>{t("presets.title")}</Label>
      {suggested.length > 0 && (
        <>
          <span className="muted tk-small">{t("presets.forProject")}</span>
          <div className="as-preset-list">
            {suggested.map((s) => (
              <Button key={s.id} size="sm" data-suggested="" title={t(`presets.reason.${s.reason}`, { count: s.count ?? 0 })} onClick={() => onPick(s.id)}>
                {t(`presets.items.${s.id}`)}
              </Button>
            ))}
          </div>
          <span className="muted tk-small">{reasons.join(" · ")}</span>
        </>
      )}
      <div className="as-preset-list">
        {rest.map((p) => (
          <Button key={p.id} size="sm" variant="ghost" onClick={() => onPick(p.id)}>
            {t(`presets.items.${p.id}`)}
          </Button>
        ))}
      </div>
      <div className="as-suggest">
        <Button size="sm" onClick={onSuggest} disabled={!canSuggest} title={t("suggest.title")}>
          {t("suggest.button")}
        </Button>
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
      </div>
    </div>
  );
}

function StateChip({ state }: { state: AssistantView["state"] }) {
  const { t } = useTranslation("assistant");
  return (
    <span className={`as-state as-state-${state}`}>
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

/** Crewyard's own Autopilot notices: a call it made (`autopilot.call.<outcome>.<tool>`) or a note it handed the session. */
function AutopilotNotice({ code }: { code: string }) {
  const { t } = useTranslation("autopilot");
  const call = /^autopilot\.call\.(done|refused)\.(\w+)$/.exec(code);
  const text = call ? t(`notice.call.${call[1]}`, { action: t(`log.action.${call[2]}`, { defaultValue: call[2] }) }) : t(`notice.${code.slice("autopilot.".length)}`, { defaultValue: code });
  return <p className={`as-line as-notice as-autopilot${call?.[1] === "refused" ? " as-autopilot-refused" : ""}`}>{text}</p>;
}

function Line({ line }: { line: AssistantLine }) {
  const { t } = useTranslation("assistant");
  if (line.role === "notice" && line.text.startsWith("autopilot.")) return <AutopilotNotice code={line.text} />;
  if (line.role === "notice") return <p className="as-line as-notice">{t(`notice.${line.text}`, { defaultValue: line.text })}</p>;
  if (line.role === "tool")
    return (
      <p className="as-line as-tool">
        <span className="as-who" aria-hidden="true">
          ·
        </span>
        <span className="as-text">{line.text}</span>
      </p>
    );
  const user = line.role === "user";
  return (
    <div className={`as-line ${user ? "as-user" : "as-reply"}`}>
      <span className="as-who">{user ? t("you") : t("agent")}</span>
      <span className="as-text">
        {line.text}
        {line.truncated && <span className="muted"> {t("truncated")}</span>}
      </span>
      {line.queued && <span className="badge">{t("queued")}</span>}
    </div>
  );
}

/** One editable draft: the assistant's, a preset's, or a finished task's suggestion. `onChanged` re-reads its list. */
export function DraftCard({ draft, index, onChanged }: { draft: AssistantDraftView; index: number; onChanged?: () => void }) {
  const { t } = useTranslation("assistant");
  const tk = useTranslation("tasks").t;
  const errorText = useAssistantError();
  const selectTask = useNav((s) => s.selectTask);
  const [title, setTitle] = useState(draft.title);
  const [description, setDescription] = useState(draft.description);
  const [kind, setKind] = useState<TaskKind>(draft.kind);
  const [size, setSize] = useState<TaskSize | "">(draft.size ?? "");
  const [criteria, setCriteria] = useState(draft.acceptance.join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const n = String(index).padStart(2, "0");

  if (draft.status === "added")
    return (
      <article className="spec as-draft as-draft-added" aria-labelledby={`${id}-t`}>
        <div className="as-draft-top">
          <span className="lbl num">{n}</span>
          <span className="lbl">{tk(`kind.${draft.kind}`)}</span>
          {draft.size && <span className="lbl">{draft.size}</span>}
        </div>
        <p className="as-draft-title as-typed" id={`${id}-t`}>
          {draft.title}
        </p>
        <p className="muted tk-small">{t("drafts.added")}</p>
        {draft.taskId && (
          <Button size="sm" variant="ghost" onClick={() => selectTask(draft.taskId!)}>
            {t("drafts.open")}
          </Button>
        )}
      </article>
    );

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await act("assistant.addDraft", {
        draftId: draft.id,
        edit: { title: title.trim(), description: description.trim(), kind, size: size || null, acceptance: criteria.split("\n").map((c) => c.trim()).filter(Boolean) },
      });
      // The task opens with its crew proposal, which still waits for your approval.
      selectTask(res.taskId);
      onChanged?.();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    setError(null);
    try {
      await act("assistant.discardDraft", { draftId: draft.id });
      onChanged?.();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <article className="spec as-draft" aria-label={t("drafts.cardLabel", { n: index, title: draft.title })}>
      <div className="as-draft-top">
        <span className="lbl num">{n}</span>
        <span className="lbl">{t(`drafts.from.${draft.source}`)}</span>
      </div>
      <label className="as-field">
        <span className="lbl">{t("drafts.fieldTitle")}</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <div className="as-draft-row">
        <label className="as-field">
          <span className="lbl">{t("drafts.fieldKind")}</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as TaskKind)}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {tk(`kind.${k}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="as-field">
          <span className="lbl">{t("drafts.fieldSize")}</span>
          <select value={size} onChange={(e) => setSize(e.target.value as TaskSize | "")}>
            {SIZES.map((s) => (
              <option key={s || "none"} value={s}>
                {s || t("drafts.sizeNone")}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="as-field">
        <span className="lbl">{t("drafts.fieldDescription")}</span>
        <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label className="as-field">
        <span className="lbl">{kind === "research" ? t("drafts.fieldQuestions") : t("drafts.fieldCriteria")}</span>
        <textarea rows={3} value={criteria} onChange={(e) => setCriteria(e.target.value)} placeholder={t("drafts.criteriaHint")} />
      </label>
      <div className="as-draft-actions">
        <Button size="sm" onClick={() => void add()} disabled={busy || !title.trim()}>
          {busy ? t("drafts.adding") : t("drafts.add")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void discard()} disabled={busy}>
          {t("drafts.discard")}
        </Button>
      </div>
      {error && (
        <p className="tk-error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}
