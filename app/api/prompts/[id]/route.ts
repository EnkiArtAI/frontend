import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { decryptString } from "@/lib/crypto";
import { requireAuth } from "@/lib/auth";
import { mayShowAdult, viewer } from "@/lib/adult-content";

type PatchBody = {
  title?: string;
  description?: string;
  category?: string;
  tags?: string[];
  aiSettings?: { aspectRatio?: string; includeText?: boolean };
  published?: boolean;
};

/*
 * ── Live-schema boundary (probed against the live DB, 2026-08-12) ─────────
 *
 * prompts carries creator_id (uuid), price_usd_cents (integer cents),
 * encrypted_content + _iv/_tag/_kid and showcase_images (jsonb array of URL
 * strings). The columns this route used to read — content, iv, auth_tag,
 * price, uploaded_photos, user_id — are PostgREST 400s: the GET's select("*")
 * survived but every mapped field came back undefined (price 0, no images,
 * no decrypt), and the PATCH's user_id ownership filter errored on every call.
 *
 * prompt_type is stored as create-now | showcase | free | paid; the buyer
 * surface (PromptGeneratorView) checks the client vocabulary free-prompt/
 * paid-prompt, so it is mapped back here, same as /api/prompt does.
 * Variables live in prompt_variables (bare `variables` is a 404).
 */
const PROMPT_TYPE_FROM_DB: Record<string, string> = {
  free: "free-prompt",
  paid: "paid-prompt",
};
const VAR_TYPE_FROM_DB: Record<string, string> = {
  reference_image: "image",
  multi_select: "multi-select",
  single_select: "single-select",
};

export async function GET(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;

  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  try {
    const supabase = getSupabaseServerClient();

    const { data: prompt, error } = await supabase
      .from("prompts")
      .select(
        "id,title,encrypted_content,encrypted_content_iv,encrypted_content_tag,encrypted_content_kid,creator_id,category,tags,ai_model,ai_settings,price_usd_cents,aspect_ratio,photo_count,prompt_type,showcase_images,resolution,is_free_showcase,is_listed,listing_status,public_prompt_text,description,published_at,created_at,updated_at,is_adult"
      )
      .eq("id", id)
      .maybeSingle();

    if (error) throw error;

    // 18+ answers like a missing prompt to anyone who may not see it.
    if (!prompt || (prompt.is_adult && !mayShowAdult(await viewer(supabase, req), prompt.creator_id))) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    // Fetch variables for this prompt
    const { data: variables, error: varsError } = await supabase
      .from("prompt_variables")
      .select(
        "id,name,label,description,data_type,default_value,is_required,position,min_value,max_value,options"
      )
      .eq("prompt_id", id)
      .is("deleted_at", null)
      .order("position", { ascending: true });

    if (varsError) throw varsError;

    // Map variables to the client shape. Options are normalized to carry
    // visibleName — PromptGeneratorView renders opt.visibleName, but stored
    // rows may only have label (or nothing but the promptValue).
    const mappedVariables = (variables || []).map((v) => {
      const dbType = String(v.data_type ?? "text");
      const options = Array.isArray(v.options)
        ? (v.options as Array<Record<string, unknown>>)
            .filter((o) => typeof o?.promptValue === "string")
            .map((o) => ({
              promptValue: o.promptValue as string,
              visibleName:
                typeof o.visibleName === "string"
                  ? o.visibleName
                  : typeof o.label === "string"
                    ? o.label
                    : (o.promptValue as string),
            }))
        : null;
      return {
        id: v.id,
        name: v.name,
        label: v.label,
        description: v.description || "",
        type: VAR_TYPE_FROM_DB[dbType] ?? dbType,
        defaultValue: v.default_value,
        required: Boolean(v.is_required ?? false),
        position: v.position || 0,
        min: typeof v.min_value === "number" ? v.min_value : null,
        max: typeof v.max_value === "number" ? v.max_value : null,
        options,
        allowReferenceImage: false,
      };
    });

    const dbPromptType = String(prompt.prompt_type ?? "");
    const isFree =
      dbPromptType === "showcase" ||
      dbPromptType === "free" ||
      prompt.is_free_showcase === true;

    // Free/showcase prompts show their full text; decryption goes through
    // lib/crypto's keyring (the kid names the key that wrote the row). Paid
    // prompts only ever expose the stored public excerpt.
    let publicPromptText: string | undefined =
      typeof prompt.public_prompt_text === "string"
        ? prompt.public_prompt_text
        : undefined;
    if (isFree && prompt.encrypted_content) {
      try {
        publicPromptText = decryptString({
          encrypted: String(prompt.encrypted_content),
          iv: String(prompt.encrypted_content_iv),
          authTag: String(prompt.encrypted_content_tag),
          kid: prompt.encrypted_content_kid
            ? String(prompt.encrypted_content_kid)
            : undefined,
        });
      } catch (decryptError) {
        console.warn("Failed to decrypt free prompt content:", decryptError);
      }
    }

    // Explicit shape, not a row spread: the encrypted columns stay server-side.
    return NextResponse.json({
      prompt: {
        id,
        _id: id,
        title: prompt.title,
        category: prompt.category,
        tags: Array.isArray(prompt.tags) ? prompt.tags : [],
        ai_model: prompt.ai_model,
        ai_settings: prompt.ai_settings,
        // The buyer surface prints this directly (boostedCost(price).toFixed(2)),
        // so the boundary converts the stored integer cents to dollars.
        price:
          typeof prompt.price_usd_cents === "number"
            ? prompt.price_usd_cents / 100
            : 0,
        aspect_ratio: prompt.aspect_ratio,
        photo_count: prompt.photo_count,
        resolution: prompt.resolution,
        prompt_type: PROMPT_TYPE_FROM_DB[dbPromptType] ?? dbPromptType,
        is_free_showcase: Boolean(prompt.is_free_showcase ?? false),
        is_listed: prompt.is_listed,
        listing_status: prompt.listing_status,
        description: prompt.description,
        published_at: prompt.published_at,
        created_at: prompt.created_at,
        updated_at: prompt.updated_at,
        // /generator/[id] resolves the artist from `creator`.
        creator: prompt.creator_id,
        creator_id: prompt.creator_id,
        publicPromptText,
        // The buyer-facing generator reads camelCase showcaseImages objects,
        // while the DB row carries an array of plain URL strings.
        showcaseImages: (Array.isArray(prompt.showcase_images)
          ? prompt.showcase_images
          : []
        )
          .filter((url: unknown): url is string => typeof url === "string")
          .map((url: string) => ({ url })),
        promptData: {
          variables: mappedVariables,
        },
      },
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;

  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  // Require a valid session. This route used to accept anonymous edits — including
  // the prompt's price, which server-built payments (#2) read straight from the DB.
  // Price and "featured" are deliberately NOT mutable here anymore: price changes
  // must go through the authenticated, ownership-checked /api/prompts/[id]/list
  // endpoint so the payment path can trust the stored price.
  let userId: string;
  try {
    ({ userId } = await requireAuth(req));
  } catch {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  try {
    const body = (await req.json()) as PatchBody;
    const supabase = getSupabaseServerClient();

    const update: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    if (typeof body.title === "string") update.title = body.title;
    if (typeof body.description === "string") update.description = body.description;
    if (typeof body.category === "string") update.category = body.category;
    if (Array.isArray(body.tags)) update.tags = body.tags;

    if (body.aiSettings) {
      update.ai_settings = {
        aspectRatio: body.aiSettings.aspectRatio,
        includeText: body.aiSettings.includeText,
      };
    }

    if (body.published === true) {
      update.published_at = new Date().toISOString();
    }

    // Ownership is part of the WHERE clause — the service-role client bypasses
    // RLS, so without it any valid session could edit any prompt (IDOR).
    // requireAuth's userId is the session WALLET ADDRESS; prompts.creator_id
    // is a users.id uuid, so the address must be mapped through user_wallets —
    // a raw base58/0x string in a uuid filter is a Postgres type error, not a
    // miss. A wallet with no user row owns nothing: 404, never an unscoped
    // update. count:"exact" makes the 0-rows branch real; "not found" covers
    // both a missing prompt and someone else's prompt (no ownership oracle).
    const { data: walletRow } = await supabase
      .from("user_wallets")
      .select("user_id")
      .eq("address", userId)
      .is("removed_at", null)
      .maybeSingle();
    if (!walletRow?.user_id) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    const { error, count } = await supabase
      .from("prompts")
      .update(update, { count: "exact" })
      .eq("id", id)
      .eq("creator_id", String(walletRow.user_id));

    if (error) throw error;

    if (count === 0) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    console.error("[prompts/patch] update failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Failed to update prompt" }, { status: 500 });
  }
}
