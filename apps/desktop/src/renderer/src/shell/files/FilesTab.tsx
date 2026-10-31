import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, File, FileText, Folder, FolderOpen, Image as ImageIcon, Link2, X } from "lucide-react";
import type { FileMention, FilePreview, FolderListing, IpcParams, TaskDetail, TasksTopics } from "@crewyard/core";
import { Label } from "@crewyard/ui";
import { call } from "../../ipc.ts";
import { useFormat } from "../../screens/tasks/parts.tsx";
import { FIXTURE } from "../timeline/fixture.ts";
import { filesFixture } from "./fixture.ts";
import { parseMarkdown, type Block, type Inline } from "./markdown.ts";
import { flatten, isMarkdown, parentOf, treeKey, type Row } from "./tree.ts";
import "./files.css";

// The inspector's Files tab (after omux's Files panel): what the agent named first, then the
// task worktree as a lazy tree, then a read-only preview. Folders load only when opened, and
// gitignored ones (node_modules, build output) are marked and stay closed until asked. The daemon
// confines every read to the worktree; this view never writes and never follows a link.

type FilesMethod = "worktrees.listDir" | "worktrees.readFile" | "worktrees.mentions";
/** Screenshot mode: `files=open` opens src and src/auth, `file=<path>` previews one file. */
const SHOT = FIXTURE ? new URLSearchParams(location.search) : null;
const ICON = { size: 14, strokeWidth: 1.75, "aria-hidden": true } as const;

function read<M extends FilesMethod>(method: M, params: IpcParams<M>) {
  return FIXTURE ? Promise.resolve(filesFixture(method, (params as { path?: string }).path) as never) : call(method, params);
}

function bytes(n: number, locale: string): string {
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: u === 0 ? 0 : 1 }).format(v)} ${units[u]}`;
}

/** The daemon throws the code itself; Electron wraps it as "Error invoking remote method ...: Error: <code>". */
const codeOf = (err: unknown) =>
  String(err instanceof Error ? err.message : err)
    .replace(/^.*Error: /, "")
    .trim();

/** Re-reads this task's listings, preview and mentions while its runs work, at most every 2 s. */
function useLiveFiles(taskId: string): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (FIXTURE) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const later = () =>
      (timer ??= setTimeout(() => {
        timer = null;
        void qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("worktrees.") && (q.queryKey[1] as { taskId?: string } | undefined)?.taskId === taskId });
      }, 2000));
    const off = window.crewyard.on("runs.event", (p) => {
      const e = p as TasksTopics["runs.event"];
      // Edits, diffs and messages can change files or name new ones; usage ticks cannot.
      if (e.taskId === taskId && (e.event.type === "tool.update" || e.event.type === "diff.update" || e.event.type === "run.ended" || e.event.type === "tool.call")) later();
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [qc, taskId]);
}

export function FilesTab({ detail }: { detail: TaskDetail }) {
  const { t } = useTranslation("files");
  if (!detail.worktree) {
    return (
      <div className="ins-sec">
        <p className="muted ins-empty">{t("noWorktree")}</p>
      </div>
    );
  }
  return <Files key={detail.id} taskId={detail.id} />;
}

function Files({ taskId }: { taskId: string }) {
  const { t } = useTranslation("files");
  const [open, setOpen] = useState<Set<string>>(() => new Set(SHOT?.get("files") === "open" ? ["src", "src/auth"] : []));
  const [preview, setPreview] = useState<string | null>(() => SHOT?.get("file") ?? null);
  const [focused, setFocused] = useState<string | null>(null);
  useLiveFiles(taskId);

  const mentions = useQuery({ queryKey: ["worktrees.mentions", { taskId }], queryFn: () => read("worktrees.mentions", { taskId }) as Promise<FileMention[]> });
  const folders = ["", ...open];
  const listQueries = useQueries({
    queries: folders.map((path) => ({ queryKey: ["worktrees.listDir", { taskId, path }], queryFn: () => read("worktrees.listDir", { taskId, path }) as Promise<FolderListing>, retry: false })),
  });
  const listings = new Map<string, FolderListing>();
  const failed = new Set<string>();
  listQueries.forEach((q, i) => {
    if (q.data) listings.set(folders[i]!, q.data);
    else if (q.isError) failed.add(folders[i]!);
  });
  const rows = flatten(listings, open);
  const rootError = listQueries[0]?.error;

  const toggle = (path: string) =>
    setOpen((s) => {
      const next = new Set(s);
      // Closing a folder closes the folders inside it too, so reopening it starts tidy.
      if (next.has(path)) {
        for (const p of [...next]) if (p === path || p.startsWith(`${path}/`)) next.delete(p);
      } else next.add(path);
      return next;
    });
  /** Previews a file and opens its folders, so the tree shows where it lives. */
  const show = (path: string) => {
    setPreview(path);
    setFocused(path);
    setOpen((s) => {
      const next = new Set(s);
      for (let p = parentOf(path); p; p = parentOf(p)) next.add(p);
      return next;
    });
  };

  return (
    <>
      <div className="ins-sec">
        <Label>{t("mentioned")}</Label>
        {mentions.data && mentions.data.length > 0 ? (
          <ul className="fl-mentions">
            {mentions.data.map((m) => (
              <li key={m.path}>
                <Mention m={m} current={m.path === preview} onOpen={() => show(m.path)} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted ins-small">{mentions.isError ? t(`error.${codeOf(mentions.error)}`, { defaultValue: t("error.other") }) : mentions.isPending ? t("loading") : t("noMentions")}</p>
        )}
      </div>
      <div className="ins-sec">
        <Label>{t("tree")}</Label>
        {rootError ? (
          <p className="muted ins-small">{t(`error.${codeOf(rootError)}`, { defaultValue: t("error.other") })}</p>
        ) : !listings.has("") ? (
          <p className="muted ins-small">{t("loading")}</p>
        ) : rows.length === 0 ? (
          <p className="muted ins-small">{t("empty")}</p>
        ) : (
          <Tree rows={rows} failed={failed} focused={focused} preview={preview} setFocused={setFocused} toggle={toggle} open={show} />
        )}
      </div>
      {preview && <Preview key={preview} taskId={taskId} path={preview} onClose={() => setPreview(null)} />}
    </>
  );
}

function Mention({ m, current, onOpen }: { m: FileMention; current: boolean; onOpen: () => void }) {
  const { t } = useTranslation("files");
  const f = useFormat();
  const slash = m.path.lastIndexOf("/");
  return (
    <button type="button" className="fl-mention" aria-current={current ? "true" : undefined} onClick={onOpen} title={t("mentionTitle", { count: m.count, time: f.when.ago(m.at) })}>
      <FileText {...ICON} />
      <span className="fl-name">{m.path.slice(slash + 1)}</span>
      <span className="fl-dir mono muted">{slash > 0 ? m.path.slice(0, slash) : ""}</span>
      <span className="num muted">{t("mentionCount", { count: m.count })}</span>
    </button>
  );
}

function Tree({ rows, failed, focused, preview, setFocused, toggle, open }: { rows: Row[]; failed: ReadonlySet<string>; focused: string | null; preview: string | null; setFocused: (p: string) => void; toggle: (p: string) => void; open: (p: string) => void }) {
  const { t, i18n } = useTranslation("files");
  const refs = useRef(new Map<string, HTMLLIElement>());
  const items = rows.filter((r) => r.more === undefined);
  // One tab stop for the whole tree: the focused row, or the first one.
  const stop = items.some((r) => r.path === focused) ? focused : (items[0]?.path ?? null);
  const moved = useRef(false);
  useEffect(() => {
    if (!moved.current || !stop) return;
    moved.current = false;
    refs.current.get(stop)?.focus();
  }, [stop]);

  const onKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const action = treeKey(rows, stop, e.key);
    if (!action) return;
    e.preventDefault();
    if ("focus" in action) {
      moved.current = true;
      setFocused(action.focus);
      refs.current.get(action.focus)?.focus();
    } else if ("toggle" in action) toggle(action.toggle);
    else open(action.preview);
  };

  return (
    <ul className="fl-tree" role="tree" aria-label={t("tree")} onKeyDown={onKey}>
      {rows.map((r) => {
        if (r.more !== undefined) {
          return (
            <li key={r.path} role="none" className="fl-more muted" style={{ "--depth": r.depth } as CSSProperties}>
              {t("more", { count: r.more })}
            </li>
          );
        }
        const folder = r.kind === "folder";
        const Icon = r.kind === "link" ? Link2 : folder ? (r.open ? FolderOpen : Folder) : /\.(png|jpe?g|gif|webp|svg)$/i.test(r.name) ? ImageIcon : File;
        return (
          <li
            key={r.path}
            ref={(el) => {
              if (el) refs.current.set(r.path, el);
              else refs.current.delete(r.path);
            }}
            role="treeitem"
            aria-level={r.depth + 1}
            aria-expanded={folder ? r.open || r.loading : undefined}
            aria-selected={r.path === preview}
            aria-disabled={r.kind === "link" ? true : undefined}
            tabIndex={r.path === stop ? 0 : -1}
            className={`fl-row${r.ignored ? " ignored" : ""}${r.kind === "link" ? " link" : ""}`}
            style={{ "--depth": r.depth } as CSSProperties}
            title={r.kind === "link" ? t("linkNote") : r.ignored ? t("ignoredNote") : undefined}
            onFocus={() => setFocused(r.path)}
            onClick={() => {
              setFocused(r.path);
              if (folder) toggle(r.path);
              else if (r.kind === "file") open(r.path);
            }}
          >
            <span className="fl-chev" aria-hidden="true">
              {folder ? r.open || r.loading ? <ChevronDown {...ICON} /> : <ChevronRight {...ICON} /> : null}
            </span>
            <Icon {...ICON} />
            <span className="fl-name">{r.name}</span>
            {r.ignored && <span className="fl-tag">{t("ignored")}</span>}
            {r.kind === "link" && <span className="fl-tag">{t("link")}</span>}
            {r.loading && <span className="muted ins-small">{failed.has(r.path) ? t("error.other") : t("loading")}</span>}
            {r.bytes !== null && <span className="fl-size num muted">{bytes(r.bytes, i18n.language)}</span>}
          </li>
        );
      })}
    </ul>
  );
}

function Preview({ taskId, path, onClose }: { taskId: string; path: string; onClose: () => void }) {
  const { t, i18n } = useTranslation("files");
  const [wrap, setWrap] = useState(false);
  const [source, setSource] = useState(false);
  const q = useQuery({ queryKey: ["worktrees.readFile", { taskId, path }], queryFn: () => read("worktrees.readFile", { taskId, path }) as Promise<FilePreview>, retry: false });
  const section = useRef<HTMLElement>(null);
  // The preview sits under the tree; bring it into view once it has content, without moving focus.
  useEffect(() => {
    if (!q.isFetched) return;
    // After layout settles (the tree above may still be filling in); screenshots show the preview whole.
    const id = setTimeout(() => section.current?.scrollIntoView({ block: SHOT ? "start" : "nearest" }), SHOT ? 600 : 0);
    return () => clearTimeout(id);
  }, [q.isFetched]);
  const p = q.data;
  const md = isMarkdown(path) && p?.kind === "text";
  const showsText = p?.kind === "text" && (!md || source);
  return (
    <section ref={section} className="ins-sec fl-preview" aria-label={t("previewOf", { path })}>
      <div className="fl-head">
        <span className="mono fl-path as-typed">{path}</span>
        <button type="button" className="fl-icon" onClick={onClose} aria-label={t("closePreview")} title={t("closePreview")}>
          <X size={14} strokeWidth={1.75} />
        </button>
      </div>
      {p && (
        <div className="fl-bar">
          <span className="num muted ins-small">{bytes(p.bytes, i18n.language)}</span>
          {p.kind === "text" && p.truncated && <span className="fl-chip">{t("truncated", { size: bytes(p.bytes, i18n.language) })}</span>}
          <span className="fl-spacer" />
          {md && (
            <button type="button" className="fl-toggle" aria-pressed={source} onClick={() => setSource((s) => !s)}>
              {t("source")}
            </button>
          )}
          {showsText && (
            <button type="button" className="fl-toggle" aria-pressed={wrap} onClick={() => setWrap((w) => !w)}>
              {t("wrap")}
            </button>
          )}
        </div>
      )}
      {q.isPending && <p className="muted ins-small">{t("loading")}</p>}
      {q.isError && <p className="muted ins-small">{t(`error.${codeOf(q.error)}`, { defaultValue: t("error.other") })}</p>}
      {p?.kind === "binary" && <p className="muted ins-small">{p.reason === "too_large" ? t("imageTooLarge", { size: bytes(p.bytes, i18n.language) }) : t("binary", { size: bytes(p.bytes, i18n.language) })}</p>}
      {p?.kind === "image" && (
        <div className="fl-image">
          <img src={`data:${p.mime};base64,${p.base64}`} alt={path} />
        </div>
      )}
      {p?.kind === "text" && (showsText ? <Code text={p.text} wrap={wrap} label={t("contentOf", { path })} /> : <Markdown text={p.text} label={t("contentOf", { path })} />)}
    </section>
  );
}

function Code({ text, wrap, label }: { text: string; wrap: boolean; label: string }) {
  const lines = useMemo(() => text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n"), [text]);
  const width = `${String(lines.length).length}ch`;
  return (
    <div className={`fl-code${wrap ? " wrap" : ""}`} tabIndex={0} role="region" aria-label={label} style={{ "--ln": width } as CSSProperties}>
      {lines.map((l, i) => (
        <div className="fl-line" key={i}>
          <span className="fl-ln" aria-hidden="true">
            {i + 1}
          </span>
          <span className="fl-lc">{l || " "}</span>
        </div>
      ))}
    </div>
  );
}

function Markdown({ text, label }: { text: string; label: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className="fl-md" tabIndex={0} role="region" aria-label={label}>
      {blocks.map((b, i) => (
        <MdBlock key={i} b={b} />
      ))}
    </div>
  );
}

function MdBlock({ b }: { b: Block }): ReactNode {
  switch (b.t) {
    case "heading": {
      const H = `h${Math.min(6, b.level + 2)}` as "h3";
      return (
        <H className={`fl-h fl-h${b.level}`}>
          <MdInline c={b.c} />
        </H>
      );
    }
    case "para":
      return (
        <p>
          <MdInline c={b.c} />
        </p>
      );
    case "code":
    case "table":
      return <pre className="fl-pre">{b.v}</pre>;
    case "quote":
      return (
        <blockquote>
          {b.c.map((x, i) => (
            <MdBlock key={i} b={x} />
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
                <MdBlock key={j} b={x} />
              ))}
            </li>
          ))}
        </L>
      );
    }
  }
}

function MdInline({ c }: { c: Inline[] }) {
  const { t } = useTranslation("files");
  return (
    <>
      {c.map((x, i) => {
        switch (x.t) {
          case "text":
            return <Fragment key={i}>{x.v}</Fragment>;
          case "code":
            return <code key={i}>{x.v}</code>;
          case "em":
            return (
              <em key={i}>
                <MdInline c={x.c} />
              </em>
            );
          case "strong":
            return (
              <strong key={i}>
                <MdInline c={x.c} />
              </strong>
            );
          // A link is shown with its target and never followed from here.
          case "link":
            return (
              <span key={i} className="fl-link" title={x.href}>
                <MdInline c={x.c} />
                {x.href && <span className="fl-href mono">{` ${x.href}`}</span>}
              </span>
            );
          // Images are named, never fetched: a remote one would tell its server the file was opened.
          case "image":
            return (
              <span key={i} className="fl-img-ref" title={x.src}>
                {t("imageRef", { alt: x.alt || x.src })}
              </span>
            );
        }
      })}
    </>
  );
}
