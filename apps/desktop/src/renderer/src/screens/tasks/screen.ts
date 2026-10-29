import { ListTodo } from "lucide-react";
import type { ScreenDef } from "../../registry.ts";
import { TasksScreen } from "./TasksScreen.tsx";

// order 10: the first project screen, so opening a project lands here (the project home).
export const screen: ScreenDef = { id: "tasks", scope: "project", order: 10, navKey: "tasks:nav", icon: ListTodo, component: TasksScreen };
