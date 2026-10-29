import type { Options, PermissionResult, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFn } from "./adapter.ts";
import { errorResult } from "./fixtures.ts";

// Stands in for the SDK's query() in replay tests: plays recorded frames per user turn and
// calls the adapter's canUseTool where the real CLI would. Like the CLI, it exits only when
// its input ends.

export type Step =
  | SDKMessage
  | { ask: { tool: string; input: Record<string, unknown>; id: string } }
  /** Waits until interrupt() and then ends the turn the way the CLI does after an abort. */
  | { block: true }
  | { spawn: { pid: number } }
  | { fail: string };

export interface Recorded {
  options: Options | null;
  prompts: SDKUserMessage[];
  decisions: Array<{ tool: string; result: PermissionResult }>;
  models: string[];
  interrupts: number;
  closed: boolean;
}

export function fakeQuery(turns: Step[][]): { query: QueryFn; rec: Recorded } {
  const rec: Recorded = { options: null, prompts: [], decisions: [], models: [], interrupts: 0, closed: false };
  const query: QueryFn = ({ prompt, options }) => {
    rec.options = options;
    let wakeInterrupt: (() => void) | null = null;
    let interrupted = false;
    let wakeClose: (() => void) | null = null;
    const closed = new Promise<void>((r) => (wakeClose = r));
    const input = prompt[Symbol.asyncIterator]();

    async function* play(): AsyncGenerator<SDKMessage, void> {
      for (const turn of turns) {
        const next = await Promise.race([input.next(), closed.then(() => null)]);
        if (!next || next.done) return;
        rec.prompts.push(next.value);
        for (const step of turn) {
          if (rec.closed) return;
          if ("ask" in step) {
            const ac = new AbortController();
            const result = await options.canUseTool!(step.ask.tool, step.ask.input, { signal: ac.signal, toolUseID: step.ask.id, requestId: `req-${step.ask.id}`, suggestions: [{ type: "addRules", rules: [{ toolName: step.ask.tool }], behavior: "allow", destination: "localSettings" }] });
            if (result) rec.decisions.push({ tool: step.ask.tool, result });
          } else if ("block" in step) {
            if (!interrupted) await Promise.race([new Promise<void>((r) => (wakeInterrupt = r)), closed]);
            if (rec.closed) return;
            yield errorResult("error_during_execution", { terminal_reason: "aborted_streaming" });
          } else if ("spawn" in step) {
            options.spawnClaudeCodeProcess!({ command: "claude.exe", args: [], cwd: options.cwd, env: options.env ?? {}, signal: new AbortController().signal });
          } else if ("fail" in step) {
            throw new Error(step.fail);
          } else yield step;
        }
      }
      // The CLI stays alive until stdin closes.
      await Promise.race([input.next(), closed]);
    }

    const gen = play();
    return Object.assign(gen, {
      interrupt: async () => {
        rec.interrupts++;
        interrupted = true;
        wakeInterrupt?.();
        return undefined;
      },
      setModel: async (m?: string) => void rec.models.push(m ?? ""),
      close: () => {
        rec.closed = true;
        wakeClose?.();
      },
    }) as unknown as Query;
  };
  return { query, rec };
}
