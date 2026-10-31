import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeftRight, Bell, CircleHelp, Gauge, Terminal, Wallet } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { LimitNoticePayload, RequestView } from "@crewyard/core";
import { useDaemon } from "../../ipc.ts";
import { useNav } from "../../nav.ts";
import { titleKey } from "../../screens/inbox/model.ts";
import { RiskBadge } from "../../screens/inbox/RiskBadge.tsx";
import { ProvBadge } from "../../screens/providers/shared.tsx";
import { useWork } from "../../screens/tasks/data.ts";
import { useActivity } from "../../screens/tasks/live.ts";
import { useFormat, useNow } from "../../screens/tasks/parts.tsx";
import { focusMain, openNotice, openRequest } from "./actions.ts";
import { moveActive } from "./search.ts";
import { badgeCount, openRequests, recentNotices } from "./notices.ts";

// The bell in the title bar (DESIGN.md §5): open requests from every project, then the recent
// limit notices. Each item opens its Inbox item or its Limits screen; answering stays in the Inbox.

function RequestIcon({ r }: { r: RequestView }) {
  const p = r.payload;
  const Icon = p.kind === "approval" ? Terminal : p.kind === "question" ? CircleHelp : p.trigger === "budget" ? Wallet : p.trigger === "manual" ? ArrowLeftRight : Gauge;
  // The same tones as the Inbox risk chips: high in bad, medium in warn. The icon is decoration; the item's chip
  // says the level in words.
  return <Icon size={16} strokeWidth={1.75} aria-hidden="true" className={r.risk === "high" ? "tb-n-bad" : r.risk === "medium" ? "tb-n-high" : "tb-n-icon"} />;
}

function useRequestTitle() {
  const { t } = useTranslation("inbox");
  const f = useFormat();
  return (r: RequestView) => {
    const p = r.payload;
    if (p.kind === "question") return p.questions[0]?.prompt ?? t("title.question");
    if (p.kind === "approval") return t(`title.${titleKey(p)}`, { command: p.command ?? "", count: p.paths.length });
    return t(`title.${titleKey(p)}`, { window: f.window(p.window), usd: p.cap ? f.usd(p.cap.capUsd) : "" });
  };
}

export function Notifications({ open, onOpen, onClose }: { open: boolean; onOpen(): void; onClose(): void }) {
  const { t } = useTranslation("titlebar");
  const now = useNow(60_000);
  const requests = useWork("requests.list", {});
  const notices = useActivity((s) => s.notices);
  const [seenAt, setSeenAt] = useState<string | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  const reqs = openRequests(requests.data ?? []);
  const recent = recentNotices(notices, now);
  const count = badgeCount(reqs, recent, seenAt);

  const show = () => {
    if (wasOpen.current) {
      wasOpen.current = false;
      return;
    }
    setSeenAt(new Date().toISOString());
    onOpen();
  };

  return (
    <>
      <button
        ref={button}
        className="tb-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={count > 0 ? t("notifications.labelCount", { count }) : t("notifications.label")}
        title={t("notifications.label")}
        onPointerDown={() => (wasOpen.current = open)}
        onClick={show}
      >
        <Bell size={16} strokeWidth={1.75} aria-hidden="true" />
        {count > 0 && (
          <span className="tb-count" aria-hidden="true">
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>
      {open && <Popover anchor={button} requests={reqs} notices={recent} error={requests.isError} onClose={onClose} />}
    </>
  );
}

function Popover({ anchor, requests, notices, error, onClose }: { anchor: RefObject<HTMLButtonElement | null>; requests: RequestView[]; notices: LimitNoticePayload[]; error: boolean; onClose(): void }) {
  const { t } = useTranslation("titlebar");
  const f = useFormat();
  const qc = useQueryClient();
  const title = useRequestTitle();
  const ref = useRef<HTMLDivElement>(null);
  const projects = useDaemon("projects.list", undefined).data ?? [];
  const profiles = useDaemon("providers.profiles", undefined, { staleTime: 60_000 }).data ?? [];
  const tasks = useWork("tasks.list", {}).data ?? [];
  const projectOfTask = (id: string) => tasks.find((x) => x.id === id)?.projectId ?? null;
  const taskTitle = (id: string | null) => (id ? tasks.find((x) => x.id === id)?.title : undefined);
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name;
  const who = (profileId: string) => {
    const p = profiles.find((x) => x.id === profileId);
    return p ? `${f.runner(p.runner)} · ${p.alias}` : profileId;
  };
  const current = useNav((s) => s.projectId);

  useLayoutEffect(() => {
    const a = anchor.current?.getBoundingClientRect();
    const el = ref.current;
    if (!a || !el) return;
    el.style.top = `${a.bottom + 4}px`;
    el.style.right = `${Math.max(8, window.innerWidth - a.right)}px`;
  }, [anchor]);

  // Focus lands on the first item, so the arrow keys work straight away.
  useEffect(() => {
    (ref.current?.querySelector<HTMLElement>(".tb-n-item") ?? ref.current)?.focus();
  }, []);

  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node) && !anchor.current?.contains(e.target as Node)) onClose();
    };
    // No close on window blur: clicking a Windows toast or another app and coming back should find
    // the list where it was.
    document.addEventListener("pointerdown", down, true);
    return () => document.removeEventListener("pointerdown", down, true);
  }, [anchor, onClose]);

  const closeAndRefocus = () => {
    onClose();
    anchor.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      return closeAndRefocus();
    }
    const items = [...(ref.current?.querySelectorAll<HTMLElement>(".tb-n-item") ?? [])];
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) || items.length === 0) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    items[moveActive(at, items.length, e.key)]?.focus();
  };

  const go = (fn: () => Promise<void>) => {
    onClose();
    void fn().then(focusMain);
  };

  const empty = requests.length === 0 && notices.length === 0;
  return (
    <div ref={ref} className="tb-pop" role="dialog" aria-label={t("notifications.label")} tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="tb-pop-head">
        <span className="lbl strong">{t("notifications.title")}</span>
        <span className="lbl end">{t("notifications.context", { open: requests.length, notices: notices.length })}</span>
      </div>
      <div className="tb-pop-body">
      {error && <p className="tb-empty muted">{t("notifications.error")}</p>}
      {empty && !error && <p className="tb-empty muted">{t("notifications.empty")}</p>}
      {requests.length > 0 && (
        <section aria-label={t("notifications.requests")}>
          <div className="tb-pop-sub lbl">{t("notifications.requests")}</div>
          {requests.map((r) => (
            <button key={r.id} type="button" className="tb-n-item" onClick={() => go(() => openRequest(qc, r))}>
              <RequestIcon r={r} />
              <span className="tb-n-text">
                <span className={`t${r.payload.kind === "approval" && r.payload.command ? " mono" : ""}`}>{title(r)}</span>
                <span className="s">
                  {/* Medium and high say their level in words, so the icon's colour is never the only sign (DESIGN.md §8). */}
                  {(r.risk === "medium" || r.risk === "high") && <RiskBadge risk={r.risk} />}
                  {[taskTitle(r.taskId), r.projectId !== current ? projectName(r.projectId) : null].filter(Boolean).join(" · ")}
                </span>
              </span>
              <span className="k">{f.when.ago(r.createdAt)}</span>
            </button>
          ))}
        </section>
      )}
      {notices.length > 0 && (
        <section aria-label={t("notifications.limits")}>
          <div className="tb-pop-sub lbl">{t("notifications.limits")}</div>
          {notices.map((n) => (
            <button key={`${n.profileId}|${n.window}`} type="button" className="tb-n-item" onClick={() => go(() => openNotice(qc, n, projectOfTask, projects))}>
              <Gauge size={16} strokeWidth={1.75} aria-hidden="true" className={n.kind === "reached" || n.kind === "critical" ? "tb-n-bad" : "tb-n-high"} />
              <span className="tb-n-text">
                <span className="t">{t(`notifications.notice.${n.kind}`, { who: who(n.profileId), window: f.window(n.window), pct: n.usedPct === null ? "—" : Math.round(n.usedPct), minutes: n.minutesUntilFull ?? 0 })}</span>
                <span className="s">
                  {n.resetsAt ? t("notifications.resets", { time: f.when.at(n.resetsAt) }) : t("notifications.noReset")} · <ProvBadge value={n.provenance} />
                </span>
              </span>
              <span className="k">{f.when.ago(n.observedAt)}</span>
            </button>
          ))}
        </section>
      )}
      </div>
    </div>
  );
}
