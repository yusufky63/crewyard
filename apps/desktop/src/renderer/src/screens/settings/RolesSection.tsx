import { RefreshCw, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CustomRoleStep, RoleProblem, RoleView } from "@crewyard/core";
import { Button } from "@crewyard/ui";
import { useDaemon } from "../../ipc.ts";
import { useNav } from "../../nav.ts";
import { Fact, Row, Section } from "./parts.tsx";

// Settings → Roles (PLAN.md §9.1): the built-in roles and the role files that override them or add
// new ones, as the next crew proposal in the open project would see them. Read-only on purpose:
// a role is edited in its file, which is where the project's history and review see it.

function useRoleName() {
  const { t } = useTranslation("settings");
  return (r: RoleView) => (r.builtin && r.source === "builtin" ? t(`tasks:role.${r.id}`, { defaultValue: r.title }) : r.title);
}

function StepLine({ step }: { step: CustomRoleStep }) {
  const { t } = useTranslation("settings");
  const kinds = step.kinds.map((k) => t(`tasks:kind.${k}`)).join(", ");
  const sizes = step.sizes ? step.sizes.join(", ") : t("roles.allSizes");
  const after = step.after.map((id) => t(`tasks:role.${id}`, { defaultValue: id })).join(", ");
  return <span>{step.after.length > 0 ? t("roles.stepAfter", { kinds, sizes, after }) : t("roles.step", { kinds, sizes })}</span>;
}

function RoleItem({ r }: { r: RoleView }) {
  const { t } = useTranslation("settings");
  const name = useRoleName();
  const others = r.independentOf.map((id) => t(`tasks:role.${id}`, { defaultValue: id })).join(", ");
  return (
    <li className="rl-item">
      <div className="rl-head">
        <span className="rl-name">{name(r)}</span>
        <span className="rl-id mono as-typed muted">{r.id}</span>
        <span className="lbl">{t(`roles.source.${r.source}`)}</span>
        {r.overrides && <span className="rl-over">{t("roles.overrides", { layer: t(`roles.layer.${r.overrides}`) })}</span>}
      </div>
      {r.path && (
        <span className="rl-path mono as-typed" title={r.path}>
          {r.path}
        </span>
      )}
      <div className="rl-facts">
        <span>{t(`roles.writes.${r.policy.writes}`)}</span>
        <span>{t(`roles.network.${r.policy.network}`)}</span>
        <span>{r.policy.allowCommands.length > 0 ? t("roles.commands", { list: r.policy.allowCommands.join(", ") }) : t("roles.noCommands")}</span>
        {r.needsReadOnly && <span>{t("roles.readOnlyRunner")}</span>}
        {others && <span>{t("roles.independent", { roles: others })}</span>}
        {r.source !== "builtin" && <span className="muted">{t("roles.contract", { count: r.contractChars })}</span>}
      </div>
      {!r.builtin && (
        <div className="rl-steps">
          {r.steps.length > 0 ? r.steps.map((s, i) => <StepLine key={i} step={s} />) : <span className="muted">{t("roles.unused")}</span>}
        </div>
      )}
    </li>
  );
}

function ProblemItem({ p }: { p: RoleProblem }) {
  const { t } = useTranslation("settings");
  return (
    <li>
      <TriangleAlert size={14} strokeWidth={1.75} aria-hidden="true" />
      <span className="rl-problem">
        <span className="mono as-typed rl-problem-path">{p.path}</span>
        <span>{t(`roles.problem.${p.code}`, { ...p.params, detail: p.params.detail ?? "", defaultValue: p.code })}</span>
      </span>
    </li>
  );
}

export function RolesSection({ index }: { index: number }) {
  const { t } = useTranslation("settings");
  const projectId = useNav((s) => s.projectId);
  const listing = useDaemon("roles.list", { projectId });
  const data = listing.data;
  return (
    <Section id="roles" index={index} title={t("sections.roles")}>
      <Row label={t("roles.title")} hint={t("roles.hint")}>
        <Button size="sm" disabled={listing.isFetching} onClick={() => void listing.refetch()}>
          <RefreshCw strokeWidth={1.75} />
          {t("roles.reload")}
        </Button>
      </Row>
      {data && (
        <>
          <Fact label={t("roles.global")} value={data.globalDir} />
          <Fact label={t("roles.project")} value={data.repoDir ?? <span className="muted">{t("roles.noProject")}</span>} />
          {data.problems.length > 0 && (
            <div className="rl-problems" role="group" aria-label={t("roles.problems")}>
              <div className="st-label">{t("roles.problems")}</div>
              <ul className="mcp-warn">
                {data.problems.map((p, i) => (
                  <ProblemItem key={`${p.path}-${i}`} p={p} />
                ))}
              </ul>
            </div>
          )}
          <ul className="rl-list" aria-label={t("roles.listLabel")}>
            {data.roles.map((r) => (
              <RoleItem key={r.id} r={r} />
            ))}
          </ul>
          <p className="st-note">{t("roles.projectRules")}</p>
        </>
      )}
      {listing.error && <p className="pv-error st-note">{t("roles.loadFailed")}</p>}
    </Section>
  );
}
