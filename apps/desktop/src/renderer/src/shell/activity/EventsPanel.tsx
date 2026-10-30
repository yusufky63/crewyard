import { useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { ActivityEvent } from "@crewyard/core";
import { Button } from "@crewyard/ui";
import { call, useDaemon } from "../../ipc.ts";
import { useFormat } from "../../screens/tasks/parts.tsx";
import {
  batcher,
  concerns,
  cursorOf,
  eventParams,
  FIRST_PAGE,
  isFiltered,
  isNewest,
  kindOptions,
  LIVE_TOPICS,
  liveHint,
  newer,
  NO_FILTER,
  older,
  pageNumber,
  rowText,
  runsFor,
  withRun,
  withTask,
  type EventFilter,
  type Paging,
} from "./model.ts";

// The project's change feed (DESIGN.md §4): newest first, filtered by task, run and kind, in pages
// of ACTIVITY_PAGE. Payloads are agent and tool text, so they are only ever shown as text, cut on
// the row, with the stored payload one click away. Live updates refresh the newest page at most
// once a second; on an older page they only count, so what you are reading never moves.

const time = (iso: string, lang: string) => new Intl.DateTimeFormat(lang, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(iso));

function EventRow({ e, projectId, task, run }: { e: ActivityEvent; projectId: string; task: string | null; run: string | null }) {
  const { t, i18n } = useTranslation("activity");
  const [full, setFull] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const row = rowText(e);
  const show = () => {
    setState("loading");
    call("activity.event", { projectId, seq: e.seq }).then(
      (r) => {
        setFull(r.text);
        setState("idle");
      },
      () => setState("error"),
    );
  };
  return (
    <li className="ev-row">
      <div className="ev-line">
        <time className="ev-time" dateTime={e.at} title={new Date(e.at).toLocaleString(i18n.language)}>
          {time(e.at, i18n.language)}
        </time>
        <span className="ev-kind" title={t("events.source", { source: e.source })}>
          {e.kind}
        </span>
        {(task || run) && (
          <span className="ev-who" title={task ?? undefined}>
            {[task, run].filter(Boolean).join(" · ")}
          </span>
        )}
        {/* Untrusted text: a plain text node, never markup or a link. */}
        <span className="ev-text">{row.text || <span className="muted">{t("events.noText")}</span>}</span>
        {row.more && full == null && (
          <Button variant="ghost" size="sm" className="ev-more" onClick={show} disabled={state === "loading"} aria-label={t("events.showAllLabel", { kind: e.kind })}>
            {state === "loading" ? t("events.loading") : t("events.showAll", { size: e.size.toLocaleString(i18n.language) })}
          </Button>
        )}
        {full != null && (
          <Button variant="ghost" size="sm" className="ev-more" onClick={() => setFull(null)} aria-expanded="true">
            {t("events.showLess")}
          </Button>
        )}
      </div>
      {state === "error" && <p className="ev-err">{t("events.loadFailed")}</p>}
      {full != null && (
        <pre className="ev-full" tabIndex={0} aria-label={t("events.fullLabel", { kind: e.kind })}>
          {full}
        </pre>
      )}
    </li>
  );
}

export function EventsPanel({ projectId }: { projectId: string }) {
  const { t } = useTranslation("activity");
  const f = useFormat();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<EventFilter>(NO_FILTER);
  const [paging, setPaging] = useState<Paging>(FIRST_PAGE);
  const [fresh, setFresh] = useState(0);
  const params = eventParams(projectId, filter, cursorOf(paging));
  const page = useDaemon("activity.events", params, { placeholderData: keepPreviousData });
  const facets = useDaemon("activity.facets", { projectId });
  const tasks = useDaemon("tasks.list", { projectId });

  const titles = useMemo(() => new Map((tasks.data ?? []).map((x) => [x.id, x.title])), [tasks.data]);
  const runs = useMemo(() => facets.data?.runs ?? [], [facets.data]);
  const runLabel = (id: string | null) => {
    const r = id ? runs.find((x) => x.runId === id) : undefined;
    return r ? `${f.role(r.role)} · ${f.runner(r.runner)}` : null;
  };

  // A filter change starts again at the newest page.
  const apply = (next: EventFilter) => {
    setFilter(next);
    setPaging(FIRST_PAGE);
    setFresh(0);
  };

  // Live: count what concerns this filter and flush once a second. Held in refs so a busy run never
  // re-subscribes or re-renders per event.
  const live = useRef({ filter, newest: isNewest(paging), titles });
  useEffect(() => {
    live.current = { filter, newest: isNewest(paging), titles };
  }, [filter, paging, titles]);
  useEffect(() => {
    const b = batcher((n) => {
      if (live.current.newest) {
        void qc.invalidateQueries({ queryKey: ["activity.events"] });
        void qc.invalidateQueries({ queryKey: ["activity.facets", { projectId }] });
      } else setFresh((c) => c + n);
    });
    const taskProject = (id: string) => (live.current.titles.has(id) ? projectId : undefined);
    const offs = LIVE_TOPICS.map((topic) =>
      window.crewyard.on(topic, (p) => {
        if (concerns(liveHint(topic, p), projectId, live.current.filter, taskProject)) b.push();
      }),
    );
    return () => {
      b.cancel();
      offs.forEach((off) => off());
    };
  }, [qc, projectId]);

  const kinds = kindOptions(facets.data?.kinds ?? [], filter.stream);
  const events = page.data?.events ?? [];
  const newest = isNewest(paging);

  return (
    <div className="ev">
      <div className="drawer-tools" role="group" aria-label={t("events.filters")}>
        <label className="drawer-field">
          <span className="lbl" aria-hidden="true">{t("events.task")}</span>
          <select aria-label={t("events.task")} className="drawer-select" value={filter.taskId ?? ""} onChange={(e) => apply(withTask(filter, e.target.value || null, runs))}>
            <option value="">{t("events.allTasks")}</option>
            {(tasks.data ?? []).map((x) => (
              <option key={x.id} value={x.id}>
                {x.title}
              </option>
            ))}
          </select>
        </label>
        <label className="drawer-field">
          <span className="lbl" aria-hidden="true">{t("events.run")}</span>
          <select aria-label={t("events.run")} className="drawer-select" value={filter.runId ?? ""} onChange={(e) => apply(withRun(filter, e.target.value || null, runs))}>
            <option value="">{t("events.allRuns")}</option>
            {runsFor(runs, filter.taskId).map((r) => (
              <option key={r.runId} value={r.runId}>
                {t("events.runOption", { role: f.role(r.role), runner: f.runner(r.runner), at: f.when.at(r.startedAt) })}
              </option>
            ))}
          </select>
        </label>
        <label className="drawer-field">
          <span className="lbl" aria-hidden="true">{t("events.kind")}</span>
          <select aria-label={t("events.kind")} className="drawer-select mono" value={filter.kind ?? ""} onChange={(e) => apply({ ...filter, kind: e.target.value || null })}>
            <option value="">{t("events.allKinds")}</option>
            {kinds.map((k) => (
              <option key={k.value} value={k.value}>
                {k.family ? t("events.family", { family: k.value, count: k.count }) : t("events.kindOption", { kind: k.value, count: k.count })}
              </option>
            ))}
          </select>
        </label>
        <label className="drawer-check">
          <input type="checkbox" checked={filter.stream} onChange={(e) => apply({ ...filter, stream: e.target.checked })} />
          <span>{t("events.stream")}</span>
        </label>
        {isFiltered(filter) && (
          <Button variant="ghost" size="sm" onClick={() => apply(NO_FILTER)}>
            {t("events.clear")}
          </Button>
        )}
        <div className="drawer-pager">
          {fresh > 0 && !newest && (
            <Button
              size="sm"
              onClick={() => {
                setPaging(FIRST_PAGE);
                setFresh(0);
              }}
            >
              {t("events.newest", { count: fresh })}
            </Button>
          )}
          <Button variant="ghost" size="sm" disabled={newest} onClick={() => setPaging(newer(paging))}>
            {t("events.newer")}
          </Button>
          <span className="drawer-page mono">{t("events.page", { n: pageNumber(paging) })}</span>
          <Button variant="ghost" size="sm" disabled={page.data?.older == null} onClick={() => setPaging(older(paging, page.data?.older ?? null))}>
            {t("events.older")}
          </Button>
        </div>
      </div>
      {/* One polite announcement when new events wait above an older page, not one per event. */}
      <p className="drawer-sr" aria-live="polite">
        {fresh > 0 && !newest ? t("events.newWaiting") : ""}
      </p>
      {page.isError ? (
        <p className="drawer-empty">{t("events.error")}</p>
      ) : page.isPending ? (
        <p className="drawer-empty muted">{t("loading")}</p>
      ) : events.length === 0 ? (
        <p className="drawer-empty muted">{isFiltered(filter) ? t("events.noneFiltered") : t("events.none")}</p>
      ) : (
        <ol className="ev-list" aria-label={t("events.listLabel")}>
          {events.map((e) => (
            <EventRow key={e.seq} e={e} projectId={projectId} task={e.taskId ? (titles.get(e.taskId) ?? null) : null} run={runLabel(e.runId)} />
          ))}
        </ol>
      )}
    </div>
  );
}
