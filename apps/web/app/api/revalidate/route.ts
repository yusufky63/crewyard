import { revalidateTag } from "next/cache";
import { RELEASES_TAG } from "@/lib/github";
import { handleDelivery } from "@/lib/webhook";

// GitHub's release webhook lands here (optional; lib/webhook.ts and apps/web/README.md). Without it
// the site still picks up a new release within the hour.

const MAX_BODY = 1_000_000;

export async function POST(request: Request): Promise<Response> {
  const body = await request.text();
  if (body.length > MAX_BODY) return new Response("Payload too large", { status: 413 });
  const outcome = handleDelivery({
    secret: process.env.GITHUB_WEBHOOK_SECRET?.trim(),
    event: request.headers.get("x-github-event"),
    signature: request.headers.get("x-hub-signature-256"),
    body,
  });
  // Expire at once: the next visit fetches the new release list instead of serving the old one.
  if (outcome.revalidate) revalidateTag(RELEASES_TAG, { expire: 0 });
  return new Response(outcome.message, { status: outcome.status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}
