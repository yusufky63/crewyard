import { Workflow } from "lucide-react";
import type { ScreenDef } from "../../registry.ts";
import { CrewScreen } from "./CrewScreen.tsx";

// Third in the sidebar, after Tasks and Inbox (DESIGN.md §4).
export const screen: ScreenDef = { id: "crew", scope: "project", order: 30, navKey: "crew:nav", icon: Workflow, component: CrewScreen };
