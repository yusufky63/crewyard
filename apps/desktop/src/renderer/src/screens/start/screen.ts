import type { ScreenDef } from "../../registry.ts";
import { StartScreen } from "./StartScreen.tsx";

export const screen: ScreenDef = { id: "start", scope: "launch", order: 0, component: StartScreen };
