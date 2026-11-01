import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import { initI18n } from "../../i18n.ts";
import { useNav } from "../../nav.ts";
import { SECTIONS, useSettingsNav } from "./model.ts";
import { asSwitches, OrchestraSection, pauseAllCommand, pauseFromPalette, useSwitchError } from "./OrchestraSection.tsx";

// Settings → Orchestra and the palette entry (docs/adr/0019, design §5.2 and §6.5): the switch that
// turns new goals on or off, and Pause all goals, which only a click lifts.

const i18n = initI18n("en");

beforeEach(async () => {
  await i18n.changeLanguage("en");
  useSwitchError.setState({ error: null });
});

function render(state: unknown): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (state !== undefined) qc.setQueryData(["goals.state", undefined], state);
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, createElement(OrchestraSection, { index: 6 })));
}

/** The pressed option of the toggle labelled `label`, read from the markup. */
const pressed = (html: string, label: string): string | undefined => {
  const group = html.split(`aria-label="${label}"`)[1]?.split("</div>")[0] ?? "";
  return group.match(/aria-pressed="true"[^>]*>([^<]+)</)?.[1];
};

describe("Settings → Orchestra", () => {
  it("sits right after Fallback, before Autopilot", () => {
    expect(SECTIONS.indexOf("orchestra")).toBe(SECTIONS.indexOf("fallback") + 1);
    expect(SECTIONS.indexOf("autopilot")).toBe(SECTIONS.indexOf("orchestra") + 1);
  });

  it("shows Orchestra on and Pause all goals off as the daemon reports them", () => {
    const html = render({ enabled: true, pausedAll: false });
    expect(html).toContain("Orchestra");
    expect(html).toContain("Pause all goals");
    expect(pressed(html, "Orchestra")).toBe("On");
    expect(pressed(html, "Pause all goals")).toBe("Off");
    expect(html).toContain("Tasks outside goals keep running.");
  });

  it("says what Pause all goals holds while it is on", () => {
    const html = render({ enabled: false, pausedAll: true });
    expect(pressed(html, "Orchestra")).toBe("Off");
    expect(pressed(html, "Pause all goals")).toBe("On");
    expect(html).toContain("Lifting it is your click.");
  });

  it("shows a pressed Pause all goals in the danger tone, and a pressed Orchestra in ok", () => {
    const html = render({ enabled: true, pausedAll: true });
    const button = (label: string) => html.split(`aria-label="${label}"`)[1]?.split("</div>")[0]?.match(/<button[^>]*aria-pressed="true"[^>]*>/)?.[0] ?? "";
    expect(button("Pause all goals")).toContain("seg-bad");
    expect(button("Orchestra")).toContain("seg-ok");
  });

  it("says that planning runs are held too", () => {
    expect(render({ enabled: true, pausedAll: false })).toContain("no goal task or planning run starts");
  });

  it("disables both switches until the state is read, and ignores an answer that is not the state", () => {
    for (const state of [undefined, { id: "t1", status: "running" }]) {
      const html = render(state);
      expect(html.match(/disabled=""/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    }
  });

  it("reads naturally in Turkish", async () => {
    await i18n.changeLanguage("tr");
    const html = render({ enabled: true, pausedAll: false });
    expect(html).toContain("Orkestra");
    expect(html).toContain("Tüm hedefleri duraklat");
  });
});

describe("goal switches", () => {
  it("takes only real booleans as the state", () => {
    expect(asSwitches({ enabled: true, pausedAll: false })).toEqual({ enabled: true, pausedAll: false });
    expect(asSwitches({ enabled: "yes", pausedAll: false })).toBeUndefined();
    expect(asSwitches({ pausedAll: true })).toBeUndefined();
    expect(asSwitches(null)).toBeUndefined();
    expect(asSwitches(undefined)).toBeUndefined();
  });

  it("offers Pause all goals while goals may run, Resume while paused, and nothing before the state is read", () => {
    expect(pauseAllCommand({ enabled: true, pausedAll: false })).toEqual({ id: "action:pause-goals", titleKey: "search.pauseGoals", next: true });
    expect(pauseAllCommand({ enabled: false, pausedAll: true })).toEqual({ id: "action:pause-goals", titleKey: "search.resumeGoals", next: false });
    expect(pauseAllCommand(undefined)).toBeNull();
  });

  it("reports a refused palette flip in Settings → Orchestra instead of dropping it", async () => {
    useNav.setState({ screen: "tasks" });
    await pauseFromPalette(async () => {
      throw new Error("daemon.offline");
    }, true);
    expect(useSwitchError.getState().error).toBe("daemon.offline");
    expect(useNav.getState().screen).toBe("settings");
    expect(useSettingsNav.getState().section).toBe("orchestra");
  });

  it("clears an old error and stays put when the palette flip goes through", async () => {
    useNav.setState({ screen: "tasks" });
    useSwitchError.setState({ error: "old" });
    const calls: boolean[] = [];
    await pauseFromPalette(async (on) => {
      calls.push(on);
    }, false);
    expect(calls).toEqual([false]);
    expect(useSwitchError.getState().error).toBeNull();
    expect(useNav.getState().screen).toBe("tasks");
  });

  it("has the palette words in both languages", async () => {
    for (const lang of ["en", "tr"]) {
      await i18n.changeLanguage(lang);
      for (const key of ["search.pauseGoals", "search.resumeGoals", "search.goalsKeywords"]) expect(i18n.t(key, { ns: "titlebar" }), `${lang} ${key}`).not.toBe(key);
    }
  });
});
