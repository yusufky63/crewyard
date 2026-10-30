import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { MessageSquarePlus, Send, Trash2, X } from "lucide-react";
import type { DiffFile, DiffScope, ReviewComment, RunView, TaskDetail } from "@crewyard/core";
import { Button, Label } from "@crewyard/ui";
import { act, useErrorText, useWork } from "./data.ts";
import { FIXTURE } from "./fixture.ts";
import { ErrorLine, useFormat } from "./parts.tsx";
import { buildRows, displayText, firstAdded, fileStart, fileStep, first, hunkExcerpt, offsets, ROW_HEIGHT, scrollFor, step, totals, visibleRange, type CommentTarget, type Row } from "./review.ts";
import "./review.css";
import { matches, type ShortcutId } from "../../keys.ts";

// Diff review with line comments (A2). Opened from the inspector's Changes tab. Comments are
// drafts in the daemon until the owning run accepted the batch; the batch goes through
// runs.message, so a working agent reads it at its next turn. Only rows in view are rendered.

const ICON = { size: 14, strokeWidth: 1.75 } as const;
const SIGN = { add: "+", del: "−", context: " " } as const;

/** The step that receives the comments: the latest run of the step that writes in the worktree. */
function ownerOf(detail: TaskDetail): RunView | null {
  const byId = detail.worktree?.ownerRunId ? detail.runs.find((r) => r.id === detail.worktree!.ownerRunId) : undefined;
  const memberId = byId?.memberId ?? detail.crew?.members.find((m) => m.writesCode)?.id;
  if (!memberId) return null;
  return detail.runs.filter((r) => r.memberId === memberId).sort((a, b) => a.startedAt.localeCompare(b.startedAt)).at(-1) ?? null;
}

function useDrafts(taskId: string) {
  const qc = useQueryClient();
  const q = useWork("github.reviewDrafts", { taskId }, { retry: false });
  const set = (list: ReviewComment[]) => qc.setQueryData(["github.reviewDrafts", { taskId }], list);
  return { drafts: q.data ?? [], set, refetch: () => q.refetch() };
}

/** Mounted once in the inspector's Changes tab. */
export function DiffReview({ detail, run }: { detail: TaskDetail; run: RunView | null }) {
  const f = useFormat();
  const fixtureOpen = FIXTURE && new URLSearchParams(location.search).has("review");
  const [open, setOpen] = useState<DiffScope | null>(fixtureOpen ? "worktree" : null);
  const opener = useRef<HTMLDivElement>(null);
  const { drafts } = useDrafts(detail.id);
  if (!detail.worktree) return null;
  const turn = Boolean(run?.diff?.length);
  return (
    <div className="ins-sec rv-entry">
      <div className="row" ref={opener}>
        <Button size="sm" onClick={() => setOpen("worktree")}>
          <MessageSquarePlus {...ICON} aria-hidden="true" />
          {f.t("review.open")}
        </Button>
        {turn && (
          <Button size="sm" variant="ghost" onClick={() => setOpen("turn")}>
            {f.t("review.openTurn")}
          </Button>
        )}
      </div>
      {drafts.length > 0 && <p className="muted rv-small">{f.t("review.drafted", { count: drafts.length })}</p>}
      {open && (
        <ReviewDialog
          detail={detail}
          run={turn ? run : null}
          scope={open}
          onScope={setOpen}
          onClose={() => {
            setOpen(null);
            // Back to where the dialog was opened from, once it is gone, not to the page body.
            requestAnimationFrame(() => opener.current?.querySelector("button")?.focus());
          }}
        />
      )}
    </div>
  );
}

function ReviewDialog({ detail, run, scope, onScope, onClose }: { detail: TaskDetail; run: RunView | null; scope: DiffScope; onScope: (s: DiffScope) => void; onClose: () => void }) {
  const f = useFormat();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const ref = useRef<HTMLDialogElement>(null);
  const view = useRef<HTMLDivElement>(null);
  const listId = useId();
  const diff = useWork("github.taskDiff", scope === "turn" && run ? { taskId: detail.id, scope, runId: run.id } : { taskId: detail.id, scope }, { retry: false, staleTime: 5_000 });
  const { drafts, set } = useDrafts(detail.id);
  const fixtureEdit = FIXTURE && new URLSearchParams(location.search).get("review") === "edit";
  const [chosen, setEditing] = useState<CommentTarget | null>(null);
  const [fixtureDone, setFixtureDone] = useState(false);
  const [text, setText] = useState("");
  // The active row is kept by identity, so adding a comment above it does not move the selection.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const files: DiffFile[] = useMemo(() => diff.data?.files ?? [], [diff.data]);
  // A screenshot run can open the editor on the first added line.
  const firstAdd = useMemo(() => firstAdded(files), [files]);
  const editing = chosen ?? (fixtureEdit && !fixtureDone ? firstAdd : null);
  const rows = useMemo(() => buildRows(files, drafts, editing), [files, drafts, editing]);
  const found = activeKey === null ? -1 : rows.findIndex((r) => rowId(r) === activeKey);
  const active = found === -1 ? first(rows) : found;
  const setActive = (i: number) => setActiveKey(rows[i] ? rowId(rows[i]!) : null);
  const tops = useMemo(() => offsets(rows), [rows]);
  const [start, end] = visibleRange(tops, scrollTop, height);
  const owner = ownerOf(detail);
  const who = owner ? `${f.role(owner.role)} · ${f.runner(owner.runner)}` : null;
  const sum = totals(files);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    view.current?.focus();
    return () => d?.close();
  }, []);

  useLayoutEffect(() => {
    const el = view.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const go = (i: number) => {
    const clamped = Math.max(0, Math.min(rows.length - 1, i));
    setActive(clamped);
    const el = view.current;
    if (!el) return;
    const next = scrollFor(tops, clamped, el.scrollTop, el.clientHeight);
    if (next !== null) el.scrollTop = next;
  };

  const startComment = (target: CommentTarget) => {
    setEditing(target);
    setText("");
    setError(null);
  };

  const cancelEdit = () => {
    setEditing(null);
    setFixtureDone(true);
    setText("");
    view.current?.focus();
  };

  const save = async () => {
    if (!editing || !text.trim()) return;
    const row = rows.find((r) => r.kind === "line" && r.target.path === editing.path && r.target.line === editing.line && r.target.side === editing.side);
    const hunk = row?.kind === "line" ? hunkExcerpt(files[row.file]!.hunks[row.hunk]!, row.index) : "";
    try {
      set(await act("github.addReviewComment", { taskId: detail.id, ...editing, body: text.trim(), hunk }));
      cancelEdit();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const remove = async (id: string) => {
    try {
      set(await act("github.removeReviewComment", { taskId: detail.id, id }));
    } catch (err) {
      setError(errorText(err));
    }
  };

  const send = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await act("github.sendReview", { taskId: detail.id });
      setNotice(f.t("review.sent", { count: res.sent, who: who ?? "" }));
    } catch (err) {
      // The daemon kept every draft; nothing is lost.
      setError(errorText(err));
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: ["github.reviewDrafts", { taskId: detail.id }] });
      void qc.invalidateQueries({ queryKey: ["tasks.get"] });
    }
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const page = Math.max(1, Math.floor(height / ROW_HEIGHT.line) - 2);
    const row = rows[active];
    const moves: Array<[ShortcutId, () => number]> = [
      ["review.next", () => step(rows, active, 1)],
      ["review.prev", () => step(rows, active, -1)],
      ["review.pageDown", () => step(rows, active, page)],
      ["review.pageUp", () => step(rows, active, -page)],
      ["review.first", () => first(rows)],
      ["review.last", () => step(rows, rows.length, -1)],
      ["review.nextFile", () => fileStep(rows, active, 1)],
      ["review.prevFile", () => fileStep(rows, active, -1)],
    ];
    const move = moves.find(([id]) => matches(e, id))?.[1];
    if (move) {
      e.preventDefault();
      go(move());
      return;
    }
    if (matches(e, "review.comment") && row?.kind === "line") {
      e.preventDefault();
      startComment(row.target);
    } else if (matches(e, "review.remove") && row?.kind === "comment") {
      e.preventDefault();
      void remove(row.comment.id);
    }
  };

  const activeId = rows[active] ? `${listId}-${active}` : undefined;

  return (
    <dialog
      ref={ref}
      className="rv-dialog panel"
      aria-label={f.t("review.title", { title: detail.title })}
      onCancel={(e) => {
        e.preventDefault();
        if (editing) cancelEdit();
        else onClose();
      }}
    >
      <div className="rv-head">
        <div className="rv-head-text">
          <Label>{f.t("review.eyebrow")}</Label>
          <h2>{detail.title}</h2>
          <span className="lbl rv-sub">
            <span className="as-typed">{detail.worktree?.branch}</span>
            {diff.data?.baseSha && <span>{f.t("review.base", { sha: diff.data.baseSha.slice(0, 7) })}</span>}
            <span>{f.t("review.totals", { count: sum.files, added: sum.added, removed: sum.removed })}</span>
          </span>
        </div>
        <div className="seg" role="group" aria-label={f.t("review.scope")}>
          {(["worktree", "turn"] as const).map((s) => (
            <button key={s} type="button" aria-pressed={scope === s} disabled={s === "turn" && !run} title={s === "turn" && !run ? f.t("review.noTurn") : f.t(`review.scopeHint.${s}`)} onClick={() => onScope(s)}>
              {f.t(`review.scopeName.${s}`)}
            </button>
          ))}
        </div>
        <button type="button" className="rv-x" onClick={onClose} aria-label={f.t("review.close")} title={f.t("review.close")}>
          <X size={16} strokeWidth={1.75} />
        </button>
      </div>

      <div className="rv-main">
        <aside className="rv-side">
          <Label>{f.t("review.files", { count: files.length })}</Label>
          <ul className="rv-files">
            {files.map((file, fi) => {
              const n = drafts.filter((d) => d.path === file.path).length;
              return (
                <li key={file.path}>
                  <button type="button" aria-current={rows[active]?.file === fi ? "true" : undefined} onClick={() => go(fileStart(rows, fi))} title={file.path}>
                    <span className="mono rv-path">{file.path}</span>
                    <span className="mono rv-add">+{file.added}</span>
                    <span className="mono rv-del">−{file.removed}</span>
                    {n > 0 && <span className="mono rv-count" aria-label={f.t("review.commentCount", { count: n })}>{n}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
          <Label>{f.t("review.drafts", { count: drafts.length })}</Label>
          {drafts.length === 0 ? (
            <p className="muted rv-small">{f.t("review.noDrafts")}</p>
          ) : (
            <ul className="rv-drafts">
              {drafts.map((d) => {
                const at = rows.findIndex((r) => r.kind === "comment" && r.comment.id === d.id);
                return (
                  <li key={d.id}>
                    <button type="button" disabled={at === -1} title={at === -1 ? f.t("review.notInView") : undefined} onClick={() => go(at)}>
                      <span className="mono rv-where">{`${d.path}:${d.line}`}</span>
                      <span className="rv-body">{d.body}</span>
                    </button>
                    <button type="button" className="rv-icon" onClick={() => void remove(d.id)} aria-label={f.t("review.remove", { where: `${d.path}:${d.line}` })} title={f.t("review.remove", { where: `${d.path}:${d.line}` })}>
                      <Trash2 {...ICON} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        <div className="rv-diff">
          {diff.data?.cut && <p className="rv-banner">{f.t("review.cut")}</p>}
          {diff.data?.problem && <p className="rv-banner">{f.t(`review.problem.${diff.data.problem}`)}</p>}
          {diff.isError && <p className="rv-banner">{errorText(diff.error)}</p>}
          {diff.isLoading && <p className="muted rv-pad">{f.t("review.loading")}</p>}
          {diff.isSuccess && !diff.data.problem && files.length === 0 && <p className="muted rv-pad">{scope === "turn" ? f.t("review.emptyTurn") : f.t("review.empty")}</p>}
          <div
            ref={view}
            className="rv-view"
            tabIndex={0}
            role="listbox"
            aria-label={f.t("review.listLabel")}
            aria-activedescendant={editing ? undefined : activeId}
            onKeyDown={onKey}
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          >
            <div className="rv-canvas" style={{ height: tops[rows.length] ?? 0 }}>
              {rows.slice(start, end).map((r, k) => {
                const i = start + k;
                return (
                  <RowView
                    key={rowKey(r, i)}
                    row={r}
                    file={files[r.file]!}
                    id={`${listId}-${i}`}
                    top={tops[i]!}
                    active={i === active}
                    text={text}
                    onText={setText}
                    onPick={() => setActive(i)}
                    onComment={() => {
                      setActive(i);
                      if (r.kind === "line") startComment(r.target);
                    }}
                    onRemove={(id) => void remove(id)}
                    onSave={() => void save()}
                    onCancel={cancelEdit}
                  />
                );
              })}
            </div>
          </div>
          <p className="rv-keys muted">{f.t("review.keys")}</p>
        </div>
      </div>

      <div className="rv-foot">
        <p className="rv-note">{who ? f.t("review.sendNote", { who }) : f.t("review.noOwner")}</p>
        <div className="rv-msgs" aria-live="polite">
          {notice && <span className="rv-ok">{notice}</span>}
          <ErrorLine>{error}</ErrorLine>
        </div>
        <Button variant="primary" disabled={drafts.length === 0 || busy || !owner} onClick={() => void send()}>
          <Send {...ICON} aria-hidden="true" />
          {busy ? f.t("review.sending") : f.t("review.send", { count: drafts.length })}
        </Button>
      </div>
    </dialog>
  );
}

/** Stable identity of a row across rebuilds; only lines and comments can be active. */
const rowId = (r: Row) => (r.kind === "line" ? `l:${r.file}:${r.hunk}:${r.index}` : r.kind === "comment" ? `c:${r.comment.id}` : `${r.kind}:${r.file}`);

const rowKey = (r: Row, i: number) => (r.kind === "comment" ? `c-${r.comment.id}` : r.kind === "editor" ? "editor" : `${r.kind}-${i}`);

function RowView({
  row,
  file,
  id,
  top,
  active,
  text,
  onText,
  onPick,
  onComment,
  onRemove,
  onSave,
  onCancel,
}: {
  row: Row;
  file: DiffFile;
  id: string;
  top: number;
  active: boolean;
  text: string;
  onText: (t: string) => void;
  onPick: () => void;
  onComment: () => void;
  onRemove: (id: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const f = useFormat();
  const style = { top, height: ROW_HEIGHT[row.kind] };
  switch (row.kind) {
    case "file":
      return (
        <div className="rv-row rv-file" style={style}>
          <span className="mono rv-path">{file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}</span>
          <span className="lbl">{f.t(`review.status.${file.status}`)}</span>
          <span className="mono rv-add">+{file.added}</span>
          <span className="mono rv-del">−{file.removed}</span>
        </div>
      );
    case "hunk":
      return (
        <div className="rv-row rv-hunk mono" style={style}>
          {row.header}
        </div>
      );
    case "note":
      return (
        <div className="rv-row rv-notice" style={style}>
          {f.t(`review.note.${row.note}`, { added: file.added, removed: file.removed })}
        </div>
      );
    case "line": {
      const l = row.line;
      return (
        // Keyboard users reach lines through the listbox's arrow keys; the click only mirrors that.
        <div id={id} role="option" aria-selected={active} className={`rv-row rv-line k-${l.kind}${active ? " is-active" : ""}`} style={style} onClick={onPick} onDoubleClick={onComment}>
          <span className="rv-no mono">{l.old ?? ""}</span>
          <span className="rv-no mono">{l.new ?? ""}</span>
          <span className="rv-sign mono" aria-hidden="true">
            {SIGN[l.kind]}
          </span>
          <span className="sr">{f.t(`review.kind.${l.kind}`)}</span>
          <span className="rv-code mono">{displayText(l.text)}</span>
          <button type="button" className="rv-plus" tabIndex={-1} onClick={(e) => {
              e.stopPropagation();
              onComment();
            }} aria-label={f.t("review.addAt", { where: `${row.target.path}:${row.target.line}` })}>
            <MessageSquarePlus size={12} strokeWidth={1.75} />
          </button>
        </div>
      );
    }
    case "comment":
      return (
        <div id={id} role="option" aria-selected={active} className={`rv-row rv-comment${active ? " is-active" : ""}`} style={style} onClick={onPick}>
          <div className="rv-comment-head">
            <span className="lbl">{f.t("review.draft")}</span>
            <span className="mono muted">{`${row.comment.path}:${row.comment.line}`}</span>
            <button type="button" className="rv-icon" tabIndex={-1} onClick={(e) => {
                e.stopPropagation();
                onRemove(row.comment.id);
              }} aria-label={f.t("review.remove", { where: `${row.comment.path}:${row.comment.line}` })}>
              <Trash2 size={12} strokeWidth={1.75} />
            </button>
          </div>
          <div className="rv-comment-body" title={row.comment.body}>
            {row.comment.body}
          </div>
        </div>
      );
    case "editor":
      return (
        <form
          className="rv-row rv-editor"
          style={style}
          onSubmit={(e) => {
            e.preventDefault();
            onSave();
          }}
        >
          <label className="lbl rv-editor-label" htmlFor={`${id}-text`}>
            <span>{f.t("review.commentHead")}</span>
            {/* A path keeps its own case; uppercasing would turn i into İ in Turkish. */}
            <span className="as-typed">{`${row.target.path}:${row.target.line}`}</span>
          </label>
          <textarea
            id={`${id}-text`}
            // The editor opens from a key or a click on purpose, so it takes focus right away.
            autoFocus
            rows={3}
            value={text}
            onChange={(e) => onText(e.target.value)}
            placeholder={f.t("review.placeholder")}
            onKeyDown={(e) => {
              if (matches(e, "close")) {
                e.preventDefault();
                e.stopPropagation();
                onCancel();
              } else if (matches(e, "submit")) {
                e.preventDefault();
                onSave();
              }
            }}
          />
          <div className="rv-editor-actions">
            <span className="muted rv-small">{f.t("review.editorKeys")}</span>
            <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
              {f.t("review.cancel")}
            </Button>
            <Button type="submit" size="sm" disabled={!text.trim()}>
              {f.t("review.add")}
            </Button>
          </div>
        </form>
      );
  }
}
