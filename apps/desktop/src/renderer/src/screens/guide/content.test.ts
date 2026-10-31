import { describe, expect, it } from "vitest";
import { resources } from "../../i18n.ts";
import { FAQ, FEATURES, FLOW, needsProject } from "./content.ts";
import type { UpdateOff } from "../../../../shared/api.ts";
import { GUIDE_ROWS } from "./model.ts";

/** Every reason the updater gives for not looking; the release answer quotes Settings' text for it. */
const UPDATE_OFF: UpdateOff[] = ["development", "platform", "no_feed", "not_installed", "invalid"];

// Every tile, row and question the Guide draws has its words in both languages, and every button
// goes to a screen that exists.

type Tree = Record<string, unknown>;
const at = (tree: unknown, path: string): unknown => path.split(".").reduce<unknown>((n, k) => (n && typeof n === "object" ? (n as Tree)[k] : undefined), tree);

describe("guide content", () => {
  for (const lang of ["en", "tr"]) {
    const ns = resources[lang]?.guide;
    it(`has every text in ${lang}`, () => {
      for (const s of FLOW) for (const k of ["title", "body", "go"]) expect(at(ns, `flow.steps.${s.id}.${k}`), `${lang} flow ${s.id}.${k}`).toBeTypeOf("string");
      for (const f of FEATURES) for (const k of ["title", "body", "go"]) expect(at(ns, `features.${f.id}.${k}`), `${lang} feature ${f.id}.${k}`).toBeTypeOf("string");
      // The release answer is put together from the running build's state, so it has parts, not one text.
      for (const q of FAQ) for (const k of q === "release" ? ["q", "reading", "unsigned", "signed", "feed"] : ["q", "a"]) expect(at(ns, `faq.${q}.${k}`), `${lang} faq ${q}.${k}`).toBeTypeOf("string");
      for (const why of UPDATE_OFF) expect(at(resources[lang]?.settings, `updates.off.${why}`), `${lang} settings updates.off.${why}`).toBeTypeOf("string");
      for (const r of GUIDE_ROWS) expect(at(ns, `checklist.rows.${r}.label`), `${lang} row ${r}`).toBeTypeOf("string");
      for (const k of ["hint", "problem", "refused", "attention_one", "attention_other", "go"]) expect(at(ns, `checklist.rows.machine.${k}`), `${lang} machine ${k}`).toBeTypeOf("string");
    });
  }

  it("follows the task flow in order", () => {
    expect(FLOW.map((s) => s.id)).toEqual(["project", "task", "proposal", "approve", "worktrees", "inbox", "review", "ship"]);
  });

  it("only sends you to registered screens", () => {
    // Folder names, read lazily: importing the registry here would load every screen.
    const ids = new Set(Object.keys(import.meta.glob("../*/screen.ts")).map((p) => p.split("/")[1]));
    for (const a of [...FLOW, ...FEATURES].map((x) => x.action)) if (a.kind === "screen") expect(ids.has(a.screen), a.screen).toBe(true);
  });

  it("knows which buttons need a project", () => {
    expect(needsProject({ kind: "screen", screen: "inbox" })).toBe(true);
    expect(needsProject({ kind: "screen", screen: "providers" })).toBe(false);
    expect(needsProject({ kind: "settings", section: "fallback" })).toBe(false);
    expect(needsProject({ kind: "keys" })).toBe(false);
  });
});
