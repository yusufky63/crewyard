import { describe, expect, it } from "vitest";
import { GOAL_LIMITS } from "@crewyard/core";
import { resources } from "../../i18n.ts";
import { DEFAULT_MODE, FAQ, FEATURES, FLOW, MODES, needsProject } from "./content.ts";
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
      for (const k of ["sections.modes", "modes.lead", "modes.default"]) expect(at(ns, k), `${lang} ${k}`).toBeTypeOf("string");
      for (const m of MODES) {
        for (const k of ["title", "body", "go"]) expect(at(ns, `modes.${m.id}.${k}`), `${lang} mode ${m.id}.${k}`).toBeTypeOf("string");
        expect(Object.keys((at(ns, `modes.${m.id}.points`) ?? {}) as Tree).length, `${lang} mode ${m.id} points`).toBeGreaterThan(0);
      }
      for (const s of FLOW) for (const k of ["title", "body", "go"]) expect(at(ns, `flow.steps.${s.id}.${k}`), `${lang} flow ${s.id}.${k}`).toBeTypeOf("string");
      for (const f of FEATURES) for (const k of ["title", "body", "go"]) expect(at(ns, `features.${f.id}.${k}`), `${lang} feature ${f.id}.${k}`).toBeTypeOf("string");
      // The release answer is put together from the running build's state, so it has parts, not one text.
      for (const q of FAQ) for (const k of q === "release" ? ["q", "reading", "unsigned", "signed", "feed"] : ["q", "a"]) expect(at(ns, `faq.${q}.${k}`), `${lang} faq ${q}.${k}`).toBeTypeOf("string");
      for (const why of UPDATE_OFF) expect(at(resources[lang]?.settings, `updates.off.${why}`), `${lang} settings updates.off.${why}`).toBeTypeOf("string");
      for (const r of GUIDE_ROWS) expect(at(ns, `checklist.rows.${r}.label`), `${lang} row ${r}`).toBeTypeOf("string");
      for (const k of ["hint", "problem", "refused", "attention_one", "attention_other", "go"]) expect(at(ns, `checklist.rows.machine.${k}`), `${lang} machine ${k}`).toBeTypeOf("string");
    });
  }

  it("shows the composer's three modes in its order, with Orchestra first as the default", () => {
    expect(MODES.map((m) => m.id)).toEqual(["orchestra", "crew", "solo"]);
    expect(DEFAULT_MODE).toBe("orchestra");
    expect(MODES[0]!.id).toBe(DEFAULT_MODE);
  });

  it("explains each mode and that Orchestra is the default, in both languages", () => {
    const en = resources.en!.guide as Tree;
    const tr = resources.tr!.guide as Tree;
    expect(at(en, "modes.lead")).toMatch(/Orchestra is the default/);
    expect(at(tr, "modes.lead")).toMatch(/varsayılan Orkestra/);
    // The numbers the Guide names are the ones the daemon enforces, so a changed limit fails here.
    const L = GOAL_LIMITS;
    expect(at(en, "modes.orchestra.body")).toContain(`at most ${L.maxTasks}`);
    expect(at(en, "modes.orchestra.points.c")).toContain(`at most ${L.maxParallel} at once`);
    expect(at(en, "faq.planningCost.a")).toContain(`$${L.planningFloorUsd.toFixed(2)}`);
    expect(at(en, "faq.planningCost.a")).toContain(`at most ${L.revisionsBeforeApproval} revisions before approval and ${L.replans} replans`);
    expect(at(tr, "modes.orchestra.body")).toContain(`en fazla ${L.maxTasks} görev`);
    expect(at(tr, "modes.orchestra.points.c")).toContain(`en fazla ${L.maxParallel} görev`);
    expect(at(tr, "faq.planningCost.a")).toContain(`${L.planningFloorUsd.toFixed(2).replace(".", ",")} $`);
    expect(at(tr, "faq.planningCost.a")).toContain(`en fazla ${L.revisionsBeforeApproval} güncelleme`);
    expect(at(tr, "faq.planningCost.a")).toContain(`en fazla ${L.replans} yeniden planlama`);
  });

  it("follows the task flow in order", () => {
    expect(FLOW.map((s) => s.id)).toEqual(["project", "task", "proposal", "approve", "worktrees", "inbox", "review", "ship"]);
  });

  it("only sends you to registered screens", () => {
    // Folder names, read lazily: importing the registry here would load every screen.
    const ids = new Set(Object.keys(import.meta.glob("../*/screen.ts")).map((p) => p.split("/")[1]));
    for (const a of [...MODES, ...FLOW, ...FEATURES].map((x) => x.action)) if (a.kind === "screen") expect(ids.has(a.screen), a.screen).toBe(true);
  });

  it("knows which buttons need a project", () => {
    expect(needsProject({ kind: "screen", screen: "inbox" })).toBe(true);
    expect(needsProject({ kind: "screen", screen: "providers" })).toBe(false);
    expect(needsProject({ kind: "settings", section: "fallback" })).toBe(false);
    expect(needsProject({ kind: "keys" })).toBe(false);
  });
});
