import type { ScreenDef } from "../../registry.ts";
import { SetupScreen } from "./SetupScreen.tsx";

export const screen: ScreenDef = { id: "setup", scope: "launch", order: 1, component: SetupScreen };
