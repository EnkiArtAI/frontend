import type { Metadata } from "next";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import GeneratorClient from "./GeneratorClient";

/**
 * Server shell for the standalone prompt page: it exists to put REAL Open
 * Graph / Twitter metadata in the <head>, so a pasted /generator/<id> link
 * unfurls on X, Discord, Telegram or Slack with the prompt's showcase
 * images instead of a blank card (Kev, 2026-09-05). The card image is a
 * server-rendered grid of up to four showcase renders (/api/og/[id]); the
 * proxy lets link-preview bots read this head without the team cookie.
 * Everything interactive stays in GeneratorClient.
 */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  let title = "Enki Art";
  let description = "AI art prompts as tradeable IP — generate with the artist's prompt, pay per image.";
  try {
    const { data: p } = await getSupabaseServerClient()
      .from("prompts")
      .select("title, description, public_prompt_text, is_free_showcase, price_usd_cents")
      .eq("id", id)
      .eq("is_adult", false) // link previews are public: 18+ gets the brand card
      .maybeSingle();
    if (p?.title) {
      title = `${p.title} · Enki Art`;
      const free = p.is_free_showcase === true || (p.price_usd_cents ?? 0) === 0;
      const lead = String(p.description || p.public_prompt_text || "").trim().slice(0, 160);
      description = `${free ? "Free prompt" : `$${((p.price_usd_cents ?? 0) / 100).toFixed(2)} per generation`}${lead ? ` — ${lead}` : ""}`;
    }
  } catch {
    /* metadata falls back to the brand card; the page itself still loads */
  }
  const og = `/api/og/${encodeURIComponent(id)}`;
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: "website",
      url: `/generator/${encodeURIComponent(id)}`,
      images: [{ url: og, width: 1200, height: 630, alt: title }],
    },
    twitter: { card: "summary_large_image", title, description, images: [og] },
  };
}

export default function GeneratorPage() {
  return <GeneratorClient />;
}
