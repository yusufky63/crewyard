import { Plug } from "lucide-react";
import type { ScreenDef } from "../../registry.ts";
import { ProvidersScreen } from "./ProvidersScreen.tsx";

export const screen: ScreenDef = { id: "providers", scope: "project", order: 50, navKey: "providers:nav", icon: Plug, component: ProvidersScreen };
