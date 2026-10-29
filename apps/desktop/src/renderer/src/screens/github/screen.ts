import { GitPullRequest } from "lucide-react";
import type { ScreenDef } from "../../registry.ts";
import { GithubScreen } from "./GithubScreen.tsx";

// Last in the sidebar, after Tasks, Inbox, Crew graph, Limits and Providers (DESIGN.md §4).
export const screen: ScreenDef = { id: "github", scope: "project", order: 60, navKey: "github:nav", icon: GitPullRequest, component: GithubScreen };
