import type { CrewyardApi } from "../../shared/api.ts";

declare global {
  interface Window {
    crewyard: CrewyardApi;
  }
}

export {};
