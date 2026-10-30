import { Settings } from "lucide-react";
import type { ScreenDef } from "../../registry.ts";
import { SettingsScreen } from "./SettingsScreen.tsx";

// A launch screen, so it opens without a project. Entry points: the Settings line under the
// sidebar blocks and the status bar item (shell/sidebar/settings.tsx, shell/status/settings.tsx).
export const screen: ScreenDef = { id: "settings", scope: "launch", order: 90, navKey: "settings:nav", icon: Settings, component: SettingsScreen };
