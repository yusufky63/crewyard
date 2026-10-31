import { pathToFileURL } from "node:url";
import { isTextAttachment, type Attachment } from "@crewyard/core";
import type { FilePartInput, TextPartInput } from "@opencode-ai/sdk/v2";

// session.promptAsync parts (FilePartInput in @opencode-ai/sdk 1.19.5): the text, then one `file`
// part per attachment with a file:// URL to our copy. OpenCode reads it itself: a `text/plain`
// part goes through its Read tool, an image or PDF is loaded as media (session/prompt.ts, `file:`
// case), so text files are sent as text/plain whatever their own type is.

export function openCodeParts(text: string, attachments: readonly Attachment[] = []): Array<TextPartInput | FilePartInput> {
  return [{ type: "text", text }, ...attachments.map((a): FilePartInput => ({ type: "file", mime: isTextAttachment(a) ? "text/plain" : a.mime, filename: a.name, url: pathToFileURL(a.path).href }))];
}
