import type { Attachment } from "@crewyard/core";
import { describe, expect, it } from "vitest";
import { claudeContent } from "./input.ts";

const at = (kind: Attachment["kind"], name: string, mime: string): Attachment => ({ id: name, kind, name, mime, bytes: 5, path: `C:\\Crewyard data\\${name}` });
const files: Record<string, Buffer> = {
  "C:\\Crewyard data\\shot.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  "C:\\Crewyard data\\spec.pdf": Buffer.from("%PDF-1.7"),
  "C:\\Crewyard data\\build.log": Buffer.from("error: Ünlü\n"),
};
const read = (p: string) => files[p]!;

describe("claudeContent", () => {
  it("keeps a plain string when nothing is attached", () => {
    expect(claudeContent("hello", [], read)).toBe("hello");
  });

  it("adds an image block per image and a document block per file, titled with its name", () => {
    expect(claudeContent("look", [at("image", "shot.png", "image/png"), at("file", "spec.pdf", "application/pdf"), at("file", "build.log", "text/plain")], read)).toEqual([
      { type: "text", text: "look" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: files["C:\\Crewyard data\\shot.png"]!.toString("base64") } },
      { type: "document", title: "spec.pdf", source: { type: "base64", media_type: "application/pdf", data: files["C:\\Crewyard data\\spec.pdf"]!.toString("base64") } },
      { type: "document", title: "build.log", source: { type: "text", media_type: "text/plain", data: "error: Ünlü\n" } },
    ]);
  });
});
