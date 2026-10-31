import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { FileText, Paperclip, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ATTACHMENT_ACCEPT, ATTACHMENT_LIMITS, type AttachmentKind, type AttachmentView, type ControlState } from "@crewyard/core";
import { Button } from "@crewyard/ui";
import { act, useErrorText, useWork } from "./data.ts";
import { codeKey } from "./model.ts";

// Images and files on a task description or a queued message (DESIGN.md `Composer`): pasted with
// Ctrl V, dropped, or picked. Each upload goes to the daemon at once, which checks its type and
// size and keeps the copy; the draft holds only ids. A kind the runner cannot take stays visible
// and disabled with the reason (PLAN.md §5.1).

const BOTH: Record<AttachmentKind, ControlState> = { image: { ok: true, reason: null }, file: { ok: true, reason: null } };

/** The kind a picked or pasted file will be, from its type as the browser reports it. */
const kindOf = (f: File): AttachmentKind => (f.type.startsWith("image/") ? "image" : "file");

function readAsDataUrl(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.readAsDataURL(f);
  });
}

export interface DraftAttachment {
  view: AttachmentView;
  /** The image's own bytes, so the thumbnail needs no round trip. */
  preview: string | null;
}

/** Uploads for one draft: add, remove (discarded in the daemon) and clear after sending. */
export function useAttachmentDraft(allowed: Record<AttachmentKind, ControlState> = BOTH) {
  const { t } = useTranslation("tasks");
  const errorText = useErrorText();
  const [items, setItems] = useState<DraftAttachment[]>([]);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const reason = (s: ControlState) => (s.reason ? t(`control.${codeKey(s.reason)}`) : "");

  const add = async (files: File[]) => {
    setError(null);
    const room = ATTACHMENT_LIMITS.perMessage - items.length - pending;
    if (files.length > room) setError(t("errors.attachment_too_many"));
    for (const f of files.slice(0, Math.max(0, room))) {
      const kind = kindOf(f);
      if (!allowed[kind].ok) {
        setError(reason(allowed[kind]));
        continue;
      }
      // The daemon checks the exact cap; this only spares a large read that cannot pass.
      const max = kind === "image" ? ATTACHMENT_LIMITS.imageBytes : ATTACHMENT_LIMITS.fileBytes;
      if (f.size > max) {
        setError(t("errors.attachment_too_large"));
        continue;
      }
      setPending((n) => n + 1);
      try {
        const data = await readAsDataUrl(f);
        const view = await act("attachments.add", { name: f.name || t("attach.pastedName", { ext: f.type.split("/")[1] ?? "png" }), data });
        setItems((list) => [...list, { view, preview: view.kind === "image" ? data : null }]);
      } catch (err) {
        setError(errorText(err));
      } finally {
        setPending((n) => n - 1);
      }
    }
  };

  const remove = (id: string) => {
    setItems((list) => list.filter((x) => x.view.id !== id));
    // An upload left behind is swept by the daemon after a day; a failure here needs no message.
    void act("attachments.discard", { id }).catch(() => undefined);
  };

  /**
   * Ctrl V with an image or file on the clipboard attaches it. Text wins when the clipboard has
   * both (a copied web page carries its picture too), as omux does for terminal pastes.
   */
  const onPaste = (e: ClipboardEvent) => {
    const files = [...e.clipboardData.files];
    if (files.length === 0 || e.clipboardData.types.includes("text/plain")) return;
    e.preventDefault();
    void add(files);
  };
  const onDragOver = (e: DragEvent) => {
    if (e.dataTransfer.types.includes("Files")) e.preventDefault();
  };
  const onDrop = (e: DragEvent) => {
    if (e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    void add([...e.dataTransfer.files]);
  };

  return {
    items,
    ids: items.map((x) => x.view.id),
    busy: pending > 0,
    error,
    full: items.length + pending >= ATTACHMENT_LIMITS.perMessage,
    add,
    remove,
    clear: () => setItems([]),
    handlers: { onPaste, onDragOver, onDrop },
  };
}

export type AttachmentDraft = ReturnType<typeof useAttachmentDraft>;

/**
 * "Attach" opens the file picker for the kinds allowed. When neither kind is, the button stays
 * and says why; when one is, the picker offers only that one and the reason for the other shows.
 */
export function AttachButton({ draft, allowed = BOTH, size = "sm" }: { draft: AttachmentDraft; allowed?: Record<AttachmentKind, ControlState>; size?: "sm" | "md" }) {
  const { t } = useTranslation("tasks");
  const input = useRef<HTMLInputElement>(null);
  const reasons = (["image", "file"] as const).filter((k) => !allowed[k].ok).map((k) => t(`control.${codeKey(allowed[k].reason!)}`));
  const none = !allowed.image.ok && !allowed.file.ok;
  const accept = allowed.file.ok ? (allowed.image.ok ? ATTACHMENT_ACCEPT : ATTACHMENT_ACCEPT.split(",").filter((e) => ![".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(e)).join(",")) : ".png,.jpg,.jpeg,.gif,.webp";
  const title = [t("attach.hint", { max: ATTACHMENT_LIMITS.perMessage }), ...reasons].join(" ");
  return (
    <>
      <Button type="button" size={size} variant="ghost" disabled={none || draft.full} title={title} aria-label={t("attach.button")} onClick={() => input.current?.click()}>
        <Paperclip aria-hidden="true" />
        {t("attach.button")}
      </Button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        tabIndex={-1}
        accept={accept}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          if (files.length) void draft.add(files);
        }}
      />
      {reasons.length > 0 && !none && <span className="muted tk-small tk-attach-why">{reasons.join(" ")}</span>}
    </>
  );
}

function size(bytes: number, lang: string): string {
  const fmt = (n: number) => n.toLocaleString(lang, { maximumFractionDigits: 1 });
  if (bytes < 1024) return `${fmt(bytes)} B`;
  if (bytes < 1024 * 1024) return `${fmt(bytes / 1024)} KB`;
  return `${fmt(bytes / 1024 / 1024)} MB`;
}

function Tile({ view, preview, onRemove }: { view: AttachmentView; preview: string | null; onRemove?: () => void }) {
  const { t, i18n } = useTranslation("tasks");
  const label = t(view.kind === "image" ? "attach.imageAlt" : "attach.fileLabel", { name: view.name });
  return (
    <li className="tk-attach-tile">
      {view.kind === "image" && preview ? <img src={preview} alt={label} /> : <FileText size={20} strokeWidth={1.75} aria-hidden="true" />}
      <span className="tk-attach-name" title={view.name}>
        {view.name}
      </span>
      <span className="num muted tk-small">{size(view.bytes, i18n.language)}</span>
      {onRemove && (
        <button type="button" className="tk-attach-remove" onClick={onRemove} aria-label={t("attach.remove", { name: view.name })} title={t("attach.remove", { name: view.name })}>
          <X size={12} strokeWidth={1.75} />
        </button>
      )}
    </li>
  );
}

/** The draft's uploads, removable, with what is still uploading and the last refusal. */
export function DraftAttachments({ draft }: { draft: AttachmentDraft }) {
  const { t } = useTranslation("tasks");
  if (draft.items.length === 0 && !draft.busy && !draft.error) return null;
  return (
    <div className="tk-attach" aria-live="polite">
      {draft.items.length > 0 && (
        <ul className="tk-attach-list" aria-label={t("attach.listLabel", { count: draft.items.length })}>
          {draft.items.map((x) => (
            <Tile key={x.view.id} view={x.view} preview={x.preview} onRemove={() => draft.remove(x.view.id)} />
          ))}
        </ul>
      )}
      {draft.busy && <p className="muted tk-small">{t("attach.uploading")}</p>}
      {draft.error && <p className="tk-error">{draft.error}</p>}
    </div>
  );
}

function StoredTile({ view }: { view: AttachmentView }) {
  const preview = useWork("attachments.preview", { id: view.id }, { enabled: view.kind === "image", staleTime: Infinity, retry: false });
  return <Tile view={view} preview={preview.data?.dataUrl ?? null} />;
}

/** Stored attachments, read-only: the crew proposal, the queue. */
export function AttachmentList({ items, compact = false }: { items: AttachmentView[] | undefined; compact?: boolean }) {
  const { t } = useTranslation("tasks");
  if (!items?.length) return null;
  return (
    <ul className={compact ? "tk-attach-list compact" : "tk-attach-list"} aria-label={t("attach.listLabel", { count: items.length })}>
      {items.map((v) => (
        <StoredTile key={v.id} view={v} />
      ))}
    </ul>
  );
}

/**
 * A draft closed unsent gives its uploads back now instead of leaving them for the daemon's daily
 * sweep. One that was sent has been cleared, so nothing claimed is touched.
 */
export function useDiscardOnUnmount(draft: AttachmentDraft) {
  const ids = useRef<string[]>([]);
  const key = draft.ids.join(",");
  useEffect(() => {
    ids.current = key ? key.split(",") : [];
  }, [key]);
  useEffect(() => () => ids.current.forEach((id) => void act("attachments.discard", { id }).catch(() => undefined)), []);
}
