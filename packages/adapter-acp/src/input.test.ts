import { pathToFileURL } from "node:url";
import type { Attachment } from "@crewyard/core";
import { describe, expect, it } from "vitest";
import { acpPrompt } from "./input.ts";

const image: Attachment = { id: "i", kind: "image", name: "shot.png", mime: "image/png", bytes: 4, path: "C:\\Crewyard data\\shot.png" };
const log: Attachment = { id: "l", kind: "file", name: "build.log", mime: "text/plain", bytes: 6, path: "C:\\Crewyard data\\build.log" };
const pdf: Attachment = { id: "p", kind: "file", name: "spec.pdf", mime: "application/pdf", bytes: 8, path: "C:\\Crewyard data\\spec.pdf" };
const files: Record<string, Buffer> = { [image.path]: Buffer.from([1, 2, 3, 4]), [log.path]: Buffer.from("error\n"), [pdf.path]: Buffer.from("%PDF-1.7") };
const read = (p: string) => files[p]!;
const uri = (a: Attachment) => pathToFileURL(a.path).href;

describe("acpPrompt", () => {
  it("sends image and embedded resource blocks only to an agent that advertised them", () => {
    expect(acpPrompt("look", [image, log, pdf], { image: true, embeddedContext: true }, read)).toEqual([
      { type: "text", text: "look" },
      { type: "image", data: "AQIDBA==", mimeType: "image/png", uri: uri(image) },
      { type: "resource", resource: { uri: uri(log), mimeType: "text/plain", text: "error\n" } },
      { type: "resource", resource: { uri: uri(pdf), mimeType: "application/pdf", blob: files[pdf.path]!.toString("base64") } },
    ]);
  });

  it("falls back to resource links, which every agent must accept, and reads no file for them", () => {
    const none = (): Buffer => {
      throw new Error("must not read");
    };
    expect(acpPrompt("look", [image, pdf], {}, none)).toEqual([
      { type: "text", text: "look" },
      { type: "resource_link", uri: uri(image), name: "shot.png", mimeType: "image/png", size: 4 },
      { type: "resource_link", uri: uri(pdf), name: "spec.pdf", mimeType: "application/pdf", size: 8 },
    ]);
    // With only embeddedContext on, an image goes embedded as a blob.
    expect(acpPrompt("x", [image], { embeddedContext: true }, read)[1]).toEqual({ type: "resource", resource: { uri: uri(image), mimeType: "image/png", blob: "AQIDBA==" } });
  });

  it("sends the text alone when nothing is attached", () => {
    expect(acpPrompt("hello", [], null)).toEqual([{ type: "text", text: "hello" }]);
  });
});
