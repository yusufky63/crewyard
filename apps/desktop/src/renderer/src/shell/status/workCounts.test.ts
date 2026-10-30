import { createInstance } from "i18next";
import { describe, expect, it } from "vitest";
import { resources } from "../../i18n.ts";
import { workCounts } from "./workCounts.ts";

describe("workCounts", () => {
  it("counts running agents across tasks, but queued tasks one each", () => {
    const tasks = [
      { status: "running" as const, activeRuns: 4 },
      { status: "running" as const, activeRuns: 2 },
      { status: "queued" as const, activeRuns: 0 },
      { status: "failed" as const, activeRuns: 0 },
    ];
    expect(workCounts(tasks)).toEqual({ agents: 6, queued: 1 });
    expect(workCounts([])).toEqual({ agents: 0, queued: 0 });
  });
});

describe("status bar work label", () => {
  const label = async (lng: string, agents: number, queued: number) => {
    const i18n = createInstance();
    await i18n.init({ lng, resources, ns: ["tasks"], defaultNS: "tasks", interpolation: { escapeValue: false } });
    return i18n.t("statusbar.work", { agents: i18n.t("statusbar.agents", { count: agents }), queued: i18n.t("statusbar.queued", { count: queued }) });
  };

  it("names each number's unit in English, singular and plural", async () => {
    expect(await label("en", 6, 0)).toBe("6 agents running · 0 tasks queued");
    expect(await label("en", 1, 1)).toBe("1 agent running · 1 task queued");
  });

  it("names each number's unit in Turkish", async () => {
    expect(await label("tr", 6, 0)).toBe("6 ajan çalışıyor · 0 görev sırada");
    expect(await label("tr", 1, 2)).toBe("1 ajan çalışıyor · 2 görev sırada");
  });
});
