import { useState, type CSSProperties } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@crewyard/ui";
import type { FolderDetection, RunnerId, ToolId } from "@crewyard/core";
import { useDaemon } from "../../ipc.ts";
import { useDraft } from "./draft.ts";
import { CheckBox, Row, Seg } from "./parts.tsx";

const RUNNERS: Array<{ runner: RunnerId; tool: ToolId; series: string }> = [
  { runner: "claude-code", tool: "claude", series: "--series-claude" },
  { runner: "codex", tool: "codex", series: "--series-codex" },
  { runner: "opencode", tool: "opencode", series: "--series-opencode" },
  { runner: "gemini-cli", tool: "gemini", series: "--series-gemini" },
];

function RunnerRow({ runner, tool, series }: (typeof RUNNERS)[number]) {
  const { t } = useTranslation("setup");
  const d = useDraft();
  // Same query key as the Start screen's machine check, so this is usually already cached.
  const q = useDaemon("machine.tool", { id: tool }, { staleTime: 5 * 60_000 });
  const found = Boolean(q.data?.found);
  const on = d.runners.includes(runner);
  const toggle = (v: boolean) => d.set({ runners: v ? [...d.runners, runner] : d.runners.filter((r) => r !== runner) });
  let detail = t("checking");
  if (q.isError) detail = String(q.error);
  else if (q.data) detail = found ? [q.data.version ? `v${q.data.version}` : t("agents.installed"), t("agents.noConformance")].join(" · ") : t("agents.notInstalled");
  return (
    <div className="cl">
      <CheckBox checked={on && found} disabled={!found} onChange={toggle} label={t(`agents.names.${runner}`)} />
      <span>
        <i className="dot" style={{ "--c": `var(${series})` } as CSSProperties} aria-hidden="true" /> {t(`agents.names.${runner}`)}
      </span>
      {/* Found in ok; a missing agent CLI stays muted, because one is enough (DESIGN.md §5 MachineStrip). */}
      <span className={found ? "st-ok" : "muted"}>{detail}</span>
      <span className="cl-act" />
    </div>
  );
}

export function AgentsStep() {
  const { t } = useTranslation("setup");
  return (
    <>
      <h2>{t("agents.title")}</h2>
      <p className="sec">{t("agents.lead")}</p>
      <div className="check-list">
        {RUNNERS.map((r) => (
          <RunnerRow key={r.runner} {...r} />
        ))}
      </div>
      <BridgeRow />
    </>
  );
}

/** The project bridge (docs/adr/0015): off unless you tick it; changeable later in Settings. */
function BridgeRow() {
  const { t } = useTranslation("setup");
  const d = useDraft();
  return (
    <div className="check-list">
      <div className="cl cl-bridge">
        <CheckBox checked={d.bridgeInstructions} onChange={(v) => d.set({ bridgeInstructions: v })} label={t("agents.bridge")} />
        <span>{t("agents.bridge")}</span>
        <span className="muted">{t("agents.bridgeHint")}</span>
        <span className="cl-act" />
      </div>
    </div>
  );
}

function Money({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const bad = !(Number(value) >= 0) || value.trim() === "";
  return (
    <span className="money">
      <span className="muted mono">$</span>
      <input className="input mono num-input" inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} aria-invalid={bad} />
    </span>
  );
}

export function BudgetStep() {
  const { t } = useTranslation("setup");
  const d = useDraft();
  return (
    <>
      <h2>{t("budget.title")}</h2>
      <p className="sec">{t("budget.lead")}</p>
      <div className="check-list">
        <Row state="wait" label={t("budget.profiles")}>{t("budget.noProfiles")}</Row>
      </div>
      <div className="check-list">
        <Row state="none" label={t("budget.daily")}>
          <Money value={d.dailyUsd} onChange={(v) => d.set({ dailyUsd: v })} label={t("budget.daily")} />
        </Row>
        <Row state="none" label={t("budget.perTask")}>
          <Money value={d.perTaskUsd} onChange={(v) => d.set({ perTaskUsd: v })} label={t("budget.perTask")} />
        </Row>
      </div>
      <p className="muted small note">{t("budget.note")}</p>
    </>
  );
}

function Commands() {
  const { t } = useTranslation("setup");
  const d = useDraft();
  const [next, setNext] = useState("");
  const add = () => {
    const c = next.trim();
    if (c && !d.allowCommands.includes(c)) d.set({ allowCommands: [...d.allowCommands, c] });
    setNext("");
  };
  return (
    <div className="chips">
      {d.allowCommands.map((c) => (
        <span className="chip" key={c}>
          <b className="mono">{c}</b>
          <button type="button" className="chip-x" onClick={() => d.set({ allowCommands: d.allowCommands.filter((x) => x !== c) })} aria-label={t("rules.remove", { command: c })}>
            <X size={12} strokeWidth={1.75} />
          </button>
        </span>
      ))}
      <input
        className="input mono chip-input"
        value={next}
        onChange={(e) => setNext(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") add();
        }}
        placeholder={t("rules.addPlaceholder")}
        aria-label={t("rules.add")}
      />
      <Button size="sm" variant="ghost" onClick={add} disabled={!next.trim()}>
        {t("rules.add")}
      </Button>
    </div>
  );
}

export function RulesStep() {
  const { t } = useTranslation("setup");
  const d = useDraft();
  const slots = Number(d.slots);
  return (
    <>
      <h2>{t("rules.title")}</h2>
      <p className="sec">{t("rules.lead")}</p>
      <div className="setrow">
        <span>
          {t("rules.fallback")}
          <span className="muted small block">{t(`rules.fallbackHint.${d.fallback}`)}</span>
        </span>
        <Seg value={d.fallback} label={t("rules.fallback")} onChange={(v) => d.set({ fallback: v })} options={(["manual", "ask", "auto"] as const).map((v) => ({ value: v, label: t(`rules.fallbacks.${v}`) }))} />
      </div>
      <div className="setrow">
        <span>
          {t("rules.slots")}
          <span className="muted small block">{t("rules.slotsHint")}</span>
        </span>
        <input className="input mono num-input" inputMode="numeric" value={d.slots} onChange={(e) => d.set({ slots: e.target.value })} aria-label={t("rules.slots")} aria-invalid={!(Number.isInteger(slots) && slots >= 1 && slots <= 16)} />
      </div>
      <div className="setrow wrap">
        <span>
          {t("rules.commands")}
          <span className="muted small block">{t("rules.commandsHint")}</span>
        </span>
        <Commands />
      </div>
      <div className="setrow">
        <span>
          {t("rules.network")}
          <span className="muted small block">{t("rules.networkHint")}</span>
        </span>
        <Seg value={d.network} label={t("rules.network")} onChange={(v) => d.set({ network: v })} options={(["ask", "allowed"] as const).map((v) => ({ value: v, label: t(`rules.networks.${v}`) }))} />
      </div>
      <div className="setrow">
        <span>
          {t("rules.toasts")}
          <span className="muted small block">{t("rules.toastsHint")}</span>
        </span>
        <Seg value={d.toastApprovals} label={t("rules.toasts")} onChange={(v) => d.set({ toastApprovals: v })} options={(["low", "none"] as const).map((v) => ({ value: v, label: t(`rules.toastOptions.${v}`) }))} />
      </div>
    </>
  );
}

export function GithubStep({ det }: { det: FolderDetection | undefined }) {
  const { t } = useTranslation("setup");
  const d = useDraft();
  const env = useDaemon("machine.env", undefined, { staleTime: 5 * 60_000 });
  const gh = useDaemon("machine.tool", { id: "gh" }, { staleTime: 5 * 60_000 });
  const user = env.data?.ghUser ?? null;
  const willBeRepo = Boolean(det?.git.isRepo || d.gitInit);
  const hasCi = det?.workflows.some((f) => /^ci\.ya?ml$/i.test(f)) ?? false;
  const hasCommands = Boolean(d.build.trim() || d.test.trim());
  const pct = Number(d.actionsWarnPct);

  let signIn;
  if (env.isPending || gh.isPending) signIn = <Row state="run" label={t("github.signedIn")}>{t("checking")}</Row>;
  else if (!gh.data?.found) signIn = <Row state="bad" label={t("github.signedIn")}>{t("github.ghMissing")}</Row>;
  else if (!user) signIn = <Row state="wait" label={t("github.signedIn")}>{t("github.ghSignedOut")}</Row>;
  else signIn = <Row state="ok" label={t("github.signedIn")}>{t("github.as", { user })}</Row>;

  let remote;
  if (det?.git.remoteUrl) remote = <Row state="ok" label={t("github.remote")}>{det.git.githubRepo ?? det.git.remoteUrl}</Row>;
  else {
    const canCreate = Boolean(user) && willBeRepo;
    remote = (
      <>
        <Row state={d.createRepo ? "ok" : "wait"} label={t("github.remote")} action={<CheckBox checked={d.createRepo && canCreate} disabled={!canCreate} onChange={(v) => d.set({ createRepo: v })} label={t("github.createRepo")} />}>
          {!user ? t("github.noRemoteSignIn") : !willBeRepo ? t("github.noRemoteGit") : d.createRepo ? t("github.createOn", { user }) : t("github.createOff")}
        </Row>
        {d.createRepo && canCreate && (
          <Row state="none" label={t("github.repoName")}>
            <input className="input mono" value={d.repoName} onChange={(e) => d.set({ repoName: e.target.value })} aria-label={t("github.repoName")} />
          </Row>
        )}
      </>
    );
  }

  return (
    <>
      <h2>{t("github.title")}</h2>
      <p className="sec">{t("github.lead")}</p>
      <div className="check-list">
        {signIn}
        {remote}
        <Row state="ok" label={t("github.pushes")} action={<CheckBox checked disabled label={t("github.pushes")} />}>
          {t("github.pushesText")}
        </Row>
        <Row
          state={d.ci && hasCommands && !hasCi ? "ok" : "none"}
          label={t("github.ci")}
          action={<CheckBox checked={d.ci && hasCommands && !hasCi} disabled={!hasCommands || hasCi} onChange={(v) => d.set({ ci: v })} label={t("github.ci")} />}
        >
          {hasCi ? t("github.ciExists") : !hasCommands ? t("github.ciNoCommands") : t("github.ciText")}
        </Row>
        <Row state="none" label={t("github.actions")}>
          <span className="money">
            <input className="input mono num-input" inputMode="numeric" value={d.actionsWarnPct} onChange={(e) => d.set({ actionsWarnPct: e.target.value })} aria-label={t("github.actions")} aria-invalid={!(pct >= 1 && pct <= 100)} />
            <span className="muted">{t("github.actionsText")}</span>
          </span>
        </Row>
      </div>
    </>
  );
}
