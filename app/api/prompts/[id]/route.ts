import { NextRequest, NextResponse, after } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { decryptString } from "@/lib/crypto";
import { isListed, isPublicText } from "@/lib/prompt-visibility";
import { resolveOwnerIds, resolveSessionUserId, resolveSessionUserWithBan } from "@/lib/session-user";
import { mayShowAdult, viewer } from "@/lib/adult-content";
import { moderate, CLIENT_BLOCK_MESSAGE } from "@/lib/moderation";
import { recordModerationEvent } from "@/lib/moderation-enforcement";
import { checkPrompt } from "@/lib/moderation/prompt-check";
import { recordWarning, warningMessage } from "@/lib/moderation/warnings";

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
        "id,title,encrypted_content,encrypted_content_iv,encrypted_content_tag,encrypted_content_kid,creator_id,category,tags,ai_model,ai_settings,price_usd_cents,aspect_ratio,photo_count,prompt_type,showcase_images,resolution,is_free_showcase,is_listed,listing_status,deleted_at,public_prompt_text,description,published_at,created_at,updated_at,is_adult"
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

    // Text only for a free prompt, and then in full (decrypted through
    // lib/crypto's keyring). A paid prompt's body is the artist's secret: its
    // buyers see the variables, never the words. An unlisted prompt's text is
    // nobody's business but its creator's yet, who may preview it. Ownership
    // is checked the way a save checks it: an email creator's prompt may sit
    // with the user their address was first mapped to.
    const token = req.headers.get("X-Session-Token");
    const viewerId = isPublicText(prompt) && !isListed(prompt) ? await resolveSessionUserId(supabase, token) : null;
    const isOwner =
      viewerId !== null &&
      (prompt.creator_id === viewerId ||
        ((await resolveOwnerIds(supabase, token)) ?? []).includes(String(prompt.creator_id)));
    let publicPromptText: string | undefined;
    if (isPublicText(prompt) && (isListed(prompt) || isOwner)) {
      publicPromptText =
        typeof prompt.public_prompt_text === "string" ? prompt.public_prompt_text : undefined;
      if (prompt.encrypted_content) {
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
  // The account behind the session, resolved like everywhere else: an email
  // login carries the users.id itself, so looking it up as a wallet address
  // answered every edit "not found"; and a suspended account edits nothing.
  const supabase = getSupabaseServerClient();
  let ownerId: string;
  try {
    const { userId, ban } = await resolveSessionUserWithBan(supabase, req.headers.get("X-Session-Token"));
    if (!userId || ban) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    ownerId = userId;
  } catch {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  try {
    const body = (await req.json()) as PatchBody;

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
    // count:"exact" makes the 0-rows branch real; "not found" covers both a
    // missing prompt and someone else's prompt (no ownership oracle).

    // Edited text is judged like a save (Kev, 2026-10-03): a prompt saved
    // clean must not turn explicit or 18+ through its title, description or
    // tags afterwards. Only the owner's edit is judged, so nobody else's
    // request costs a check or earns a warning. The rest of the prompt was
    // judged at save, so an 18+ mark is only ever raised here.
    const edited = Object.fromEntries(
      Object.entries({ title: body.title, description: body.description, tags: Array.isArray(body.tags) ? body.tags.join(", ") : undefined })
        .filter((e): e is [string, string] => typeof e[1] === "string" && e[1].trim() !== ""),
    );
    if (Object.keys(edited).length > 0) {
      const { data: own } = await supabase.from("prompts").select("id")
        .eq("id", id).eq("creator_id", ownerId).maybeSingle();
      if (!own) return NextResponse.json({ error: "not found" }, { status: 404 });
      const check = await checkPrompt(edited, { hidden: false, signal: req.signal });
      if (check.verdict === "minor_sexual" || check.verdict === "explicit_sexual") {
        const outcome = await recordWarning(supabase, {
          surface: "upload", request: req, category: check.verdict, text: JSON.stringify(edited), confidence: check.confidence,
        });
        return NextResponse.json({ error: warningMessage(check.verdict, outcome, "save") }, { status: 422 });
      }
      if (check.verdict !== "clear") {
        return NextResponse.json({ error: "This prompt could not be checked right now. Nothing was saved." }, { status: 503 });
      }
      if (check.adult) update.is_adult = true;
      const text = Object.values(edited).join("\n");
      const verdict = await moderate({ prompt: text, surface: "upload", signal: req.signal, adultJudged: true });
      after(recordModerationEvent(verdict, { surface: "upload", request: req, prompt: text }));
      if (!verdict.allowed) return NextResponse.json({ error: CLIENT_BLOCK_MESSAGE }, { status: 422 });
    }

    const { error, count } = await supabase
      .from("prompts")
      .update(update, { count: "exact" })
      .eq("id", id)
      .eq("creator_id", ownerId);

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
