import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Folder, FolderOpen, House, ListTodo, Plus, Search, SquarePen } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TaskStatus } from "@crewyard/core";
import { useDaemon } from "../../ipc.ts";
import { useNav } from "../../nav.ts";
import { projectScreens } from "../../registry.ts";
import { openSetup } from "../../screens/setup/draft.ts";
import { useWork } from "../../screens/tasks/data.ts";
import { goInProject, openFolder, openProjectById, openTask, startNewTask } from "./actions.ts";
import { moveActive, rankCommands, type Command } from "./search.ts";

// Ctrl K command search (DESIGN.md §7): go to a screen, open a project, open a task by title or
// start a new task. A combobox over a listbox: focus stays in the field, arrows move the active
// option, Enter runs it, Esc closes and gives focus back to whatever had it before.

interface Entry extends Command {
  icon: ReactNode;
  meta?: string;
  run(): void | Promise<void>;
}

/** Task status words already live in the tasks namespace; two states use a longer key there. */
const STATUS_KEY: Partial<Record<TaskStatus, string>> = { needs_input: "needsAnswer", handing_off: "handingOff" };

const ico = (Icon: typeof Folder) => <Icon size={16} strokeWidth={1.75} aria-hidden="true" />;

function useEntries(): Entry[] {
  const { t } = useTranslation(["titlebar", "tasks", "setup"]);
  const qc = useQueryClient();
  const { projectId, closeProject } = useNav();
  const projects = useDaemon("projects.list", undefined).data ?? [];
  const tasks = useWork("tasks.list", {}).data ?? [];
  // Project screens and New task need a project: the open one, else the most recently opened.
  const target = projectId ?? projects[0]?.id ?? null;
  const targetName = projects.find((p) => p.id === target)?.name;
  const nameOf = new Map(projects.map((p) => [p.id, p.name]));

  const entries: Entry[] = [{ id: "screen:start", group: "screen", title: t("search.start"), icon: ico(House), run: closeProject }];
  if (target) {
    for (const s of projectScreens) {
      if (!s.navKey) continue;
      const Icon = s.icon;
      entries.push({ id: `screen:${s.id}`, group: "screen", title: t(s.navKey), meta: projectId ? undefined : targetName, icon: Icon ? ico(Icon) : null, run: () => goInProject(qc, target, s.id) });
    }
    entries.push({ id: "action:new-task", group: "action", title: t("search.newTask"), meta: targetName, icon: ico(SquarePen), run: () => startNewTask(qc, target) });
  }
  entries.push(
    { id: "action:new-project", group: "action", title: t("setup:newProject"), icon: ico(Plus), run: () => openSetup("local") },
    { id: "action:open-folder", group: "action", title: t("search.openFolder"), icon: ico(FolderOpen), run: () => openFolder(qc) },
  );
  for (const p of projects) {
    entries.push({ id: `project:${p.id}`, group: "project", title: p.name, keywords: p.path, meta: p.path, recency: p.lastOpenedAt, icon: ico(Folder), run: () => openProjectById(qc, p.id) });
  }
  for (const task of tasks) {
    const project = nameOf.get(task.projectId) ?? "";
    entries.push({
      id: `task:${task.id}`,
      group: "task",
      title: task.title,
      keywords: project,
      meta: [project, t(`tasks:status.${STATUS_KEY[task.status] ?? task.status}`)].filter(Boolean).join(" · "),
      recency: task.createdAt,
      icon: ico(ListTodo),
      run: () => openTask(qc, task.projectId, task.id),
    });
  }
  return entries;
}

export function CommandSearch({ open, initialQuery = "", onOpen, onClose }: { open: boolean; initialQuery?: string; onOpen(): void; onClose(): void }) {
  const { t } = useTranslation("titlebar");
  return (
    <>
      <button className="tb-search" onClick={onOpen} aria-haspopup="dialog" aria-expanded={open} aria-keyshortcuts="Control+K">
        <Search size={15} strokeWidth={1.75} aria-hidden="true" />
        <span className="tb-search-t">{t("search.trigger")}</span>
        <span className="kbd" aria-hidden="true">
          Ctrl K
        </span>
      </button>
      {open && <Palette initialQuery={initialQuery} onClose={onClose} />}
    </>
  );
}

function Palette({ initialQuery, onClose }: { initialQuery: string; onClose(): void }) {
  const { t, i18n } = useTranslation("titlebar");
  const entries = useEntries();
  const [query, setQuery] = useState(initialQuery);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  const uid = useId();
  const listId = `${uid}-list`;
  const results = useMemo(() => rankCommands(entries, query, 30, i18n.language) as Entry[], [entries, query, i18n.language]);
  const current = results[Math.min(active, results.length - 1)];

  useEffect(() => {
    opener.current = document.activeElement;
    input.current?.focus();
    input.current?.select();
  }, []);

  useEffect(() => {
    if (current) list.current?.querySelector(`#${CSS.escape(`${uid}-${current.id}`)}`)?.scrollIntoView({ block: "nearest" });
  }, [current, uid]);

  const close = (refocus = true) => {
    onClose();
    if (refocus && opener.current instanceof HTMLElement) opener.current.focus();
  };

  const run = (e: Entry) => {
    // Running moves focus to the target screen, so the opener does not get it back.
    close(false);
    void e.run();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      return close();
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (current) run(current);
      return;
    }
    if (e.key === "Tab") {
      // The field is the only stop in the dialog; Tab must not leave it behind the overlay.
      e.preventDefault();
      return;
    }
    const next = moveActive(active, results.length, e.key);
    if (next !== active && ["ArrowDown", "ArrowUp", "PageDown", "PageUp"].includes(e.key)) {
      e.preventDefault();
      setActive(next);
    }
    // Home and End keep moving the caret in the field unless Ctrl is held.
    if ((e.key === "Home" || e.key === "End") && e.ctrlKey) {
      e.preventDefault();
      setActive(next);
    }
  };

  return (
    <div className="tb-layer" onPointerDown={(e) => e.target === e.currentTarget && close(false)}>
      <div className="tb-palette" role="dialog" aria-modal="true" aria-label={t("search.label")}>
        <div className="tb-palette-field">
          <Search size={16} strokeWidth={1.75} aria-hidden="true" />
          <input
            ref={input}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={current ? `${uid}-${current.id}` : undefined}
            aria-label={t("search.label")}
            placeholder={t("search.placeholder")}
            value={query}
            spellCheck={false}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
          <span className="kbd" aria-hidden="true">
            Esc
          </span>
        </div>
        <div ref={list} className="tb-palette-list" role="listbox" id={listId} aria-label={t("search.results")}>
          {results.map((e, i) => (
            <div
              key={e.id}
              id={`${uid}-${e.id}`}
              role="option"
              aria-selected={e === current}
              className="tb-option"
              onPointerMove={() => i !== active && setActive(i)}
              onClick={() => run(e)}
            >
              <span className="tb-option-icon">{e.icon}</span>
              <span className="tb-option-text">
                <span className="tb-option-title">{e.title}</span>
                {e.meta && <span className="tb-option-meta">{e.meta}</span>}
              </span>
              <span className="lbl">{t(`search.group.${e.group}`)}</span>
            </div>
          ))}
          {results.length === 0 && <div className="tb-empty muted">{t("search.none", { query: query.trim() })}</div>}
        </div>
        <div className="tb-palette-foot lbl" aria-hidden="true">
          <span>
            <span className="kbd">↑</span> <span className="kbd">↓</span> {t("search.hintMove")}
          </span>
          <span>
            <span className="kbd">Enter</span> {t("search.hintOpen")}
          </span>
          <span>
            <span className="kbd">Esc</span> {t("search.hintClose")}
          </span>
        </div>
      </div>
    </div>
  );
}
