import { BookOpen } from "lucide-react";
import type { ScreenDef } from "../../registry.ts";
import { GuideScreen } from "./GuideScreen.tsx";

// Last in the sidebar, after GitHub: reference, not daily work. A project screen so it sits in the
// nav, yet it also opens without a project (from Start's "New here?" link and G W), where it shows
// full width and its project buttons open the most recent project, or say one is needed.
export const screen: ScreenDef = { id: "guide", scope: "project", order: 70, navKey: "guide:nav", icon: BookOpen, component: GuideScreen };
