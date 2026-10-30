import { Inbox } from "lucide-react";
import type { ScreenDef } from "../../registry.ts";
import { useNav } from "../../nav.ts";
import { useWork } from "../tasks/data.ts";
import { InboxScreen } from "./InboxScreen.tsx";
import { useReports } from "./Reports.tsx";

/**
 * Open requests of the project, plus agents' reports that wait on you (needs input, stuck, a
 * follow-up proposal): the only counter in the sidebar (DESIGN.md §4).
 */
function useOpenRequests(): number {
  const projectId = useNav((s) => s.projectId);
  const q = useWork("requests.list", { projectId: projectId ?? "" }, { enabled: Boolean(projectId) });
  const reports = useReports(projectId ?? "");
  return (q.data?.filter((r) => r.answeredAt === null).length ?? 0) + (reports.data?.length ?? 0);
}

export const screen: ScreenDef = { id: "inbox", scope: "project", order: 20, navKey: "inbox:nav", icon: Inbox, useBadge: useOpenRequests, component: InboxScreen };
