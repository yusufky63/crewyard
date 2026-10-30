import { useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, ChevronDown, CircleHelp, Copy, FolderTree, ListChecks, Minus, RefreshCw, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { DefenderCheck, MachineEnv, ToolCopy, ToolId, VersionGate } from "@crewyard/core";
import { BrandIcon, Button, Panel } from "@crewyard/ui";
import { useDaemon } from "../../ipc.ts";
import { usePrefs } from "../../prefs.ts";
import { defenderItem, GH_LOGIN_COMMAND, LONG_PATHS_COMMAND, longPathsItem, summarize, TOOL_ORDER, toolItem, type MachineFix, type MachineItem, type MachineItemId, type MachineState } from "./machine.ts";

// This machine (DESIGN.md §6 Start): a strip of spec tiles near the top, one per check, each
// problem with its fix next to it; the full panel with the reasons and steps opens under it.

/** The strip's id; Getting started links here. */
export const MACHINE_PANEL_ID = "start-machine";
const DETAILS_ID = `${MACHINE_PANEL_ID}-details`;
const rowId = (id: MachineItemId) => `${MACHINE_PANEL_ID}-row-${id}`;

const MACHINE_STALE = 5 * 60_000;
// Brand glyphs are keyed by runner id (PLAN.md D9), not by the CLI's binary name.
const TOOL_BRAND: Record<ToolId, string> = { claude: "claude-code", codex: "codex", opencode: "opencode", gemini: "gemini-cli", git: "git", gh: "github" };

/** Every check in strip order. Each tool is queried on its own, so one slow CLI never holds up the rest. */
function useMachine() {
  const scanRoot = usePrefs((s) => s.scanRoot);
  const opts = { staleTime: MACHINE_STALE };
  const tools = {
    claude: useDaemon("machine.tool", { id: "claude" }, opts),
    codex: useDaemon("machine.tool", { id: "codex" }, opts),
    opencode: useDaemon("machine.tool", { id: "opencode" }, opts),
    gemini: useDaemon("machine.tool", { id: "gemini" }, opts),
    git: useDaemon("machine.tool", { id: "git" }, opts),
    gh: useDaemon("machine.tool", { id: "gh" }, opts),
  };
  const env = useDaemon("machine.env", undefined, opts);
  const defender = useDaemon("machine.defender", { scanRoot }, opts);
  const items: MachineItem[] = TOOL_ORDER.map((id) => toolItem(id, { data: tools[id].data, pending: tools[id].isFetching, error: tools[id].error }, env.data));
  const long = longPathsItem(env.data);
  if (long) items.push(long);
  const def = defenderItem(defender.data, defender.isFetching, defender.error);
  if (def) items.push(def);
  const errors: Partial<Record<MachineItemId, string>> = {};
  const gates: Partial<Record<MachineItemId, VersionGate>> = {};
  const copies: Partial<Record<MachineItemId, { inUse: string; version: string | null; others: ToolCopy[] }>> = {};
  for (const id of TOOL_ORDER) {
    const q = tools[id];
    if (q.error) errors[id] = String(q.error);
    if (q.data?.found && q.data.gate) gates[id] = q.data.gate;
    if (q.data?.found && q.data.path && q.data.others?.length) copies[id] = { inUse: q.data.path, version: q.data.version, others: q.data.others };
  }
  if (defender.error) errors.defender = defender.error.message;
  return { items, env, defender, errors, gates, copies };
}

function StateIcon({ state }: { state: MachineState }) {
  if (state === "pending") {
    return (
      <span className="st st-run">
        <span className="spin" />
      </span>
    );
  }
  const icon = { ok: <Check size={16} strokeWidth={1.75} aria-hidden="true" />, warn: <AlertTriangle size={16} strokeWidth={1.75} aria-hidden="true" />, unknown: <CircleHelp size={16} strokeWidth={1.75} aria-hidden="true" />, neutral: <Minus size={16} strokeWidth={1.75} aria-hidden="true" /> }[state];
  const cls = { ok: "st st-ok", warn: "st st-wait", unknown: "st st-wait", neutral: "st muted" }[state];
  return <span className={cls}>{icon}</span>;
}

function Glyph({ id }: { id: MachineItemId }) {
  if (id === "longPaths") return <FolderTree className="brand" size={16} strokeWidth={1.75} aria-hidden="true" />;
  if (id === "defender") return <ShieldCheck className="brand" size={16} strokeWidth={1.75} aria-hidden="true" />;
  return <BrandIcon id={TOOL_BRAND[id]} />;
}

function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = (text: string) => {
    void navigator.clipboard
      .writeText(text)
      .then(() => setCopied(text))
      .catch(() => setCopied(null));
  };
  return { copied, copy };
}

/** A command for the user to run themselves; the app never runs it. Copying is the only action. */
function Cmd({ text }: { text: string }) {
  const { t } = useTranslation("start");
  const { copied, copy } = useCopy();
  return (
    <div className="cmd">
      <code>{text}</code>
      <Button size="sm" variant="ghost" onClick={() => copy(text)} aria-label={t("machine.copyLabel", { command: text })}>
        <Copy size={14} strokeWidth={1.75} aria-hidden="true" />
        {copied ? t("machine.copied") : t("machine.copy")}
      </Button>
    </div>
  );
}

function FixButton({ fix, onSteps }: { fix: NonNullable<MachineFix>; onSteps(target: MachineItemId): void }) {
  const { t } = useTranslation("start");
  const { copied, copy } = useCopy();
  if (fix.kind === "steps") {
    return (
      <Button size="sm" variant="ghost" className="mtile-fix" onClick={() => onSteps(fix.target)} aria-controls={DETAILS_ID}>
        <ListChecks size={14} strokeWidth={1.75} aria-hidden="true" />
        {t("machine.fix.steps")}
      </Button>
    );
  }
  return (
    <Button size="sm" variant="ghost" className="mtile-fix" onClick={() => copy(fix.command)} title={t("machine.fix.copyTitle", { command: fix.command })} aria-label={t("machine.copyLabel", { command: fix.command })}>
      <Copy size={14} strokeWidth={1.75} aria-hidden="true" />
      {copied ? t("machine.copied") : t(`machine.fix.${fix.label}`)}
    </Button>
  );
}

const itemName = (t: (k: string) => string, id: MachineItemId, short: boolean) => (id === "longPaths" ? t(short ? "machine.short.longPaths" : "machine.longPaths") : id === "defender" ? t(short ? "machine.short.defender" : "machine.defender.label") : t(`machine.tools.${id}`));

function Tile({ item, index, onSteps }: { item: MachineItem; index: number; onSteps(target: MachineItemId): void }) {
  const { t } = useTranslation("start");
  const detail = t(item.detail.key, item.detail.params);
  return (
    <li className={`spec mtile s-${item.state}`}>
      <div className="mtile-top">
        <StateIcon state={item.state} />
        <span className="brand-name mtile-name">
          <Glyph id={item.id} />
          <span className="mtile-name-t">{itemName(t, item.id, true)}</span>
        </span>
        <span className="lbl mtile-n">{String(index + 1).padStart(2, "0")}</span>
      </div>
      <div className="mtile-detail" title={detail}>
        {detail}
      </div>
      {item.fix && item.state !== "pending" && <FixButton fix={item.fix} onSteps={onSteps} />}
    </li>
  );
}

function GateNote({ id, gate }: { id: MachineItemId; gate: VersionGate }) {
  const { t } = useTranslation("start");
  if (gate.status === "ok" || !gate.update) return null;
  return (
    <>
      <p>{t(`machine.gate.${gate.status}`, { tool: t(`machine.tools.${id}`), verified: gate.verified, need: t(`machine.gate.rule.${gate.rule}`, { verified: gate.verified }) })}</p>
      <Cmd text={gate.update} />
    </>
  );
}

/** The copy Crewyard starts and the others on PATH, with the npm removal where one applies. It never removes anything. */
function CopiesNote({ inUse, version, others }: { inUse: string; version: string | null; others: ToolCopy[] }) {
  const { t } = useTranslation("start");
  const unknown = t("machine.copies.versionUnknown");
  return (
    <>
      <p>{t("machine.copies.why", { path: inUse, version: version ?? unknown })}</p>
      <ul className="sysfolders">
        {others.map((o) => (
          <li key={o.path} className="mono">
            {o.path} · {o.version ?? unknown}
          </li>
        ))}
      </ul>
      {others.map((o) => (o.uninstall ? <Cmd key={o.path} text={o.uninstall} /> : null))}
      {others.some((o) => !o.uninstall) && <p className="muted">{t("machine.copies.other")}</p>}
    </>
  );
}

/** Read-only: says whether the worktree folder is excluded and how to add it. It never adds it. */
function DefenderNote({ check, open }: { check: DefenderCheck; open: boolean }) {
  const { t } = useTranslation("start");
  const folders = check.folders.filter((f) => f.excluded !== true);
  return (
    <>
      <p>{check.state === "unknown" ? t("machine.defender.whyUnknown") : t("machine.defender.why")}</p>
      <ul className="sysfolders">
        {folders.map((f) => (
          <li key={f.path} className="mono">
            {f.path}
          </li>
        ))}
      </ul>
      {/* The steps stay one click away: this check is advice, not something to fix before work starts. */}
      <details className="sysdetails" open={open || undefined}>
        <summary>{t("machine.defender.how")}</summary>
        <ol className="syssteps">
          <li>{t("machine.defender.step1")}</li>
          <li>{t("machine.defender.step2")}</li>
          <li>{t("machine.defender.step3")}</li>
        </ol>
        <p>{t("machine.defender.orAdmin")}</p>
        {folders.map((f) => (
          <Cmd key={f.path} text={`Add-MpPreference -ExclusionPath "${f.path}"`} />
        ))}
        {check.state === "unknown" && (
          <>
            <p>{t("machine.defender.checkAdmin")}</p>
            <Cmd text="(Get-MpPreference).ExclusionPath" />
          </>
        )}
      </details>
      <p className="muted">{t("machine.defender.never")}</p>
    </>
  );
}

/** Why a check matters and what to run, under its line in the full panel; null when all is well. */
function noteFor(t: (k: string) => string, item: MachineItem, env: MachineEnv | undefined, defender: DefenderCheck | undefined, gate: VersionGate | undefined, focus: boolean, copies?: { inUse: string; version: string | null; others: ToolCopy[] }): ReactNode {
  if (item.state === "pending") return null;
  if (item.id === "defender") return defender && item.fix ? <DefenderNote check={defender} open={focus} /> : null;
  if (item.id === "longPaths") {
    if (!item.fix) return null;
    return (
      <>
        <p>{t("machine.longNote")}</p>
        <Cmd text={LONG_PATHS_COMMAND} />
        <p className="muted">{t("machine.longNever")}</p>
      </>
    );
  }
  if (gate && gate.status !== "ok" && gate.update) return <GateNote id={item.id} gate={gate} />;
  if (copies) return <CopiesNote {...copies} />;
  if (item.id === "gh" && env && !env.ghUser && item.fix) {
    return (
      <>
        <p>{t("machine.ghNote")}</p>
        <Cmd text={GH_LOGIN_COMMAND} />
      </>
    );
  }
  return null;
}

export function MachineCheck() {
  const { t, i18n } = useTranslation("start");
  const qc = useQueryClient();
  const { items, env, defender, errors, gates, copies } = useMachine();
  // `machineDetails` in the query opens the panel for screenshots only.
  const [open, setOpen] = useState(() => typeof location !== "undefined" && new URLSearchParams(location.search).has("machineDetails"));
  const [focus, setFocus] = useState<MachineItemId | null>(null);
  const sum = summarize(items);
  const checking = env.isFetching || sum.pending > 0;
  const time = env.data ? new Intl.DateTimeFormat(i18n.language, { hour: "2-digit", minute: "2-digit" }).format(new Date(env.data.checkedAt)) : null;

  const again = () => {
    void qc.invalidateQueries({ queryKey: ["machine.tool"] });
    void qc.invalidateQueries({ queryKey: ["machine.env"] });
    void qc.invalidateQueries({ queryKey: ["machine.defender"] });
  };
  const showSteps = (target: MachineItemId) => {
    setOpen(true);
    setFocus(target);
  };

  // After "Open steps" the panel has rendered; bring that line into view and move focus to it.
  useEffect(() => {
    if (!open || !focus) return;
    const el = document.getElementById(rowId(focus));
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    el?.focus({ preventScroll: true });
  }, [open, focus]);

  let summary: { text: string; cls: string };
  if (sum.attention > 0) summary = { text: t("machine.summary.attention", { count: sum.attention }), cls: "st-wait" };
  else if (sum.pending > 0) summary = { text: t("machine.summary.checking", { count: sum.pending }), cls: "muted" };
  else summary = { text: t("machine.summary.ok"), cls: "st-ok" };

  return (
    <Panel id={MACHINE_PANEL_ID} tabIndex={-1} aria-labelledby={`${MACHINE_PANEL_ID}-title`} className="machine">
      <div className="machine-head">
        <h2 id={`${MACHINE_PANEL_ID}-title`}>{t("machine.title")}</h2>
        <span className={`machine-sum ${summary.cls}`} role="status">
          {summary.text}
        </span>
        <span className="lbl machine-time">{checking ? t("machine.checking") : time ? t("machine.checked", { time }) : ""}</span>
        <span className="machine-tools">
          <Button size="sm" variant="ghost" onClick={again} disabled={checking}>
            <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />
            {t("machine.again")}
          </Button>
          <Button size="sm" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-controls={DETAILS_ID}>
            <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" className={open ? "flip" : undefined} />
            {open ? t("machine.hideDetails") : t("machine.details")}
          </Button>
        </span>
      </div>
      <ul className="mtiles" aria-label={t("machine.title")}>
        {items.map((item, i) => (
          <Tile key={item.id} item={item} index={i} onSteps={showSteps} />
        ))}
      </ul>
      {open && (
        <div id={DETAILS_ID} className="machine-details">
          {items.map((item) => {
            const detail = errors[item.id] ? t("common:errors.daemon", { message: errors[item.id] }) : t(item.detail.key, item.detail.params);
            const note = noteFor(t, item, env.data, defender.data, gates[item.id], focus === item.id, copies[item.id]);
            return (
              <div key={item.id} id={rowId(item.id)} tabIndex={-1} className="machine-row">
                <div className="sysrow">
                  <StateIcon state={item.state} />
                  <span className="brand-name">
                    <Glyph id={item.id} />
                    {itemName(t, item.id, false)}
                  </span>
                  <span className="muted">{detail}</span>
                </div>
                {note && <div className="sysnote">{note}</div>}
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
