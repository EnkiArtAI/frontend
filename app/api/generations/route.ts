// app/api/generations/route.ts
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { hideAdult, viewer } from "@/lib/adult-content";
import { hiddenOwners } from "@/lib/hidden-owners";
import { dbUnavailableResponse, isDbUnreachable } from "@/lib/db-error";
import {
  getGenerationsQuerySchema,
  validateQuery,
  createErrorResponse,
  createSuccessResponse
} from "../../middleware/validation";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);

    // Validate query parameters
    const queryValidation = validateQuery(getGenerationsQuerySchema, searchParams);
    if (!queryValidation.success) {
      const errorMessages = queryValidation.errors.map((err: any) => `${err.path.join('.')}: ${err.message}`);
      return createErrorResponse('Invalid query parameters', 400, errorMessages);
    }

    const { limit = 50, offset = 0 } = queryValidation.data;
    // Support both userKey (legacy) and userId
    const userId = searchParams.get("userId") || searchParams.get("userKey");

    if (!userId) {
      return createErrorResponse('userId or userKey is required', 400);
    }

    const supabase = getSupabaseServerClient();

    // Galleries pass a WALLET ADDRESS, the tables key on a user uuid. This used
    // to give up and return an empty list for every wallet caller — which is
    // why the gallery looked empty even when images existed. Resolve it.
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId);
    // Only a Solana or EVM address is looked up: a pattern such as % or * would
    // match many wallets in the ilike below and read as a failure.
    const isWallet = /^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/.test(userId);
    // Lower case, as the database answers ids: an upper-case id must not
    // slip past the hidden-owner check below while .eq() still matches it.
    let ownerId = isUuid ? userId.toLowerCase() : null;
    if (!ownerId && isWallet) {
      const { data: walletRow, error: walletError } = await supabase
        .from("user_wallets")
        .select("user_id")
        // addresses are stored lowercased; base58 is case-sensitive, so compare
        // case-insensitively rather than missing every Solana wallet.
        .ilike("address", userId)
        .is("removed_at", null)
        .maybeSingle();
      // A failed lookup is no empty gallery: the catch answers it (503 for an outage).
      if (walletError) throw walletError;
      ownerId = (walletRow?.user_id as string) ?? null;
    }
    if (!ownerId) {
      return createSuccessResponse({ generations: [], total: 0, limit, offset });
    }

    // Images live in generated_images, not generations: the latter holds the
    // generation record (encrypted prompt, prompt_id NOT NULL) and has no image
    // column at all. Reading `generations` here is what made uploads invisible.
    const v = await viewer(supabase, req);
    // A banned or deleted account's gallery is empty to everyone but itself.
    if (v.userId !== ownerId) {
      const hidden = await hiddenOwners(supabase, [ownerId]);
      if (!hidden) return createErrorResponse("Gallery unavailable", 500);
      if (hidden.has(ownerId)) return createSuccessResponse({ generations: [], total: 0, limit, offset });
    }
    let gallery = supabase
      .from("generated_images")
      .select("id, prompt_id, storage_url, preview_url, thumbnail_url, description, is_uploaded, visibility, created_at", { count: 'exact' })
      .eq("user_id", ownerId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    // Uploads are images nothing has checked yet: no 18+ mark, no child-safety
    // check (the image check is stage 2). Their owner sees them; nobody else
    // does until that check exists.
    // Images are recorded private; a visitor sees only what its owner published.
    if (v.userId !== ownerId) gallery = gallery.eq("is_uploaded", false).eq("visibility", "public");
    const { data, error, count } = await hideAdult(gallery, v, ownerId);

    if (error) {
      console.error('Database error:', error);
      return createErrorResponse('Failed to fetch generations', 500, error.message);
    }

    // Keep the shape the galleries already consume (image_url / prompt /
    // isUploaded) so this is a server-side fix with no client changes.
    const generations = (Array.isArray(data) ? data : []).map((row) => ({
      id: row.id,
      // image_url stays the ORIGINAL (downloads); image_urls is what the
      // galleries DISPLAY, so the WebP preview leads when one exists.
      image_url: row.storage_url,
      image_urls: (row.preview_url ?? row.storage_url) ? [row.preview_url ?? row.storage_url] : [],
      thumbnail_url: row.thumbnail_url ?? null,
      prompt: row.description ?? "",
      isUploaded: row.is_uploaded === true,
      // The owner's gallery shows it beside the publish switch (SHR-1).
      visibility: row.visibility === "public" ? "public" : "private",
      // Which prompt it was made with: the image UI says where a public one shows.
      prompt_id: row.prompt_id ?? null,
      created_at: row.created_at,
    }));

    return createSuccessResponse({
      generations,
      total: count || 0,
      limit,
      offset
    });
  } catch (e: unknown) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    const message = e instanceof Error ? e.message : (e as { message?: string })?.message ?? String(e);
    console.error('Error fetching generations:', message);
    return createErrorResponse('Internal server error', 500);
  }
}
