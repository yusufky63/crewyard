import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Check, ChevronRight, Copy, ListPlus, Quote } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AssistantLine, AssistantToolLine, AssistantView } from "@crewyard/core";
import { matches } from "../../../keys.ts";
import { parseMarkdown, type Block, type Inline } from "../../../shell/files/markdown.ts";
import { useNow } from "../parts.tsx";
import { elapsedText, groupLines, isPath, liveState, pathIn, toolCounts, type LiveState } from "./model.ts";

// The conversation log of the task assistant (DESIGN.md `TaskAssistant`). It stays a focusable
// role=log with no live region of its own; the panel announces each finished reply once.
//
// Keyboard: inside the log, Up and Down move between messages (roving focus, so the log is one Tab
// stop); the message in focus offers its actions to Tab. Agent text is untrusted: it goes through
// the text-only Markdown reader and React text nodes, its links show their target and never open,
// and the only things one can click in it are Crewyard's own actions (copy, quote, make drafts).

export interface ConversationProps {
  view: AssistantView | undefined;
  /** Our own send is in flight (the daemon has not answered yet). */
  sending: boolean;
  logRef: RefObject<HTMLDivElement | null>;
  onScroll(): void;
  onQuote(text: string): void;
  onDrafts(text: string): void;
  /** Make drafts sends a message, so it needs a profile and no send in flight. */
  canDraft: boolean;
}

/** Copies text and says so on the control for a moment. */
function useCopied(): [string | null, (key: string, text: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const copy = useCallback((key: string, text: string) => {
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopied(key);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(null), 1500);
      },
      () => undefined,
    );
  }, []);
  return [copied, copy];
}

export function Conversation({ view, sending, logRef, onScroll, onQuote, onDrafts, canDraft }: ConversationProps) {
  const { t } = useTranslation("assistant");
  const lines = view?.lines ?? [];
  const live = liveState(view, sending);
  // The live row names the call in progress, so that call's own line would only repeat it.
  const hidden = live?.phase === "tool" ? live.toolId : null;
  const entries = useMemo(() => groupLines((view?.lines ?? []).filter((l) => l.id !== hidden)), [view?.lines, hidden]);
  const [current, setCurrent] = useState<string | null>(null);
  const [copied, copy] = useCopied();
  const lastReply = [...lines].reverse().find((l) => l.role === "assistant")?.id ?? null;

  const items = () => [...(logRef.current?.querySelectorAll<HTMLElement>("[data-msg]") ?? [])];
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const up = matches(e, "assistant.prev");
    if (!up && !matches(e, "assistant.next")) return;
    const all = items();
    if (all.length === 0) return;
    const at = all.findIndex((el) => el.contains(e.target as Node));
    const next = at < 0 ? (up ? all.length - 1 : 0) : Math.max(0, Math.min(all.length - 1, at + (up ? -1 : 1)));
    e.preventDefault();
    all[next]!.focus();
    all[next]!.scrollIntoView({ block: "nearest" });
  };

  return (
    <div
      className="as-log mono"
      role="log"
      aria-live="off"
      aria-label={t("conversation")}
      tabIndex={0}
      ref={logRef}
      onScroll={onScroll}
      onKeyDown={onKey}
      onFocus={(e) => {
        const msg = (e.target as HTMLElement).closest<HTMLElement>("[data-msg]");
        if (msg) setCurrent(msg.dataset.msg ?? null);
      }}
      onBlur={(e) => {
        // Leaving the log makes it one Tab stop again: Shift Tab from the box lands on the log itself.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setCurrent(null);
      }}
    >
      {lines.length === 0 && !live && (
        <div className="as-hint">
          <p>{t("empty.lead")}</p>
          <p className="muted">{t("empty.example")}</p>
        </div>
      )}
      {entries.map((e) =>
        e.t === "tools" ? (
          <ToolBurst key={e.id} id={e.id} lines={e.lines} active={current === e.id} copied={copied} copy={copy} />
        ) : (
          <Line key={e.line.id} line={e.line} active={current === e.line.id} last={e.line.id === lastReply} copied={copied} copy={copy} onQuote={onQuote} onDrafts={onDrafts} canDraft={canDraft} />
        ),
      )}
      {live && <LiveRow live={live} />}
      {view?.ended === "failed" && view.detail && (
        <p className="as-line as-fail">
          <span className="as-who">{t("failed")}</span>
          <span className="as-text">{view.detail}</span>
        </p>
      )}
    </div>
  );
}

/** The row under your message while a turn runs: what it is doing now and for how long. */
function LiveRow({ live }: { live: LiveState }) {
  const { t } = useTranslation("assistant");
  const running = live.phase !== "streaming";
  const now = useNow(1000, running);
  const since = live.since ? Date.parse(live.since) : null;
  return (
    <div className="as-line as-live" data-phase={live.phase}>
      <span className="as-who" aria-hidden="true">
        {running && <span className="spin" />}
      </span>
      <span className="as-live-main">
        {running && (
          <span className="as-live-what">
            {live.phase === "tool" ? (
              <>
                <span className="as-live-label">{t("live.tool")}</span>
                <LiveTool tool={live.tool} call={live.toolCall} />
              </>
            ) : (
              <span className="as-live-label">{t(`live.${live.phase}`)}</span>
            )}
          </span>
        )}
        {live.queued > 0 && <span className="badge badge-warn as-live-queued">{t("live.queued", { count: live.queued })}</span>}
      </span>
      {running && since !== null && (
        <span className="num as-live-time" title={t("live.elapsed")}>
          {elapsedText(now - since)}
        </span>
      )}
    </div>
  );
}

interface Copying {
  copied: string | null;
  copy(key: string, text: string): void;
}

function ToolBurst({ id, lines, active, copied, copy }: { id: string; lines: AssistantLine[]; active: boolean } & Copying) {
  const { t } = useTranslation("assistant");
  const [open, setOpen] = useState(false);
  if (lines.length === 1) {
    const l = lines[0]!;
    return (
      <div className="as-line as-tool" data-msg={id} tabIndex={-1}>
        <span className="as-who" aria-hidden="true">
          ·
        </span>
        <ToolText line={l} active={active} copied={copied} copy={copy} copyKey={l.id} />
      </div>
    );
  }
  const c = toolCounts(lines);
  const parts = (["read", "search", "other"] as const).filter((k) => c[k] > 0).map((k) => t(`tools.${k}`, { count: c[k] }));
  return (
    <div className="as-burst">
      <button type="button" className="as-line as-tool as-burst-head" data-msg={id} tabIndex={active ? 0 : -1} aria-expanded={open} onClick={() => setOpen((x) => !x)}>
        <span className="as-who" aria-hidden="true">
          <ChevronRight className="as-chev" />
        </span>
        <span className="as-text">{parts.join(" · ")}</span>
      </button>
      {open && (
        <ul className="as-burst-list" aria-label={t("tools.list")}>
          {lines.map((l) => (
            <li key={l.id} className="as-line as-tool">
              <span className="as-who" aria-hidden="true">
                ·
              </span>
              <ToolText line={l} active={active} copied={copied} copy={copy} copyKey={l.id} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Crewyard's own line for one of the assistant's read or draft tools (docs/adr/0018), worded here in
 * the person's language from the tool, its outcome and its subject. The subject is a task's or
 * draft's title: untrusted, so it is only ever an interpolated text value, never markup.
 */
function useCallText(): (call: AssistantToolLine) => string {
  const { t } = useTranslation("assistant");
  return (call) => {
    const title = t(`toolLine.${call.outcome}.${call.tool}`);
    const subject = call.days !== undefined ? t("toolLine.days", { count: call.days }) : call.status ? t(`toolLine.status.${call.status}`) : call.subject;
    return subject ? t("toolLine.withSubject", { title, subject }) : title;
  };
}

function LiveTool({ tool, call }: { tool: string | null; call: AssistantToolLine | null }) {
  const callText = useCallText();
  const text = call ? callText(call) : tool;
  return (
    <span className="as-live-tool" title={text ?? undefined}>
      {text}
    </span>
  );
}

function ToolText({ line, active, copied, copy, copyKey }: { line: AssistantLine; active: boolean; copyKey: string } & Copying) {
  const callText = useCallText();
  const text = line.call ? callText(line.call) : line.text;
  // A path copy is offered only for a runner's own call title; our tools name tasks and drafts.
  const path = line.call ? null : pathIn(text);
  return (
    <span className="as-text as-tool-text">
      <span className="as-tool-title" title={text}>
        {text}
      </span>
      {path && <CopyPath path={path} active={active} copied={copied === copyKey} onCopy={() => copy(copyKey, path)} />}
    </span>
  );
}

function CopyPath({ path, active, copied, onCopy }: { path: string; active: boolean; copied: boolean; onCopy(): void }) {
  const { t } = useTranslation("assistant");
  const label = copied ? t("actions.copied") : t("actions.copyPath", { path });
  return (
    <button type="button" className="as-icon-btn as-copy-path" tabIndex={active ? 0 : -1} aria-label={label} title={label} onClick={onCopy}>
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
    </button>
  );
}

/** Crewyard's own Autopilot notices: a call it made (`autopilot.call.<outcome>.<tool>`) or a note it handed the session. */
function AutopilotNotice({ code }: { code: string }) {
  const { t } = useTranslation("autopilot");
  const call = /^autopilot\.call\.(done|refused)\.(\w+)$/.exec(code);
  const text = call ? t(`notice.call.${call[1]}`, { action: t(`log.action.${call[2]}`, { defaultValue: call[2] }) }) : t(`notice.${code.slice("autopilot.".length)}`, { defaultValue: code });
  return <p className={`as-line as-notice as-autopilot${call?.[1] === "refused" ? " as-autopilot-refused" : ""}`}>{text}</p>;
}

interface LineProps extends Copying {
  line: AssistantLine;
  active: boolean;
  last: boolean;
  onQuote(text: string): void;
  onDrafts(text: string): void;
  canDraft: boolean;
}

function Line({ line, active, last, copied, copy, onQuote, onDrafts, canDraft }: LineProps) {
  const { t } = useTranslation("assistant");
  if (line.role === "notice" && line.text.startsWith("autopilot.")) return <AutopilotNotice code={line.text} />;
  if (line.role === "notice") return <p className="as-line as-notice">{t(`notice.${line.text}`, { defaultValue: line.text })}</p>;
  if (line.role === "user")
    return (
      <div className="as-line as-user" data-msg={line.id} tabIndex={-1}>
        <span className="as-who">{t("you")}</span>
        <span className="as-text">{line.text}</span>
        {line.queued && <span className="badge badge-warn">{t("queued")}</span>}
      </div>
    );
  const tab = active ? 0 : -1;
  const copyLabel = copied === line.id ? t("actions.copied") : t("actions.copy");
  return (
    <article className="as-line as-reply" data-msg={line.id} data-last={last ? "" : undefined} tabIndex={-1} aria-label={t("actions.replyLabel")}>
      <span className="as-who">{t("agent")}</span>
      <div className="as-text as-md">
        <Markdown text={line.text} active={active} copied={copied} copy={copy} keyBase={line.id} />
        {line.truncated && <p className="muted">{t("truncated")}</p>}
      </div>
      <div className="as-acts" role="group" aria-label={t("actions.label")}>
        <button type="button" className="as-icon-btn" tabIndex={tab} aria-label={copyLabel} title={copyLabel} onClick={() => copy(line.id, line.text)}>
          {copied === line.id ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </button>
        <button type="button" className="as-icon-btn" tabIndex={tab} aria-label={t("actions.quote")} title={t("actions.quote")} onClick={() => onQuote(line.text)}>
          <Quote aria-hidden="true" />
        </button>
        <button type="button" className="as-icon-btn" tabIndex={tab} aria-label={t("actions.drafts")} title={t("actions.draftsTitle")} disabled={!canDraft} onClick={() => onDrafts(line.text)}>
          <ListPlus aria-hidden="true" />
        </button>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------- text-only Markdown

interface MdProps extends Copying {
  active: boolean;
  keyBase: string;
}

function Markdown({ text, ...rest }: { text: string } & MdProps) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <>
      {blocks.map((b, i) => (
        <MdBlock key={i} b={b} {...rest} keyBase={`${rest.keyBase}.${i}`} />
      ))}
    </>
  );
}

function MdBlock({ b, ...p }: { b: Block } & MdProps): ReactNode {
  const { t } = useTranslation("assistant");
  switch (b.t) {
    case "heading": {
      const H = `h${Math.min(6, b.level + 3)}` as "h4";
      return (
        <H className="as-md-h">
          <MdInline c={b.c} {...p} />
        </H>
      );
    }
    case "para":
      return (
        <p>
          <MdInline c={b.c} {...p} />
        </p>
      );
    case "code":
    case "table": {
      const label = p.copied === p.keyBase ? t("actions.copied") : t("actions.copyCode");
      return (
        <div className="as-pre">
          <pre>{b.v}</pre>
          <button type="button" className="as-icon-btn as-pre-copy" tabIndex={p.active ? 0 : -1} aria-label={label} title={label} onClick={() => p.copy(p.keyBase, b.v)}>
            {p.copied === p.keyBase ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          </button>
        </div>
      );
    }
    case "quote":
      return (
        <blockquote>
          {b.c.map((x, i) => (
            <MdBlock key={i} b={x} {...p} keyBase={`${p.keyBase}.${i}`} />
          ))}
        </blockquote>
      );
    case "rule":
      return <hr />;
    case "list": {
      const L = b.ordered ? "ol" : "ul";
      return (
        <L start={b.ordered ? b.start : undefined}>
          {b.items.map((item, i) => (
            <li key={i}>
              {item.map((x, j) => (
                <MdBlock key={j} b={x} {...p} keyBase={`${p.keyBase}.${i}.${j}`} />
              ))}
            </li>
          ))}
        </L>
      );
    }
  }
}

function MdInline({ c, ...p }: { c: Inline[] } & MdProps) {
  const { t } = useTranslation("assistant");
  return (
    <>
      {c.map((x, i) => {
        switch (x.t) {
          case "text":
            return <Fragment key={i}>{x.v}</Fragment>;
          case "code": {
            // A path in code marks gets a copy action; Crewyard never opens it or anything else from here.
            const key = `${p.keyBase}.c${i}`;
            return isPath(x.v) ? (
              <span key={i} className="as-path">
                <code>{x.v}</code>
                <CopyPath path={x.v} active={p.active} copied={p.copied === key} onCopy={() => p.copy(key, x.v)} />
              </span>
            ) : (
              <code key={i}>{x.v}</code>
            );
          }
          case "em":
            return (
              <em key={i}>
                <MdInline c={x.c} {...p} keyBase={`${p.keyBase}.${i}`} />
              </em>
            );
          case "strong":
            return (
              <strong key={i}>
                <MdInline c={x.c} {...p} keyBase={`${p.keyBase}.${i}`} />
              </strong>
            );
          // A link shows its target and is never followed: agent text cannot send you anywhere.
          case "link":
            return (
              <span key={i} className="as-md-link" title={x.href}>
                <MdInline c={x.c} {...p} keyBase={`${p.keyBase}.${i}`} />
                {x.href && <span className="as-md-href">{` ${x.href}`}</span>}
              </span>
            );
          // Named, never fetched: a remote image would tell its server the reply was read.
          case "image":
            return (
              <span key={i} className="as-md-img" title={x.src}>
                {t("imageRef", { alt: x.alt || x.src })}
              </span>
            );
        }
      })}
    </>
  );
}
