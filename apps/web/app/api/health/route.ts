import { getReleases } from "@/lib/github";
import { health } from "@/lib/health";

// A monitor polls this. It reads releases through the same cached fetch the pages use, so "ok" means
// the pages have release data; a failed GitHub call is never cached, so a failure shows at once.
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const h = health(await getReleases());
  return Response.json(
    { ...h, checkedAt: new Date().toISOString() },
    { status: h.status === "down" ? 503 : 200, headers: { "cache-control": "no-store" } },
  );
}
