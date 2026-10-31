import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { handleDelivery, verifySignature } from "./webhook.ts";

const SECRET = "test-secret-for-unit-tests";
const sign = (body: string, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const body = JSON.stringify({ action: "published", release: { tag_name: "v0.2.0" } });

describe("verifySignature", () => {
  it("accepts GitHub's signature of the exact body", () => {
    expect(verifySignature(SECRET, body, sign(body))).toBe(true);
  });

  it("refuses another secret, another body, a malformed header or none", () => {
    expect(verifySignature(SECRET, body, sign(body, "other"))).toBe(false);
    expect(verifySignature(SECRET, `${body} `, sign(body))).toBe(false);
    expect(verifySignature(SECRET, body, "sha1=abc")).toBe(false);
    expect(verifySignature(SECRET, body, "sha256=zz")).toBe(false);
    expect(verifySignature(SECRET, body, null)).toBe(false);
    expect(verifySignature("", body, sign(body, ""))).toBe(false);
  });
});

describe("handleDelivery", () => {
  const deliver = (over: Partial<Parameters<typeof handleDelivery>[0]> = {}) => handleDelivery({ secret: SECRET, event: "release", signature: sign(body), body, ...over });

  it("revalidates on a signed release event", () => {
    expect(deliver()).toEqual({ status: 200, revalidate: true, message: "Revalidated after published" });
  });

  it("does not exist without a secret and refuses an unsigned call", () => {
    expect(deliver({ secret: undefined })).toMatchObject({ status: 404, revalidate: false });
    expect(deliver({ signature: null })).toMatchObject({ status: 401, revalidate: false });
  });

  it("answers ping and ignores other events and actions", () => {
    expect(deliver({ event: "ping" })).toMatchObject({ status: 200, revalidate: false });
    expect(deliver({ event: "push" })).toMatchObject({ status: 202, revalidate: false });
    const other = JSON.stringify({ action: "something-else" });
    expect(deliver({ body: other, signature: sign(other) })).toMatchObject({ status: 202, revalidate: false });
  });

  it("refuses a signed body that is not JSON", () => {
    expect(deliver({ body: "nope", signature: sign("nope") })).toMatchObject({ status: 400, revalidate: false });
  });
});
