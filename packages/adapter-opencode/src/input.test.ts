import { pathToFileURL } from "node:url";
import type { Attachment } from "@crewyard/core";
import { describe, expect, it } from "vitest";
import { openCodeParts } from "./input.ts";

const at = (kind: Attachment["kind"], name: string, mime: string): Attachment => ({ id: name, kind, name, mime, bytes: 5, path: `C:\\Crewyard data\\tasks\\t\\attachments\\${name}\\${name}` });

describe("openCodeParts", () => {
  it("sends a text part, then a file part with a file URL per attachment", () => {
    const image = at("image", "shot one.png", "image/png");
    const pdf = at("file", "spec.pdf", "application/pdf");
    expect(openCodeParts("look", [image, pdf])).toEqual([
      { type: "text", text: "look" },
      { type: "file", mime: "image/png", filename: "shot one.png", url: pathToFileURL(image.path).href },
      { type: "file", mime: "application/pdf", filename: "spec.pdf", url: pathToFileURL(pdf.path).href },
    ]);
    expect(pathToFileURL(image.path).href).toContain("shot%20one.png");
  });

  it("sends text files as text/plain, which OpenCode reads through its Read tool", () => {
    const parts = openCodeParts("x", [at("file", "notes.md", "text/markdown"), at("file", "data.json", "application/json")]);
    expect(parts.slice(1).map((p) => ("mime" in p ? p.mime : null))).toEqual(["text/plain", "text/plain"]);
  });

  it("sends only the text part when nothing is attached", () => {
    expect(openCodeParts("hello")).toEqual([{ type: "text", text: "hello" }]);
  });
});
