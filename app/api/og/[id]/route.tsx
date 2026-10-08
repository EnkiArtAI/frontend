import { ImageResponse } from "next/og";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { aspectOf, gridFor } from "@/lib/og-grid";
import { isListed } from "@/lib/prompt-visibility";
import { hiddenOwners } from "@/lib/hidden-owners";

/**
 * Social preview card for a prompt — the image X, Discord, Telegram, Slack
 * show when a /generator/<id> link is pasted (Kev, 2026-09-05: "the preview
 * of the 1-4 images presentiert wird die man mit dem prompt erstellen
 * kann"). One card carries up to FOUR showcase images as a grid: platforms
 * render a single og:image, so the grid is how four pictures fit one slot.
 * Public by design — a crawler has no session; the proxy allowlists it.
 */
export const runtime = "nodejs";

const W = 1200;
const H = 630;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // The card must ALWAYS render: a database blip (or a deleted prompt) shows
  // the brand card rather than a broken unfurl on someone's timeline.
  type Row = { title?: string | null; showcase_images?: unknown; price_usd_cents?: number | null; is_free_showcase?: boolean | null; creator_id?: string | null; aspect_ratio?: string | null; is_listed?: boolean | null; listing_status?: string | null; deleted_at?: string | null };
  let p: Row | null = null;
  let handle: string | null = null;
  try {
    const supabase = getSupabaseServerClient();
    const { data } = await supabase
      .from("prompts")
      .select("title, showcase_images, price_usd_cents, is_free_showcase, creator_id, aspect_ratio, is_listed, listing_status, deleted_at")
      .eq("id", id)
      .eq("is_adult", false) // link previews are public: 18+ gets the brand card
      .maybeSingle();
    // Only a live prompt gets its own card. A draft's title can be the first
    // words of a prompt nobody else should read, and its images are private.
    const row = (data as Row | null) ?? null;
    p = row && isListed(row) ? row : null;
    // A banned or deleted creator's prompt gets the brand card, as does a failed lookup.
    if (p) {
      const hidden = await hiddenOwners(supabase, [String(p.creator_id ?? "")]);
      if (!hidden || hidden.has(String(p.creator_id))) p = null;
    }
    if (p?.creator_id) {
      const { data: u } = await supabase.from("users").select("handle").eq("id", p.creator_id).maybeSingle();
      handle = (u?.handle as string | undefined) ?? null;
    }
  } catch (e) {
    console.warn("[og] prompt lookup failed, serving brand card:", e instanceof Error ? e.message : e);
  }

  const images: string[] = Array.isArray(p?.showcase_images)
    ? (p!.showcase_images as unknown[]).filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u)).slice(0, 4)
    : [];
  const title = String(p?.title ?? "Enki Art");
  const free = p?.is_free_showcase === true || (p?.price_usd_cents ?? 0) === 0;
  const priceLabel = free ? "Free prompt" : `$${((p?.price_usd_cents ?? 0) / 100).toFixed(2)} per generation`;

  /* Layout follows the renders' shape (Kev, 2026-09-05): portrait prompts
     put their images side by side, square/landscape ones tile 2×2 — the
     rule lives in lib/og-grid.ts with its own tests. */
  const cells = gridFor(images.length, aspectOf(p?.aspect_ratio), W, H - 96);

  return new ImageResponse(
    (
      <div style={{ width: W, height: H, display: "flex", flexDirection: "column", background: "#0a1825", color: "#e4edf1", fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", position: "relative", width: W, height: H - 96 }}>
          {images.length === 0 ? (
            <div style={{ width: W, height: H - 96, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 44, color: "#6a8493" }}>
              Enki Art
            </div>
          ) : (
            images.map((src, i) => {
              const c = cells[i];
              return (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={i} src={src} alt="" width={c.w} height={c.h}
                  style={{ position: "absolute", left: c.x, top: c.y, width: c.w, height: c.h, objectFit: "cover" }} />
              );
            })
          )}
        </div>
        <div style={{ height: 96, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 40px", borderTop: "1px solid #1e3849" }}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 34, fontWeight: 700, maxWidth: 820, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{title}</div>
            {/* ONE text child: Satori refuses multi-child nodes without display:flex. */}
            <div style={{ fontSize: 20, color: "#97aebb" }}>{`${handle ? `by ${handle} · ` : ""}${priceLabel}`}</div>
          </div>
          <div style={{ fontSize: 26, fontWeight: 700, color: "#cba24a", letterSpacing: 2 }}>ENKI ART</div>
        </div>
      </div>
    ),
    {
      width: W,
      height: H,
      headers: { "Cache-Control": "public, max-age=3600, s-maxage=86400" },
    },
  );
}
