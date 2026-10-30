import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, CornerDownRight, Pencil, Trash2, Undo2 } from "lucide-react";
import type { ControlState, QueuedMessageView, RunView, UndoPreview } from "@crewyard/core";
import { Button, Label } from "@crewyard/ui";
import { act } from "../screens/tasks/data.ts";
import { FIXTURE } from "../screens/tasks/fixture.ts";
import { codeKey } from "../screens/tasks/model.ts";
import { useFormat } from "../screens/tasks/parts.tsx";

// Turn control in the inspector (feature scan A10, A13): the step's follow-up queue, which stays
// editable until a turn boundary takes it, "Steer now" where the runner can add to a running turn,
// and "Undo last turn" with a preview of what will change. A control the runner cannot do stays
// visible and disabled with the reason (PLAN.md §5.1).

type OnError = (err: unknown) => void;

/** The reason a control is off, as one translated sentence. */
function useReason() {
  const { t } = useFormat();
  return (s: ControlState) => (s.reason ? t(`control.${codeKey(s.reason)}`) : "");
}

function QueueItem({ run, m, index, count, onError }: { run: RunView; m: QueuedMessageView; index: number; count: number; onError: OnError }) {
  const f = useFormat();
  const reason = useReason();
  const [draft, setDraft] = useState<string | null>(null);
  const go = (fn: () => Promise<unknown>) => void fn().catch(onError);
  const steer = run.controls.steer;
  const note = m.kind === "note";
  const label = f.t("inspector.queue.item", { index: index + 1 });
  return (
    <li className="ins-q-item">
      <span className="num muted">{String(index + 1).padStart(2, "0")}</span>
      <div className="ins-q-body">
        {draft === null ? (
          <p className="ins-q-text">{m.text}</p>
        ) : (
          <textarea className="ins-q-edit" rows={3} value={draft} autoFocus aria-label={f.t("inspector.queue.editLabel", { index: index + 1 })} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setDraft(null)} />
        )}
        <span className="ins-q-meta muted">
          {note ? f.t("inspector.queue.note") : f.t("inspector.queue.queuedAt", { time: f.when.ago(m.createdAt) })}
          {m.editedAt && ` · ${f.t("inspector.queue.edited")}`}
        </span>
        <div className="ins-q-acts">
          {draft === null ? (
            <>
              <Button size="sm" variant="ghost" aria-label={`${f.t("inspector.queue.up")} · ${label}`} title={f.t("inspector.queue.up")} disabled={index === 0} onClick={() => go(() => act("queue.move", { runId: run.id, messageId: m.id, index: index - 1 }))}>
                <ArrowUp aria-hidden="true" />
              </Button>
              <Button size="sm" variant="ghost" aria-label={`${f.t("inspector.queue.down")} · ${label}`} title={f.t("inspector.queue.down")} disabled={index === count - 1} onClick={() => go(() => act("queue.move", { runId: run.id, messageId: m.id, index: index + 1 }))}>
                <ArrowDown aria-hidden="true" />
              </Button>
              <Button size="sm" variant="ghost" aria-label={`${f.t("inspector.queue.edit")} · ${label}`} onClick={() => setDraft(m.text)}>
                <Pencil aria-hidden="true" />
                {f.t("inspector.queue.edit")}
              </Button>
              <Button size="sm" variant="ghost" aria-label={`${f.t("inspector.queue.delete")} · ${label}`} onClick={() => go(() => act("queue.delete", { runId: run.id, messageId: m.id }))}>
                <Trash2 aria-hidden="true" />
                {f.t("inspector.queue.delete")}
              </Button>
              {!note && (
                <Button
                  size="sm"
                  disabled={!steer.ok}
                  title={steer.ok ? f.t("inspector.queue.steerHint") : reason(steer)}
                  aria-label={`${f.t("inspector.queue.steer")} · ${label}`}
                  onClick={() => go(() => act("queue.steer", { runId: run.id, messageId: m.id, sessionId: run.nativeSessionId }))}
                >
                  <CornerDownRight aria-hidden="true" />
                  {f.t("inspector.queue.steer")}
                </Button>
              )}
            </>
          ) : (
            <>
              <Button
                size="sm"
                variant="primary"
                disabled={!draft.trim()}
                onClick={() =>
                  go(async () => {
                    await act("queue.edit", { runId: run.id, messageId: m.id, text: draft });
                    setDraft(null);
                  })
                }
              >
                {f.t("inspector.queue.save")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
                {f.t("inspector.queue.cancel")}
              </Button>
            </>
          )}
        </div>
      </div>
    </li>
  );
}

/** Messages for this step that the agent does not have yet. Shown as queued, never as sent. */
export function QueueSection({ run, onError }: { run: RunView; onError: OnError }) {
  const f = useFormat();
  const reason = useReason();
  if (run.queue.length === 0) return null;
  const steer = run.controls.steer;
  return (
    <div className="ins-sec" aria-live="polite">
      <Label>{f.t("inspector.queue.title", { count: run.queue.length })}</Label>
      <p className="muted ins-small">{run.endedAt === null && !run.pausedAt ? f.t("inspector.queue.waitTurn") : f.t("inspector.queue.waitRun")}</p>
      <ol className="ins-q">
        {run.queue.map((m, i) => (
          <QueueItem key={m.id} run={run} m={m} index={i} count={run.queue.length} onError={onError} />
        ))}
      </ol>
      {!steer.ok && run.queue.some((m) => m.kind === "user") && <p className="muted ins-small">{reason(steer)}</p>}
    </div>
  );
}

const CHANGE_ORDER = { delete: 0, recreate: 1, restore: 2 } as const;

/** "Undo last turn": preview first, confirm, then the daemon checks again and undoes. */
export function UndoControl({ run, onError }: { run: RunView; onError: OnError }) {
  const f = useFormat();
  const reason = useReason();
  const [preview, setPreview] = useState<UndoPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const undo = run.controls.undo;
  const ask = async () => {
    setBusy(true);
    try {
      setPreview(await act("runs.undoPreview", { runId: run.id }));
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };
  // Screenshot mode only: `undoPreview` in the query opens the preview without a click.
  useEffect(() => {
    if (FIXTURE && new URLSearchParams(location.search).has("undoPreview") && undo.ok) void Promise.resolve().then(ask);
    // Once, on mount, like the other fixture switches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const confirm = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      await act("runs.undo", { runId: run.id, turnId: preview.turnId });
      setPreview(null);
    } catch (err) {
      onError(err);
      setPreview(null);
    } finally {
      setBusy(false);
    }
  };
  if (!preview) {
    return (
      <div className="ins-undo">
        <Button disabled={!undo.ok || busy} onClick={() => void ask()} aria-describedby={undo.ok ? undefined : `undo-why-${run.id}`}>
          <Undo2 aria-hidden="true" />
          {f.t("inspector.undo.button")}
        </Button>
        {!undo.ok && (
          <span className="muted ins-small" id={`undo-why-${run.id}`}>
            {reason(undo)}
          </span>
        )}
      </div>
    );
  }
  const files = [...preview.files].sort((a, b) => CHANGE_ORDER[a.change] - CHANGE_ORDER[b.change] || a.path.localeCompare(b.path));
  return (
    <div className="ins-undo-confirm" role="group" aria-labelledby={`undo-title-${run.id}`} onKeyDown={(e) => e.key === "Escape" && setPreview(null)}>
      <Label>{f.t("inspector.undo.eyebrow")}</Label>
      <p className="ins-undo-title" id={`undo-title-${run.id}`}>
        {f.t("inspector.undo.title", { time: f.when.at(preview.turnStartedAt) })}
      </p>
      {files.length === 0 ? (
        <p className="muted ins-small">{f.t("inspector.undo.noFiles")}</p>
      ) : (
        <ul className="ins-files">
          {files.map((x) => (
            <li key={x.path}>
              <span className="mono">
                <span className={`ins-undo-change c-${x.change}`}>{f.t(`inspector.undo.change.${x.change}`)}</span> {x.path}
              </span>
              <span className="mono add">+{x.added}</span>
              <span className="mono del">−{x.removed}</span>
            </li>
          ))}
        </ul>
      )}
      {preview.commits > 0 && <p className="ins-small">{f.t("inspector.undo.commits", { count: preview.commits })}</p>}
      <p className="muted ins-small">{f.t(`inspector.undo.native.${preview.native.files ? "files" : "nofiles"}_${preview.native.history ? "history" : "nohistory"}`)}</p>
      {preview.noteQueued && <p className="muted ins-small">{f.t("inspector.undo.note")}</p>}
      <p className="muted ins-small">{f.t("inspector.undo.kept")}</p>
      <div className="ins-buttons">
        <Button variant="ghost" onClick={() => setPreview(null)}>
          {f.t("action.keep")}
        </Button>
        <Button variant="danger" autoFocus disabled={busy} onClick={() => void confirm()}>
          <Undo2 aria-hidden="true" />
          {f.t("inspector.undo.confirm")}
        </Button>
      </div>
    </div>
  );
}
