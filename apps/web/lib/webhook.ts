import { createHmac, timingSafeEqual } from "node:crypto";

// GitHub release webhooks (optional): a repository webhook for "Releases" events, sent to
// /api/revalidate with the secret in GITHUB_WEBHOOK_SECRET, makes a new release show up at once
// instead of within the hour. GitHub signs the raw body with HMAC-SHA256 in X-Hub-Signature-256.

/** True only for a well-formed signature that matches the body under the secret. */
export function verifySignature(secret: string, body: string, header: string | null): boolean {
  if (!secret || !header) return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!m) return false;
  const expected = createHmac("sha256", secret).update(body, "utf8").digest();
  const given = Buffer.from(m[1]!, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Release actions that change what the site lists. */
const ACTIONS = new Set(["published", "unpublished", "created", "edited", "deleted", "prereleased", "released"]);

export type WebhookOutcome = { status: number; revalidate: boolean; message: string };

/** What to do with one delivery; the route does the HTTP and the revalidation. */
export function handleDelivery(input: { secret: string | undefined; event: string | null; signature: string | null; body: string }): WebhookOutcome {
  // Without a secret the endpoint does not exist, so it cannot be used to churn the cache.
  if (!input.secret) return { status: 404, revalidate: false, message: "Not found" };
  if (!verifySignature(input.secret, input.body, input.signature)) return { status: 401, revalidate: false, message: "Bad signature" };
  if (input.event === "ping") return { status: 200, revalidate: false, message: "pong" };
  if (input.event !== "release") return { status: 202, revalidate: false, message: "Ignored event" };
  let action: unknown;
  try {
    action = (JSON.parse(input.body) as { action?: unknown }).action;
  } catch {
    return { status: 400, revalidate: false, message: "Body is not JSON" };
  }
  if (typeof action !== "string" || !ACTIONS.has(action)) return { status: 202, revalidate: false, message: "Ignored action" };
  return { status: 200, revalidate: true, message: `Revalidated after ${action}` };
}
