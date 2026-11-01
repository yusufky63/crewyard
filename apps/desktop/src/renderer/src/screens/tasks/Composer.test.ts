import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import { GOAL_LIMITS } from "@crewyard/core";
import { initI18n } from "../../i18n.ts";
import { Composer, introBudget } from "./Composer.tsx";
import { useComposerPick, useComposerPrefs } from "./composerPrefs.ts";
import { goalFixtureCall } from "./goalFixture.ts";
import { INTRO_BUDGET_USD } from "./goalsModel.ts";

// The composer's mode control as it first renders (design §1.2, §3.1), static markup with real
// translations as the other screen tests do: the opening mode, a disabled Orchestra with its
// reason, and Plan goal stating its cost with its provenance.

const i18n = initI18n("en");
const PROJECT = "p-composer";
const PATH = "C:\\Projeler\\yeni proje";

beforeEach(async () => {
  await i18n.changeLanguage("en");
  useComposerPrefs.setState({ modes: {}, soloWho: {} });
});

function render(query = "", projectId = PROJECT): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["goals.preview", { projectId, text: "" }], goalFixtureCall("goals.preview", { projectId, text: "" }, projectId, new URLSearchParams(query)));
  qc.setQueryData(["github.repo", { projectId }], { remote: null, currentBranch: "main" });
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, createElement(Composer, { projectId, projectName: "yeni proje", projectPath: PATH, assistantOpen: false, onAssistant: () => undefined })));
}

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"');
const text = (html: string) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
/** The opening tag of the mode button `m`. */
const modeButton = (html: string, m: string) => html.match(new RegExp(`<button[^>]*data-mode="${m}"[^>]*>`))?.[0] ?? "";

describe("composer mode control", () => {
  it("opens on Orchestra where a profile can plan, and Plan goal states its cost with its provenance", () => {
    const html = render();
    expect(modeButton(html, "orchestra")).toContain('aria-pressed="true"');
    expect(modeButton(html, "solo")).toContain('aria-pressed="false"');
    expect(text(html)).toContain("Plan goal · ~$0.36 Estimated");
    expect(text(html)).toMatch(/up to \$1\.08/);
  });

  it("disables Orchestra with its reason and opens on Crew where no profile can plan", () => {
    const html = render("noplanner");
    expect(modeButton(html, "orchestra")).toContain('disabled=""');
    expect(modeButton(html, "crew")).toContain('aria-pressed="true"');
    expect(text(html)).toContain("Open Providers");
    expect(text(html)).not.toContain("Plan goal");
  });

  // The remembered mode itself is goalsModel's openingMode (tested there): static rendering reads a
  // zustand store's initial state only, so it cannot show a remembered pick here.
});

describe("first-goal card budget", () => {
  it("prefills the project's default, else its per-task cap, else $3, never past the limit", () => {
    expect(introBudget(5, 4)).toBe(5);
    expect(introBudget(null, 4)).toBe(4);
    expect(introBudget(null, 0)).toBe(INTRO_BUDGET_USD);
    expect(introBudget(undefined, null)).toBe(INTRO_BUDGET_USD);
    expect(introBudget(null, GOAL_LIMITS.budgetMaxUsd + 50)).toBe(GOAL_LIMITS.budgetMaxUsd);
  });
});

describe("a mode picked from the Guide", () => {
  it("is taken once for the next request and never remembered, Solo included", () => {
    useComposerPick.getState().pick("solo");
    const n = useComposerPick.getState().n;
    expect(useComposerPick.getState().take()).toBe("solo");
    expect(useComposerPick.getState().take()).toBeNull();
    expect(useComposerPick.getState().n).toBe(n);
    expect(useComposerPrefs.getState().modes).toEqual({});
  });

  it("opens the composer on the picked mode, Solo too, while nothing is remembered", () => {
    useComposerPick.setState({ mode: null });
    useComposerPick.getState().pick("solo");
    const html = render();
    expect(modeButton(html, "solo")).toContain('aria-pressed="true"');
    expect(modeButton(html, "orchestra")).toContain('aria-pressed="false"');
    expect(useComposerPrefs.getState().modes).toEqual({});
    useComposerPick.setState({ mode: null });
    expect(modeButton(render(), "orchestra")).toContain('aria-pressed="true"');
  });

  it("arrives again when the same mode is picked twice", () => {
    const before = useComposerPick.getState().n;
    useComposerPick.getState().pick("crew");
    useComposerPick.getState().take();
    useComposerPick.getState().pick("crew");
    expect(useComposerPick.getState().n).toBe(before + 2);
    expect(useComposerPick.getState().take()).toBe("crew");
  });
});
