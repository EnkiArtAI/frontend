/**
 * A picked NFT's image, as bytes for a reference image.
 *
 *   GET ?src=<the image address the list named> → one still WebP, at most 1024 px
 *
 * The browser cannot read most NFT images itself: the hosts they name are
 * often gone, throttled or send no CORS header. So this reads the image on
 * the server, through the Helius CDN, and the browser only ever asks its own
 * site.
 *
 * Why this is no open door into our network: this server fetches
 * cdn.helius-rpc.com only, a host fixed in code, with redirects refused; the
 * address after it is fetched by the CDN, on Helius's network, never ours.
 * The address is the client's to name, as any image is a user's to upload:
 * what comes back is judged by its bytes like an upload when it is used
 * (app/api/generate-image), and no index call is made, so a pick costs no
 * credits.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserId } from "@/lib/session-user";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { cdnImage, FULL, httpSource, readCapped } from "@/lib/wallet-nfts";

/** The types every model takes. The CDN passes an SVG through unchanged, and an error page is no image. */
const TAKEN = new Set(["image/jpeg", "image/png", "image/webp"]);
/** A 1024 px WebP weighs a few hundred KB; anything near the 4.5 MB a function may answer is not one. */
const MAX_BYTES = 3 * 1024 * 1024;

export async function GET(req: NextRequest) {
  const supabase = getSupabaseServerClient();
  const userId = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  // Two full picks for the model that takes the most (16) fit in a minute.
  const limit = checkRequestRateLimit(rateLimitKey(req, "nfts:image", userId), 40, 60_000);
  if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

  const source = httpSource(req.nextUrl.searchParams.get("src") ?? undefined);
  if (!source) return NextResponse.json({ error: "Bad request" }, { status: 400 });

  // Inside the 20 s the browser waits.
  const signal = AbortSignal.any([req.signal, AbortSignal.timeout(15_000)]);
  const res = await fetch(cdnImage(source, FULL), { redirect: "error", signal }).catch(() => null);
  const type = res?.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
  const bytes = res?.ok && TAKEN.has(type) ? await readCapped(res, MAX_BYTES).catch(() => null) : null;
  if (!bytes) return NextResponse.json({ error: "This NFT's image could not be loaded" }, { status: 502 });
  return new NextResponse(bytes, {
    headers: { "Content-Type": type, "Cache-Control": "private, max-age=3600", Vary: "X-Session-Token" },
  });
}
