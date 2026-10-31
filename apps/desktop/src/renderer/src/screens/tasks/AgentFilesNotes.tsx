import type { CandidateView, CrewMemberView, StepAgentFiles } from "@crewyard/core";
import { useWork } from "./data.ts";
import { useFormat } from "./parts.tsx";

// What each step of a proposed crew reads besides the task (docs/adr/0015): the project's own
// instruction files its runner reads, the ones it gets through the project bridge, and what you
// shared into its profile folder. Shown before approval, so nothing reaches a run unseen.

function line(f: ReturnType<typeof useFormat>, s: StepAgentFiles): string | null {
  const parts: string[] = [];
  if (s.project.length > 0) parts.push(f.t("agentFiles.project", { list: s.project.join(", ") }));
  if (s.bridged.length > 0) parts.push(f.t("agentFiles.bridged", { list: s.bridged.join(", ") }));
  for (const kind of ["instructions", "skill", "command"] as const) {
    const names = s.shared.filter((x) => x.kind === kind).map((x) => (x.state === "current" ? x.name : f.t("agentFiles.stale", { name: x.name })));
    if (names.length > 0) parts.push(f.t(`agentFiles.shared.${kind}`, { list: names.join(", ") }));
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function AgentFilesNotes({ projectId, members, chosenOf }: { projectId: string; members: CrewMemberView[]; chosenOf: (m: CrewMemberView) => CandidateView | null }) {
  const f = useFormat();
  const profileIds = [...new Set(members.map((m) => chosenOf(m)?.profileId).filter((id): id is string => Boolean(id)))];
  const steps = useWork("agentfiles.forSteps", { projectId, profileIds }, { enabled: profileIds.length > 0 });
  const byProfile = new Map((steps.data ?? []).map((s) => [s.profileId, s]));
  const rows = members.flatMap((m) => {
    const c = chosenOf(m);
    const s = c ? byProfile.get(c.profileId) : undefined;
    const text = s ? line(f, s) : null;
    return c && text ? [{ id: m.id, who: `${m.roleTitle ?? f.role(m.role)} · ${f.runner(c.runner)}`, text }] : [];
  });
  if (rows.length === 0) return null;
  return (
    <div className="tk-agentfiles">
      <span className="lbl">{f.t("agentFiles.title")}</span>
      <ul>
        {rows.map((r) => (
          <li key={r.id} className="tk-small">
            <span>{r.who}: </span>
            <span className="as-typed muted">{r.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
