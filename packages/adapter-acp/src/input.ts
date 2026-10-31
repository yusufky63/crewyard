import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type * as acp from "@agentclientprotocol/sdk";
import { isTextAttachment, type Attachment } from "@crewyard/core";

// session/prompt content (agentclientprotocol.com/protocol/content): the text, then each
// attachment in the richest form the agent advertised in initialize `promptCapabilities`. An
// `image` block needs `image`, an embedded `resource` needs `embeddedContext`; a `resource_link`
// to our copy is the baseline every agent must accept, so nothing is ever sent that the agent
// did not ask for, and nothing is dropped either.

export function acpPrompt(text: string, attachments: readonly Attachment[] = [], caps: acp.PromptCapabilities | null | undefined = null, read: (path: string) => Buffer = (p) => readFileSync(p)): acp.ContentBlock[] {
  return [{ type: "text", text }, ...attachments.map((a) => block(a, caps ?? {}, read))];
}

function block(a: Attachment, caps: acp.PromptCapabilities, read: (path: string) => Buffer): acp.ContentBlock {
  const uri = pathToFileURL(a.path).href;
  if (a.kind === "image" && caps.image) return { type: "image", data: read(a.path).toString("base64"), mimeType: a.mime, uri };
  if (caps.embeddedContext) {
    const data = read(a.path);
    return { type: "resource", resource: isTextAttachment(a) ? { uri, mimeType: a.mime, text: data.toString("utf8") } : { uri, mimeType: a.mime, blob: data.toString("base64") } };
  }
  return { type: "resource_link", uri, name: a.name, mimeType: a.mime, size: a.bytes };
}
