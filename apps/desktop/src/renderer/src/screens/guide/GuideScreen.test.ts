import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import { initI18n } from "../../i18n.ts";
import { MODES, modeAction, shownDefault } from "./content.ts";
import { Flow, Modes, SECTIONS, type Actions } from "./GuideScreen.tsx";

// The Guide's first section as it renders (docs/adr/0019): the composer's three modes in order,
// the Default badge read from the real Orchestra switch, and the sections after it numbered from 02.

const i18n = initI18n("en");

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

/** A project is open, so every button is live; the buttons themselves are not clicked here. */
const actions = { run: async () => undefined, available: () => true, projectKnown: true, target: "p1", projects: [], projectsRead: true, projectId: "p1", keysOpen: false, closeKeys: () => undefined } as unknown as Actions;

function render(component: typeof Modes | typeof Flow, state?: unknown): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (state !== undefined) qc.setQueryData(["goals.state", undefined], state);
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, createElement(component, { actions })));
}

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"');
/** Each mode tile's markup, in the order it renders. */
const tiles = (html: string) => [...html.matchAll(/<article[^>]*aria-labelledby="gd-m-(\w+)"[^>]*>([\s\S]*?)<\/article>/g)].map((m) => ({ id: m[1]!, html: m[2]! }));
const sectionLabel = (html: string) => html.match(/<h2[^>]*><span class="lbl">(\d+)<\/span>/)?.[1];

describe("Guide: three ways to run work", () => {
  it("comes first, numbered 01, with the flow after it as 02", () => {
    expect(SECTIONS[0]).toBe("modes");
    expect(sectionLabel(render(Modes, { enabled: true, pausedAll: false }))).toBe("01");
    expect(sectionLabel(render(Flow))).toBe("02");
  });

  it("draws Orchestra, Crew and Solo in order, each with its points, and only Orchestra marked Default", () => {
    const html = render(Modes, { enabled: true, pausedAll: false });
    const t = tiles(html);
    expect(t.map((x) => x.id)).toEqual(["orchestra", "crew", "solo"]);
    expect(html.match(/badge badge-info/g)).toHaveLength(1);
    expect(t[0]!.html).toContain(">Default<");
    for (const x of t) expect(x.html.match(/<li>/g)?.length ?? 0).toBeGreaterThan(1);
    expect(decode(t[0]!.html)).toContain("Write a goal");
    expect(decode(t[1]!.html)).toContain("Write a Crew task");
    expect(decode(t[2]!.html)).toContain("Write a task");
    expect(html).not.toContain("Settings → Orchestra");
  });

  it("keeps the shipped default while the switch is not read yet", () => {
    for (const state of [undefined, { id: "t1", status: "running" }]) {
      const t = tiles(render(Modes, state));
      expect(t[0]!.html).toContain(">Default<");
      expect(t[1]!.html).not.toContain(">Default<");
    }
  });

  it("marks Crew as the default while Orchestra is off, and sends Orchestra's button to the switch", () => {
    const html = render(Modes, { enabled: false, pausedAll: false });
    const t = tiles(html);
    expect(html.match(/badge badge-info/g)).toHaveLength(1);
    expect(t[1]!.html).toContain(">Default<");
    expect(t[0]!.html).toContain(">Off<");
    expect(decode(t[0]!.html)).toContain("Open Settings → Orchestra");
    expect(decode(html)).toContain("Orchestra is off in Settings → Orchestra");
  });

  it("reads naturally in Turkish, off or on", async () => {
    await i18n.changeLanguage("tr");
    const on = tiles(render(Modes, { enabled: true, pausedAll: false }));
    expect(decode(on[0]!.html)).toContain("Orkestra");
    expect(on[0]!.html).toContain(">Varsayılan<");
    expect(decode(on[1]!.html)).toContain("Ekip görevi yaz");
    const off = render(Modes, { enabled: false, pausedAll: false });
    expect(tiles(off)[0]!.html).toContain(">Kapalı<");
    expect(decode(off)).toContain("Ayarlar → Orkestra'yı aç");
  });
});

describe("Guide: what each mode tile opens", () => {
  it("opens the composer on the tile's own mode", () => {
    for (const m of MODES) expect(m.action).toEqual({ kind: "newTask", mode: m.id });
  });

  it("sends Orchestra's tile to Settings → Orchestra only while the switch is off", () => {
    const orchestra = MODES.find((m) => m.id === "orchestra")!;
    expect(modeAction(orchestra, false)).toEqual({ kind: "settings", section: "orchestra" });
    expect(modeAction(orchestra, true)).toEqual(orchestra.action);
    expect(modeAction(orchestra, undefined)).toEqual(orchestra.action);
    for (const m of MODES.filter((x) => x.id !== "orchestra")) expect(modeAction(m, false)).toEqual(m.action);
    expect(shownDefault(false)).toBe("crew");
    expect(shownDefault(true)).toBe("orchestra");
    expect(shownDefault(undefined)).toBe("orchestra");
  });
});
