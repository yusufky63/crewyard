import { PREVIEW_LIMITS, PREVIEW_STYLE_PROPS } from "@crewyard/core";

// The element picker, run in an isolated world of the preview page: it shares the page's DOM but
// not its JavaScript, so the page cannot read or replace these functions. It answers with one
// plain object (or null when stopped); main checks and caps that object with capPick, because the
// page can still change the DOM under it. Synthetic events from the page are ignored.

/** The isolated world the picker runs in; any id above 0 (the page) and 999 (Electron's) would do. */
export const PICKER_WORLD = 1013;

/** Stops a running picker; it then resolves with null. */
export const STOP_PICKER = "globalThis.__crewyardPickStop && globalThis.__crewyardPickStop();";

/** `color` is the accent token from the renderer, already checked to be a hex colour. */
export function pickerScript(color: string): string {
  const config = JSON.stringify({ color, props: PREVIEW_STYLE_PROPS, max: PREVIEW_LIMITS.htmlTransfer });
  return `new Promise((resolve) => {
  const cfg = ${config};
  if (globalThis.__crewyardPickStop) globalThis.__crewyardPickStop();
  const root = document.documentElement;
  const box = document.createElement("div");
  box.setAttribute("aria-hidden", "true");
  box.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;box-sizing:border-box;display:none;border:2px solid " + cfg.color;
  root.appendChild(box);
  const cursor = root.style.cursor;
  root.style.cursor = "crosshair";
  let target = null;
  const segment = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) return s + "#" + CSS.escape(el.id);
    const classes = Array.from(el.classList).slice(0, 2).map((c) => "." + CSS.escape(c)).join("");
    return s + classes;
  };
  const selectorOf = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 5; n = n.parentElement) {
      parts.unshift(segment(n));
      if (n.id || n === document.body) break;
    }
    return parts.join(" > ");
  };
  const show = (el) => {
    const r = el.getBoundingClientRect();
    box.style.display = "block";
    box.style.left = r.left + "px";
    box.style.top = r.top + "px";
    box.style.width = r.width + "px";
    box.style.height = r.height + "px";
  };
  const onMove = (e) => {
    if (!e.isTrusted || !(e.target instanceof Element) || e.target === box) return;
    target = e.target;
    show(target);
  };
  const swallow = (e) => {
    if (!e.isTrusted) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const onClick = (e) => {
    if (!e.isTrusted) return;
    swallow(e);
    const el = target || (e.target instanceof Element ? e.target : null);
    if (!el) return;
    const cs = getComputedStyle(el);
    const styles = {};
    for (const p of cfg.props) styles[p] = cs.getPropertyValue(p);
    const r = el.getBoundingClientRect();
    const html = el.outerHTML;
    finish({ selector: selectorOf(el), html: html.slice(0, cfg.max), htmlChars: html.length, styles, width: r.width, height: r.height });
  };
  const events = [["pointermove", onMove], ["click", onClick], ["pointerdown", swallow], ["pointerup", swallow], ["mousedown", swallow], ["mouseup", swallow], ["auxclick", swallow], ["contextmenu", swallow]];
  function finish(value) {
    for (const [type, fn] of events) window.removeEventListener(type, fn, true);
    box.remove();
    root.style.cursor = cursor;
    delete globalThis.__crewyardPickStop;
    resolve(value);
  }
  globalThis.__crewyardPickStop = () => finish(null);
  for (const [type, fn] of events) window.addEventListener(type, fn, true);
})`;
}
