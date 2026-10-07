import type { SupabaseClient } from "@supabase/supabase-js";
import { isPublicText } from "@/lib/prompt-visibility";

/*
 * The marketplace card: one row of the prompts table, mapped and enriched
 * the way /api/marketplace/prompts has always served it. Extracted so that
 * /api/search returns the SAME shape for the same prompt (Kev, 2026-09-24:
 * search results land directly in the feed), and the two can never drift.
 *
 * Live-schema boundary (probed 2026-08-12, re-read 2026-09-24): the columns
 * below exist; price, downloads, rating, user_id and uploaded_photos do not.
 * No encrypted_* column is ever selected here, and the public excerpt only
 * for a prompt whose text is public: a paid prompt's card carries the
 * creator's description, never the words of the prompt.
 */
export const PROMPT_CARD_SELECT =
  "id,title,description,public_prompt_text,price_usd_cents,category,tags,ai_model,created_at,creator_id,showcase_images,aspect_ratio,resolution,is_free_showcase,prompt_type";

export type PromptCardRow = {
  id: string;
  title: string | null;
  description: string | null;
  public_prompt_text: string | null;
  price_usd_cents: number | null;
  category: string | null;
  tags: unknown;
  ai_model: string | null;
  created_at: string | null;
  creator_id: string | null;
  showcase_images: unknown;
  aspect_ratio: string | null;
  resolution: string | null;
  is_free_showcase: boolean | null;
  prompt_type: string | null;
};

type Image = { url: string };

const images = (value: unknown): Image[] =>
  Array.isArray(value) ? value.map((url: string) => ({ url })) : [];

/** The row as the feed reads it, before creator and variables are attached. */
export function mapPromptRow(p: PromptCardRow) {
  const text = isPublicText(p) ? p.public_prompt_text || "" : "";
  return {
    id: p.id,
    title: p.title,
    description: text || p.description || "",
    promptTemplate: text,
    // Integer cents straight through: the field name carries the unit and
    // the feed adapter (enkiPromptAdapter.dollars) divides by 100.
    priceUsdCents: typeof p.price_usd_cents === "number" ? p.price_usd_cents : 0,
    category: p.category || "",
    tags: Array.isArray(p.tags) ? (p.tags as string[]) : [],
    // No sales/rating columns exist live; 0 is the shape's default.
    totalSales: 0,
    avgRating: 0,
    createdAt: p.created_at,
    listedAt: p.created_at,
    userId: p.creator_id,
    previewImages: images(p.showcase_images),
    showcaseImages: images(p.showcase_images),
    aiModel: p.ai_model,
    model: p.ai_model,
    aspectRatio: p.aspect_ratio,
    resolution: p.resolution,
    isFreeShowcase: Boolean(p.is_free_showcase),
    promptType: p.prompt_type,
    isVideo: false,
  };
}

export type PromptListing = ReturnType<typeof mapPromptRow>;

type Variable = {
  name: string;
  label: string;
  description: string;
  type: string;
  defaultValue: unknown;
  required: boolean;
  position: number;
};

type Creator = {
  id: string;
  displayName: string;
  handle: string;
  /** Kept for older readers that still say `username`. */
  username: string;
  avatarUrl: string | null;
};

// Variables live in prompt_variables (the bare `variables` table is a
// PostgREST 404); data_type is the DB enum, mapped back to the client
// vocabulary.
const VAR_TYPE_FROM_DB: Record<string, string> = {
  reference_image: "image",
  multi_select: "multi-select",
  single_select: "single-select",
};

function card(prompt: PromptListing, creator: Creator | null, variables: Variable[]) {
  return {
    id: prompt.id,
    title: prompt.title,
    description: prompt.description,
    promptTemplate: prompt.promptTemplate || prompt.description,
    priceUsdCents: prompt.priceUsdCents,
    licenseType: "personal",
    category: prompt.category,
    tags: prompt.tags || [],
    totalSales: prompt.totalSales || 0,
    totalRevenue: 0,
    avgRating: prompt.avgRating || 0,
    ratingCount: 0,
    createdAt: prompt.createdAt,
    listedAt: prompt.listedAt,
    creator,
    previewImages: prompt.previewImages || prompt.showcaseImages || [],
    showcaseImages: prompt.showcaseImages || prompt.previewImages || [],
    model: prompt.model || prompt.aiModel,
    aspectRatio: prompt.aspectRatio,
    resolution: prompt.resolution,
    isFreeShowcase: prompt.isFreeShowcase,
    promptType: prompt.promptType,
    isVideo: prompt.isVideo,
    variables,
    relevanceScore: 0,
  };
}

export type PromptCard = ReturnType<typeof card>;

/** Attach each listing's creator and variables; order is preserved. */
export async function enrichPromptCards(
  supabase: SupabaseClient,
  prompts: PromptListing[],
): Promise<PromptCard[]> {
  const promptIds = prompts.map((p) => p.id).filter(Boolean);
  const variablesMap: Record<string, Variable[]> = {};
  if (promptIds.length > 0) {
    try {
      const { data: varsData } = await supabase
        .from("prompt_variables")
        .select("prompt_id,name,label,description,data_type,default_value,is_required,position")
        .in("prompt_id", promptIds)
        .is("deleted_at", null)
        .order("position", { ascending: true });
      for (const v of varsData ?? []) {
        const pid = String(v.prompt_id);
        const dbType = String(v.data_type ?? "text");
        (variablesMap[pid] ??= []).push({
          name: String(v.name ?? ""),
          label: String(v.label ?? v.name ?? ""),
          description: String(v.description ?? ""),
          type: VAR_TYPE_FROM_DB[dbType] ?? dbType,
          defaultValue: v.default_value ?? null,
          required: Boolean(v.is_required ?? false),
          position: typeof v.position === "number" ? v.position : 0,
        });
      }
    } catch (e) {
      console.error("Variable fetch error:", e);
    }
  }

  return Promise.all(
    prompts.map(async (prompt) => {
      const variables = variablesMap[prompt.id] || [];
      try {
        // Live schema: users.handle. `username` never existed, so that select
        // 400'd and every feed card shipped creator: null.
        const { data: c } = await supabase
          .from("users")
          .select("id, handle, display_name, avatar_url")
          .eq("id", prompt.userId)
          .single();
        const creator: Creator | null = c
          ? {
              id: c.id,
              displayName: c.display_name || c.handle,
              handle: c.handle,
              username: c.handle,
              avatarUrl: c.avatar_url,
            }
          : null;
        return card(prompt, creator, variables);
      } catch (error) {
        console.error(`Error enriching prompt ${prompt.id}:`, error);
        return card(prompt, null, variables);
      }
    }),
  );
}
