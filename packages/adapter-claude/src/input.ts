import { readFileSync } from "node:fs";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { isTextAttachment, type Attachment } from "@crewyard/core";

// A user message's content for the Agent SDK's streaming input (agent-sdk/streaming-vs-single-mode):
// plain text when nothing is attached, otherwise a text block followed by an `image` block per
// image (base64 source) and a `document` block per file, base64 for a PDF and a text source for
// text files, titled with the file name. Images and PDFs are documented Messages API inputs.

export type ClaudeContent = SDKUserMessage["message"]["content"];

export function claudeContent(text: string, attachments: readonly Attachment[] = [], read: (path: string) => Buffer = (p) => readFileSync(p)): ClaudeContent {
  if (attachments.length === 0) return text;
  const blocks = attachments.map((a) => {
    const data = read(a.path);
    if (a.kind === "image") return { type: "image" as const, source: { type: "base64" as const, media_type: a.mime as "image/png" | "image/jpeg" | "image/gif" | "image/webp", data: data.toString("base64") } };
    if (isTextAttachment(a)) return { type: "document" as const, title: a.name, source: { type: "text" as const, media_type: "text/plain" as const, data: data.toString("utf8") } };
    return { type: "document" as const, title: a.name, source: { type: "base64" as const, media_type: "application/pdf" as const, data: data.toString("base64") } };
  });
  return [{ type: "text" as const, text }, ...blocks];
}
