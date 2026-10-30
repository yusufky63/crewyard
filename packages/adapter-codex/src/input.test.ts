import type { Attachment } from "@crewyard/core";
import { describe, expect, it } from "vitest";
import { codexInput } from "./input.ts";

const image: Attachment = { id: "i", kind: "image", name: "shot one.png", mime: "image/png", bytes: 10, path: "C:\\Crewyard data\\tasks\\t\\attachments\\i\\shot one.png" };
const pdf: Attachment = { id: "p", kind: "file", name: "spec.pdf", mime: "application/pdf", bytes: 20, path: "C:\\Crewyard data\\tasks\\t\\attachments\\p\\spec.pdf" };

describe("codexInput", () => {
  it("sends text alone when nothing is attached", () => {
    expect(codexInput("hello")).toEqual([{ type: "text", text: "hello", text_elements: [] }]);
  });

  it("adds each image as a localImage by path, and never a file codex has no input for", () => {
    expect(codexInput("look", [image, pdf])).toEqual([
      { type: "text", text: "look", text_elements: [] },
      { type: "localImage", path: image.path },
    ]);
  });
});
