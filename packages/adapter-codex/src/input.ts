import type { Attachment } from "@crewyard/core";
import type { UserInput as CodexUserInput } from "./protocol/index.ts";

// turn/start and turn/steer input items (UserInput in codex-cli 0.147.0): the text, then each
// image as `localImage` by path, which codex reads itself, so no bytes cross the pipe. codex
// documents no input item that carries a file's content (`mention` is a named resource reference
// whose handling we have not verified), so capabilities claim images only and the daemon lists
// files in the text as paths to read.

export function codexInput(text: string, attachments: readonly Attachment[] = []): CodexUserInput[] {
  return [{ type: "text", text, text_elements: [] }, ...attachments.filter((a) => a.kind === "image").map((a): CodexUserInput => ({ type: "localImage", path: a.path }))];
}
