import type { AgentEvent } from "./events.ts";

// Size caps for agent events on their way to the store and the renderer. A tool that returns a
// whole PDF or a minified bundle must not freeze the window or bloat the event log (vibe-kanban
// #2166, Agent Monitor #223, #341). The daemon caps a copy: rules such as risk classification
// still see the full event.

export const EVENT_LIMITS = {
  /** One text field: a message or thought chunk, a tool output. */
  text: 64 * 1024,
  /** A tool call's input, as JSON. */
  input: 32 * 1024,
  /** Commands, questions, plan steps, state details. */
  line: 16 * 1024,
  /** Entries in a plan or diff list. */
  items: 500,
} as const;

/** Upper bound for any one stored event payload, as JSON; past it only a marker is kept. */
export const MAX_EVENT_JSON = 1024 * 1024;

export type EventLimits = { readonly [K in keyof typeof EVENT_LIMITS]: number };

/** UTF-8 length without allocating a copy of a string that may be megabytes long. */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/**
 * Binary content decoded as text: NUL bytes, or many replacement characters and control codes in
 * the first 8 KB. Tabs, line breaks and ANSI escapes are normal tool output.
 */
export function looksBinary(s: string): boolean {
  const head = s.slice(0, 8192);
  if (head.includes("\0")) return true;
  let odd = 0;
  for (let i = 0; i < head.length; i++) {
    const c = head.charCodeAt(i);
    if (c === 0xfffd || (c < 0x20 && c !== 9 && c !== 10 && c !== 13 && c !== 12 && c !== 8 && c !== 27)) odd++;
  }
  return head.length > 0 && odd / head.length > 0.1;
}

export function truncatedMarker(bytes: number, keptAt?: string | null): string {
  return keptAt ? `[truncated, ${bytes} bytes; full text in ${keptAt}]` : `[truncated, ${bytes} bytes]`;
}

export interface Cut {
  field: string;
  bytes: number;
  binary: boolean;
}

/**
 * Keeps the head of `s` within `maxBytes` (whole characters only) and appends the marker. Binary
 * content keeps no head at all: a screen of mojibake helps nobody and costs a render.
 */
export function capText(s: string, maxBytes: number, keptAt?: string | null): { text: string; bytes: number | null; binary: boolean } {
  // Every UTF-16 unit is at most 3 bytes (pairs are 4 for 2 units), so short strings skip the count.
  if (s.length * 3 <= maxBytes) return { text: s, bytes: null, binary: false };
  const bytes = utf8Length(s);
  if (bytes <= maxBytes) return { text: s, bytes: null, binary: false };
  if (looksBinary(s)) return { text: `[binary output, ${bytes} bytes]`, bytes, binary: true };
  const marker = `\n${truncatedMarker(bytes, keptAt)}`;
  const budget = Math.max(0, maxBytes - utf8Length(marker));
  let used = 0;
  let end = 0;
  while (end < s.length) {
    const c = s.charCodeAt(end);
    const pair = c >= 0xd800 && c <= 0xdbff && end + 1 < s.length;
    const w = c < 0x80 ? 1 : c < 0x800 ? 2 : pair ? 4 : 3;
    if (used + w > budget) break;
    used += w;
    end += pair ? 2 : 1;
  }
  return { text: s.slice(0, end) + marker, bytes, binary: false };
}

/**
 * Where the full text of a cut field may be kept, or null to keep only the head. Called only for
 * fields that were cut and are not binary.
 */
export type KeepFull = (field: string, full: string) => string | null;

/** A copy of `ev` with every unbounded field capped, and what was cut. */
export function capEvent(ev: AgentEvent, limits: EventLimits = EVENT_LIMITS, keep?: KeepFull): { event: AgentEvent; cut: Cut[] } {
  const cut: Cut[] = [];
  const text = (field: string, s: string, max: number, keepable = false): string => {
    const first = capText(s, max);
    if (first.bytes === null) return s;
    cut.push({ field, bytes: first.bytes, binary: first.binary });
    if (first.binary || !keepable || !keep) return first.text;
    const at = keep(field, s);
    return at ? capText(s, max, at).text : first.text;
  };
  const list = <T>(field: string, items: T[]): T[] => {
    if (items.length <= limits.items) return items;
    cut.push({ field, bytes: items.length, binary: false });
    return items.slice(0, limits.items);
  };

  switch (ev.type) {
    case "message.delta":
    case "thought.delta":
      return { event: { ...ev, text: text("text", ev.text, limits.text) }, cut };
    case "tool.update":
      return { event: ev.output === undefined ? ev : { ...ev, output: text("output", ev.output, limits.text, true) }, cut };
    case "tool.call": {
      const title = text("title", ev.title, limits.line);
      let json: string | undefined;
      try {
        json = JSON.stringify(ev.input);
      } catch {
        json = undefined;
      }
      if (json === undefined || utf8Length(json) <= limits.input) return { event: { ...ev, title }, cut };
      const bytes = utf8Length(json);
      cut.push({ field: "input", bytes, binary: false });
      return { event: { ...ev, title, input: { truncated: true, bytes, preview: capText(json, limits.line).text } }, cut };
    }
    case "request.approval":
      return { event: { ...ev, command: ev.command === null ? null : text("command", ev.command, limits.line), paths: list("paths", ev.paths) }, cut };
    case "request.question":
      return {
        event: {
          ...ev,
          questions: list("questions", ev.questions).map((q, i) => ({
            ...q,
            prompt: text(`questions.${i}.prompt`, q.prompt, limits.line),
            options: list(`questions.${i}.options`, q.options).map((o) => ({
              ...o,
              label: text("option", o.label, limits.line),
              ...(o.description === undefined ? {} : { description: text("option", o.description, limits.line) }),
            })),
          })),
        },
        cut,
      };
    case "plan.update":
      return { event: { ...ev, steps: list("steps", ev.steps).map((s) => ({ ...s, title: text("step", s.title, limits.line) })) }, cut };
    case "diff.update":
      return { event: { ...ev, files: list("files", ev.files) }, cut };
    case "run.state":
    case "run.ended":
      return { event: ev.detail === undefined ? ev : { ...ev, detail: text("detail", ev.detail, limits.line) }, cut };
    default:
      return { event: ev, cut };
  }
}
