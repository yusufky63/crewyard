import type { AgentCapabilities, UserInput } from "./adapter.ts";
import type { ControlState } from "./ipc/tasks.ts";

// Images and files you attach to a task description or a queued message (PLAN.md §5.3). The
// daemon keeps a copy under the task folder and events carry only ids: the bytes never go into
// SQLite (MAX_EVENT_JSON). Each runner gets them through its own documented input; a kind it
// cannot take reaches it as a path in the text, and the UI disables that kind with the reason.

export type AttachmentKind = "image" | "file";

/** One stored attachment as an adapter sees it. `path` is the daemon's copy, absolute. */
export interface Attachment {
  id: string;
  kind: AttachmentKind;
  /** The file name you gave it, cleaned of path parts. */
  name: string;
  mime: string;
  bytes: number;
  path: string;
}

/** What the renderer gets: no path, since the renderer never reads files itself. */
export interface AttachmentView {
  id: string;
  kind: AttachmentKind;
  name: string;
  mime: string;
  bytes: number;
  createdAt: string;
}

export const ATTACHMENT_LIMITS = {
  /** Anthropic's per-image limit; the strictest of the four runners. */
  imageBytes: 5 * 1024 * 1024,
  fileBytes: 10 * 1024 * 1024,
  /** Per task description and per queued message. */
  perMessage: 8,
  /** Longest name kept; longer ones keep their extension. */
  nameChars: 120,
} as const;

export type AttachmentProblem = "attachment.type" | "attachment.too_large" | "attachment.empty" | "attachment.too_many" | "attachment.not_found" | "attachment.claimed";

/** Images every runner documents (Anthropic image blocks, Codex local images, OpenCode, ACP). */
const IMAGE_TYPES: Array<{ mime: string; ext: string[]; magic: (b: Uint8Array) => boolean }> = [
  { mime: "image/png", ext: ["png"], magic: (b) => starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { mime: "image/jpeg", ext: ["jpg", "jpeg"], magic: (b) => starts(b, [0xff, 0xd8, 0xff]) },
  { mime: "image/gif", ext: ["gif"], magic: (b) => starts(b, [0x47, 0x49, 0x46, 0x38]) },
  { mime: "image/webp", ext: ["webp"], magic: (b) => starts(b, [0x52, 0x49, 0x46, 0x46]) && starts(b.subarray(8), [0x57, 0x45, 0x42, 0x50]) },
];

/** Text files by extension; their content must also look like text. */
const TEXT_TYPES: Record<string, string> = {
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  jsonl: "application/json",
  yaml: "text/yaml",
  yml: "text/yaml",
  toml: "text/plain",
  xml: "application/xml",
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  ts: "text/plain",
  tsx: "text/plain",
  jsx: "text/javascript",
  py: "text/plain",
  rs: "text/plain",
  go: "text/plain",
  java: "text/plain",
  cs: "text/plain",
  c: "text/plain",
  h: "text/plain",
  cpp: "text/plain",
  sql: "text/plain",
  sh: "text/plain",
  ps1: "text/plain",
  diff: "text/plain",
  patch: "text/plain",
};

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];

function starts(b: Uint8Array, sig: number[]): boolean {
  return b.length >= sig.length && sig.every((x, i) => b[i] === x);
}

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * Keeps only the last path part, drops characters Windows refuses in a file name, and shortens it
 * while keeping the extension. Never empty.
 */
export function cleanAttachmentName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  let clean = base.replace(/[<>:"|?*\u0000-\u001f]/g, "_").replace(/^[.\s]+|[.\s]+$/g, "");
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(clean)) clean = `_${clean}`;
  if (clean.length > ATTACHMENT_LIMITS.nameChars) {
    const ext = extOf(clean);
    const keep = ext && ext.length < 12 ? `.${ext}` : "";
    clean = clean.slice(0, ATTACHMENT_LIMITS.nameChars - keep.length) + keep;
  }
  return clean || "attachment";
}

/** NUL bytes or many control codes in the first 8 KB: not a text file, whatever its name says. */
function binaryHead(b: Uint8Array): boolean {
  const head = b.subarray(0, 8192);
  let odd = 0;
  for (const c of head) {
    if (c === 0) return true;
    if (c < 0x20 && c !== 9 && c !== 10 && c !== 13 && c !== 12 && c !== 27) odd++;
  }
  return head.length > 0 && odd / head.length > 0.1;
}

/**
 * Decides what an upload is from its name and its first bytes. Images and PDFs must carry their
 * own signature (a renamed executable is refused); text files must look like text.
 */
export function classifyAttachment(name: string, head: Uint8Array): { kind: AttachmentKind; mime: string } | { problem: AttachmentProblem } {
  if (head.length === 0) return { problem: "attachment.empty" };
  const ext = extOf(name);
  const image = IMAGE_TYPES.find((t) => t.magic(head));
  if (image) return { kind: "image", mime: image.mime };
  if (IMAGE_TYPES.some((t) => t.ext.includes(ext))) return { problem: "attachment.type" };
  if (starts(head, PDF_MAGIC)) return { kind: "file", mime: "application/pdf" };
  if (ext === "pdf") return { problem: "attachment.type" };
  const text = TEXT_TYPES[ext];
  if (text && !binaryHead(head)) return { kind: "file", mime: text };
  return { problem: "attachment.type" };
}

export function attachmentLimit(kind: AttachmentKind): number {
  return kind === "image" ? ATTACHMENT_LIMITS.imageBytes : ATTACHMENT_LIMITS.fileBytes;
}

/** Text content (sent as text where a runner distinguishes it), as opposed to an image or a PDF. */
export function isTextAttachment(a: Pick<Attachment, "kind" | "mime">): boolean {
  return a.kind === "file" && a.mime !== "application/pdf";
}

/** The file picker's `accept` list: what classifyAttachment can take. */
export const ATTACHMENT_ACCEPT = [...IMAGE_TYPES.flatMap((t) => t.ext), "pdf", ...Object.keys(TEXT_TYPES)].map((e) => `.${e}`).join(",");

/** Which kinds a runner takes through its own input, from its capabilities. */
export function attachmentSupport(caps: AgentCapabilities): Record<AttachmentKind, boolean> {
  return { image: caps.attachments?.images === true, file: caps.attachments?.files === true };
}

/** Attaching each kind to a run's queue: off with the reason when its runner cannot take it (PLAN.md §5.1). */
export function attachControls(caps: AgentCapabilities | undefined): { image: ControlState; file: ControlState } {
  const support = caps ? attachmentSupport(caps) : { image: false, file: false };
  return {
    image: support.image ? { ok: true, reason: null } : { ok: false, reason: "attach.image_unsupported" },
    file: support.file ? { ok: true, reason: null } : { ok: false, reason: "attach.file_unsupported" },
  };
}

/**
 * The input for one turn: the runner gets the kinds it takes as attachments, and every attachment
 * is listed in the text with the path of our copy, so a kind it cannot take still reaches it as a
 * file to read (the way omux turns a pasted image into a path).
 */
export function withAttachments(text: string, list: Attachment[], caps: AgentCapabilities): UserInput {
  if (list.length === 0) return { kind: "text", text };
  const support = attachmentSupport(caps);
  const native = list.filter((a) => support[a.kind]);
  const lines = list.map((a) => (support[a.kind] ? `- ${a.name} (${a.mime}, attached to this message; a copy is at ${a.path})` : `- ${a.name} (${a.mime}; read it from ${a.path})`));
  const note = ["Attachments from the user:", ...lines].join("\n");
  return { kind: "text", text: text.trim() ? `${text}\n\n${note}` : note, ...(native.length > 0 ? { attachments: native } : {}) };
}

/** A turn's input from what nextTurn returned: plain text from older callers, or a full input. */
export function toUserInput(next: string | UserInput): UserInput {
  return typeof next === "string" ? { kind: "text", text: next } : next;
}
