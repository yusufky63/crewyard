import { Gauge } from "lucide-react";
import type { ScreenDef } from "../../registry.ts";
import { LimitsScreen } from "./LimitsScreen.tsx";

export const screen: ScreenDef = { id: "limits", scope: "project", order: 40, navKey: "limits:nav", icon: Gauge, component: LimitsScreen };
