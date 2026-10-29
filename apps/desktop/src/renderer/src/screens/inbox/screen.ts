import { Inbox } from "lucide-react";
import type { ScreenDef } from "../../registry.ts";
import { useNav } from "../../nav.ts";
import { useWork } from "../tasks/data.ts";
import { InboxScreen } from "./InboxScreen.tsx";

/** Open requests of the project: the only counter in the sidebar (DESIGN.md §4). */
function useOpenRequests(): number {
  const projectId = useNav((s) => s.projectId);
  const q = useWork("requests.list", { projectId: projectId ?? "" }, { enabled: Boolean(projectId) });
  return q.data?.filter((r) => r.answeredAt === null).length ?? 0;
}

export const screen: ScreenDef = { id: "inbox", scope: "project", order: 20, navKey: "inbox:nav", icon: Inbox, useBadge: useOpenRequests, component: InboxScreen };
