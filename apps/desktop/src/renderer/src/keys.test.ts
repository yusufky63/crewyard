import { describe, expect, it } from "vitest";
import { resources } from "./i18n.ts";
import { ariaKeys, keycaps, keyText, matches, sequenceStep, SHORTCUTS, type KeyLike, type ShortcutId } from "./keys.ts";

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

describe("matches", () => {
  it("needs the exact modifiers", () => {
    expect(matches(key("k", { ctrlKey: true }), "palette")).toBe(true);
    // Caps Lock turns the key into "K" without Shift; it is still Ctrl K.
    expect(matches(key("K", { ctrlKey: true }), "palette")).toBe(true);
    expect(matches(key("K", { ctrlKey: true, shiftKey: true }), "palette")).toBe(false);
    expect(matches(key("k", { metaKey: true }), "palette")).toBe(true);
    expect(matches(key("k", { ctrlKey: true, altKey: true }), "palette")).toBe(false);
    expect(matches(key("k"), "palette")).toBe(false);
    expect(matches(key("f"), "graph.full")).toBe(true);
    expect(matches(key("F", { shiftKey: true }), "graph.full")).toBe(false);
  });
  it("lets Shift through for symbols that need it", () => {
    expect(matches(key("?", { shiftKey: true }), "help")).toBe(true);
    expect(matches(key("F1"), "help")).toBe(true);
    expect(matches(key("F1", { shiftKey: true }), "help")).toBe(false);
    expect(matches(key("+", { shiftKey: true }), "graph.zoomIn")).toBe(true);
  });
  it("covers every arrow with Alt for moving a node", () => {
    for (const a of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) expect(matches(key(a, { altKey: true }), "graph.move")).toBe(true);
    expect(matches(key("ArrowUp"), "graph.move")).toBe(false);
  });
  it("opens the node menu with Shift F10 or the menu key", () => {
    expect(matches(key("F10", { shiftKey: true }), "graph.menu")).toBe(true);
    expect(matches(key("ContextMenu"), "graph.menu")).toBe(true);
    expect(matches(key("F10"), "graph.menu")).toBe(false);
  });
});

describe("keycaps", () => {
  it("names keys the way the keycaps print them", () => {
    expect(keycaps("palette")).toEqual([["Ctrl", "K"]]);
    expect(keycaps("help")).toEqual([["?"], ["F1"]]);
    expect(keycaps("graph.menu")).toEqual([["Shift", "F10"], ["Menu"]]);
    expect(keycaps("graph.select", "Boşluk")).toEqual([["Enter"], ["Boşluk"]]);
    expect(keycaps("graph.move")).toEqual([["Alt", "←", "↑", "→", "↓"]]);
    expect(keyText("sidebar")).toBe("Ctrl B");
    expect(ariaKeys("palette")).toBe("Control+K");
    expect(ariaKeys("help")).toBe("? F1");
  });
});

// The registry cannot drift: every shortcut is matched somewhere, and nothing matches an unknown id.
describe("registry", () => {
  // Every source file of the renderer as text, through Vite's own loader.
  const sources = import.meta.glob<string>(["./**/*.ts", "./**/*.tsx", "!./**/*.test.ts", "!./**/*.test.tsx", "!./keys.ts"], { query: "?raw", import: "default", eager: true });
  const used = new Set<string>();
  for (const src of Object.values(sources)) {
    for (const m of src.matchAll(/(?:matches|keyText|ariaKeys|keycaps)\(\s*\w+\s*,\s*"([\w.]+)"\)|(?:keyText|ariaKeys)\(\s*"([\w.]+)"\s*\)|\[\s*"([\w.]+)",\s*\(\)\s*=>/g)) used.add(m[1] ?? m[2] ?? m[3]!);
  }
  const ids = new Set<string>(SHORTCUTS.map((s) => s.id));

  it("has a handler for every shortcut it lists", () => {
    const unused = [...ids].filter((id) => !used.has(id));
    expect(unused).toEqual([]);
  });
  it("lists every shortcut a handler matches", () => {
    expect([...used].filter((id) => !ids.has(id))).toEqual([]);
  });
  it("names every shortcut and group in both languages", () => {
    for (const lang of ["en", "tr"]) {
      const ns = resources[lang]?.keys as { action: Record<string, string>; group: Record<string, string> };
      for (const s of SHORTCUTS) {
        expect(ns.action[s.id], `${lang} ${s.id}`).toBeTruthy();
        expect(ns.group[s.group], `${lang} ${s.group}`).toBeTruthy();
      }
    }
  });
  it("keeps ids unique", () => {
    expect(ids.size).toBe(SHORTCUTS.length);
    const _typed: ShortcutId = "palette";
    expect(_typed).toBe("palette");
  });
});

describe("sequenceStep", () => {
  it("jumps on G then a letter within the wait, and only then", () => {
    let s = sequenceStep({ prefix: null, at: 0 }, key("g"), 1000);
    expect(s.id).toBeNull();
    s = sequenceStep(s.state, key("t"), 1500);
    expect(s.id).toBe("go.tasks");
    expect(matches(key("t"), "go.tasks")).toBe(false);
    const late = sequenceStep(sequenceStep({ prefix: null, at: 0 }, key("g"), 0).state, key("i"), 5000);
    expect(late.id).toBeNull();
    const gg = sequenceStep(sequenceStep({ prefix: null, at: 0 }, key("g"), 0).state, key("g"), 10);
    expect(gg.id).toBe("go.crew");
    const broken = sequenceStep(sequenceStep({ prefix: null, at: 0 }, key("g"), 0).state, key("g", { ctrlKey: true }), 10);
    expect(broken.id).toBeNull();
    expect(keycaps("go.limits")).toEqual([["G", "L"]]);
  });
});
