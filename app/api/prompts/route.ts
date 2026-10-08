import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { hiddenOwners } from "@/lib/hidden-owners";

type VariableSummary = {
  id: string;
  name: string;
  label: string;
  type: string;
  position: number;
};

type PromptListItem = {
  id: string;
  _id: string;
  title: string;
  type: string;
  isFree: boolean;
  isFreeShowcase: boolean;
  price: number;
  category?: string;
  tags?: string[];
  aiModel?: string;
  createdAt?: string;
  downloads: number;
  rating: number;
  likes: number;
  creatorId?: string;
  thumbnail: string;
  imageUrl: string;
  publicPromptText?: string;
  variables: VariableSummary[];
};

/*
 * ── Live-schema boundary (probed against the live DB, 2026-08-12) ─────────
 *
 * prompts carries creator_id, price_usd_cents (integer cents) and
 * showcase_images (jsonb array of URL strings). The columns this route used
 * to select — user_id, price, uploaded_photos, downloads, rating — are all
 * PostgREST 400s, which failed the whole select and made the showcase answer
 * { items: [] } forever. downloads/rating have no live replacement
 * (engagement is a separate concern), so they stay constant 0 in the shape
 * the grid already defaults. Variables live in prompt_variables (the bare
 * `variables` table is a 404); data_type is the DB enum, mapped back to the
 * client's hyphenated vocabulary here.
 */
const VAR_TYPE_FROM_DB: Record<string, string> = {
  reference_image: "image",
  multi_select: "multi-select",
  single_select: "single-select",
};

// DB prompt_type values: create-now | showcase | free | paid.
const FREE_TYPES = new Set(["showcase", "free"]);

function deriveThumbnail(showcaseImages: unknown): string {
  if (Array.isArray(showcaseImages) && typeof showcaseImages[0] === "string") {
    return showcaseImages[0] as string;
  }
  return "";
}

export async function GET(request: NextRequest) {
  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      console.warn("⚠️  Supabase not configured - returning empty prompts list");
      return NextResponse.json({ items: [], nextCursor: null });
    }

    const { searchParams } = new URL(request.url);
    const limit = Math.min(
      Math.max(parseInt(searchParams.get("limit") || "12", 10) || 12, 1),
      50
    );
    const offset = parseInt(searchParams.get("cursor") || "0", 10) || 0;

    const supabase = getSupabaseServerClient();

    const { data: rows, error } = await supabase
      .from("prompts")
      .select(
        "id,title,prompt_type,is_free_showcase,public_prompt_text,price_usd_cents,category,tags,ai_model,created_at,creator_id,showcase_images"
      )
      // Only what the artist actually released. Neither list route filtered on
      // visibility, so the first prompt ever saved (2026-08-12, still
      // listing_status 'draft') showed up here immediately — an artist's
      // unfinished work, public to every beta user, listed as if for sale.
      .eq("is_listed", true)
      // No 18+ pill on this list, so it always shows the safe view.
      .eq("is_adult", false)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      console.error("Supabase prompts list error:", error);
      throw error;
    }

    const pageRows = Array.isArray(rows) ? rows : [];
    // A banned or deleted creator's prompts leave this list too.
    const hidden = await hiddenOwners(supabase, pageRows.map((p) => String(p.creator_id ?? "")));
    if (!hidden) throw new Error("creators could not be read");
    const promptRows = pageRows.filter((p) => !hidden.has(String(p.creator_id)));
    const promptIds = promptRows.map((p) => String(p.id));

    let variablesByPrompt = new Map<string, VariableSummary[]>();
    if (promptIds.length > 0) {
      const { data: vars, error: varsError } = await supabase
        .from("prompt_variables")
        .select("id,prompt_id,name,label,data_type,position")
        .in("prompt_id", promptIds)
        .is("deleted_at", null)
        .order("position", { ascending: true });

      if (varsError) {
        console.warn("Supabase variables fetch error (non-fatal):", varsError);
      } else if (Array.isArray(vars)) {
        for (const v of vars) {
          const key = String(v.prompt_id);
          const list = variablesByPrompt.get(key) ?? [];
          const dbType = String(v.data_type ?? "text");
          list.push({
            id: String(v.id ?? ""),
            name: String(v.name ?? ""),
            label: String(v.label ?? v.name ?? ""),
            type: VAR_TYPE_FROM_DB[dbType] ?? dbType,
            position: typeof v.position === "number" ? v.position : 0,
          });
          variablesByPrompt.set(key, list);
        }
      }
    }

    /* Engagement for the page in two IN-queries, aggregated here: real
       numbers on every card instead of the constant 0 the shape used to
       carry (ratings from prompt_comments, likes from reactions — both
       degrade to empty when a table is missing). */
    const pageIds = promptRows.map((p) => String(p.id));
    const likesByPrompt = new Map<string, number>();
    const ratingByPrompt = new Map<string, number>();
    if (pageIds.length) {
      const { data: likeRows } = await supabase
        .from("reactions")
        .select("target_uuid")
        .eq("target_type", "prompt")
        .eq("reaction_type", "like")
        .in("target_uuid", pageIds);
      for (const r of likeRows ?? []) {
        const k = String(r.target_uuid);
        likesByPrompt.set(k, (likesByPrompt.get(k) ?? 0) + 1);
      }
      const { data: rateRows } = await supabase
        .from("prompt_comments")
        .select("prompt_id, rating")
        .in("prompt_id", pageIds)
        .not("rating", "is", null);
      const sums = new Map<string, { s: number; n: number }>();
      for (const r of rateRows ?? []) {
        if (typeof r.rating !== "number") continue;
        const k = String(r.prompt_id);
        const cur = sums.get(k) ?? { s: 0, n: 0 };
        cur.s += r.rating; cur.n += 1;
        sums.set(k, cur);
      }
      for (const [k, v] of sums) ratingByPrompt.set(k, Math.round((v.s / v.n) * 10) / 10);
    }

    const items: PromptListItem[] = promptRows.map((p) => {
      const promptType = String(p.prompt_type ?? "");
      const isFreeShowcase = Boolean(p.is_free_showcase ?? false);
      const isFree = FREE_TYPES.has(promptType) || isFreeShowcase;
      const thumb = deriveThumbnail(p.showcase_images);
      const id = String(p.id ?? "");

      return {
        id,
        _id: id,
        title: String(p.title ?? ""),
        type: promptType,
        isFree,
        isFreeShowcase,
        // The consumers print this number as-is (ArtworkGrid: `${price}cr`),
        // so the boundary converts the stored integer cents to dollars.
        price:
          typeof p.price_usd_cents === "number" ? p.price_usd_cents / 100 : 0,
        category: typeof p.category === "string" ? p.category : undefined,
        tags: Array.isArray(p.tags) ? (p.tags as string[]) : undefined,
        aiModel: typeof p.ai_model === "string" ? p.ai_model : undefined,
        createdAt: typeof p.created_at === "string" ? p.created_at : undefined,
        downloads: 0,
        rating: ratingByPrompt.get(String(p.id)) ?? 0,
        likes: likesByPrompt.get(String(p.id)) ?? 0,
        creatorId: p.creator_id ? String(p.creator_id) : undefined,
        thumbnail: thumb,
        imageUrl: thumb,
        publicPromptText:
          isFree && typeof p.public_prompt_text === "string"
            ? p.public_prompt_text
            : undefined,
        variables: variablesByPrompt.get(id) ?? [],
      };
    });

    const nextCursor =
      pageRows.length === limit ? String(offset + limit) : null;

    return NextResponse.json({ items, nextCursor });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("Error in /api/prompts:", message);
    return NextResponse.json({ items: [], nextCursor: null }, { status: 200 });
  }
}
