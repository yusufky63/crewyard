import { describe, expect, it } from "vitest";
import type { AgentCapabilities } from "./adapter.ts";
import { attachControls, ATTACHMENT_ACCEPT, classifyAttachment, cleanAttachmentName, toUserInput, withAttachments, type Attachment } from "./attachments.ts";

const fake: AgentCapabilities = { launch: true, stream: true, answerQuestions: true, approveTools: true, interrupt: true, resume: true, setModel: true, usage: true, reportedLimits: false, readOnlyMode: true, attachments: { images: true, files: true } };
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const WEBP = Uint8Array.from([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBPVP8 ")]);
const PDF = Uint8Array.from(Buffer.from("%PDF-1.7\n"));
const text = (s: string) => Uint8Array.from(Buffer.from(s, "utf8"));

describe("classifyAttachment", () => {
  it("takes images and PDFs by their signature, whatever the name says", () => {
    expect(classifyAttachment("shot.png", PNG)).toEqual({ kind: "image", mime: "image/png" });
    expect(classifyAttachment("clipboard", JPEG)).toEqual({ kind: "image", mime: "image/jpeg" });
    expect(classifyAttachment("a.webp", WEBP)).toEqual({ kind: "image", mime: "image/webp" });
    expect(classifyAttachment("spec.pdf", PDF)).toEqual({ kind: "file", mime: "application/pdf" });
  });

  it("refuses a file named as an image or PDF without the signature (a renamed executable)", () => {
    const exe = text("MZ\u0090\u0000\u0003");
    expect(classifyAttachment("cat.png", exe)).toEqual({ problem: "attachment.type" });
    expect(classifyAttachment("spec.pdf", exe)).toEqual({ problem: "attachment.type" });
    expect(classifyAttachment("tool.exe", exe)).toEqual({ problem: "attachment.type" });
  });

  it("takes text files by extension only when the content is text", () => {
    expect(classifyAttachment("build.log", text("error: x\r\n\tat y"))).toEqual({ kind: "file", mime: "text/plain" });
    expect(classifyAttachment("notes.md", text("# Ünlü başlık"))).toEqual({ kind: "file", mime: "text/markdown" });
    expect(classifyAttachment("data.json", Uint8Array.from([0x7b, 0, 0x7d]))).toEqual({ problem: "attachment.type" });
    expect(classifyAttachment("README", text("hello"))).toEqual({ problem: "attachment.type" });
    expect(classifyAttachment("empty.txt", new Uint8Array())).toEqual({ problem: "attachment.empty" });
  });

  it("lists every extension it takes for the file picker", () => {
    expect(ATTACHMENT_ACCEPT.split(",")).toEqual(expect.arrayContaining([".png", ".jpg", ".pdf", ".txt", ".md", ".log"]));
  });
});

describe("cleanAttachmentName", () => {
  it("keeps the last path part and drops characters Windows refuses", () => {
    expect(cleanAttachmentName("C:\\Users\\me\\Screen shot: 1?.png")).toBe("Screen shot_ 1_.png");
    expect(cleanAttachmentName("../../etc/passwd")).toBe("passwd");
    expect(cleanAttachmentName("CON.txt")).toBe("_CON.txt");
    expect(cleanAttachmentName("...")).toBe("attachment");
  });

  it("shortens a long name but keeps its extension", () => {
    const long = cleanAttachmentName(`${"a".repeat(300)}.png`);
    expect(long).toHaveLength(120);
    expect(long.endsWith(".png")).toBe(true);
  });
});

describe("withAttachments", () => {
  const image: Attachment = { id: "i", kind: "image", name: "shot.png", mime: "image/png", bytes: 10, path: "C:\\data dir\\tasks\\t\\attachments\\i\\shot.png" };
  const pdf: Attachment = { id: "p", kind: "file", name: "spec.pdf", mime: "application/pdf", bytes: 20, path: "C:\\data dir\\tasks\\t\\attachments\\p\\spec.pdf" };

  it("leaves a message with nothing attached as it is", () => {
    expect(withAttachments("hello", [], fake)).toEqual({ kind: "text", text: "hello" });
  });

  it("passes the kinds the runner takes and names every attachment with its path in the text", () => {
    const input = withAttachments("Fix the layout", [image, pdf], { ...fake, attachments: { images: true, files: false } });
    expect(input.attachments).toEqual([image]);
    expect(input.text).toContain("Fix the layout\n\nAttachments from the user:");
    expect(input.text).toContain(`- shot.png (image/png, attached to this message; a copy is at ${image.path})`);
    expect(input.text).toContain(`- spec.pdf (application/pdf; read it from ${pdf.path})`);
  });

  it("gives a runner without attachment support only paths, and a message with no text only the list", () => {
    const input = withAttachments("  ", [image], { ...fake, attachments: undefined });
    expect(input.attachments).toBeUndefined();
    expect(input.text.startsWith("Attachments from the user:")).toBe(true);
  });

  it("turns plain text from nextTurn into an input", () => {
    expect(toUserInput("next")).toEqual({ kind: "text", text: "next" });
    expect(toUserInput({ kind: "text", text: "x", attachments: [image] }).attachments).toEqual([image]);
  });
});

describe("attachControls", () => {
  it("disables a kind with the reason when the runner cannot take it", () => {
    expect(attachControls({ ...fake, attachments: { images: true, files: false } })).toEqual({ image: { ok: true, reason: null }, file: { ok: false, reason: "attach.file_unsupported" } });
    expect(attachControls(undefined).image).toEqual({ ok: false, reason: "attach.image_unsupported" });
  });
});
