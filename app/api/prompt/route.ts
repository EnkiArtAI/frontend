import { NextResponse, after } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { encryptString, decryptString } from "@/lib/crypto";
import { moderate, CLIENT_BLOCK_MESSAGE } from "@/lib/moderation";
import { recordModerationEvent } from "@/lib/moderation-enforcement";
import { extractTags, mergeTags } from "@/lib/search/tags";

type VariableType =
  | "text"
  | "checkbox"
  | "image"
  | "multi-select"
  | "single-select"
  | "slider";

type PromptType = "showcase" | "free-prompt" | "paid-prompt" | string;

type PromptPayload = {
  id?: string | null;
  title: string;
  content: string;
  userId?: string | null;
  category?: string;
  tags?: string[];
  aiModel?: string;
  price?: number;
  aspectRatio?: string | null;
  photoCount?: number;
  promptType?: PromptType;
  uploadedPhotos?: string[];
  resolution?: string | null;
  isFreeShowcase?: boolean;
};

type VariableOption = {
  visibleName?: string;
  label?: string;
  promptValue: string;
};

type VariablePayload = {
  id?: string;
  name: string;
  label: string;
  description?: string;
  type: VariableType;
  defaultValue: unknown;
  options?: VariableOption[];
  min?: number;
  max?: number;
  required?: boolean;
  position: number;
};

type SaveBody = PromptPayload & {
  variables?: VariablePayload[];
};

function getErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const obj = e as Record<string, unknown>;
    // Supabase errors are plain objects with message/details/hint/code
    const parts: string[] = [];
    if (typeof obj.message === "string" && obj.message) parts.push(obj.message);
    if (typeof obj.details === "string" && obj.details) parts.push(obj.details);
    if (typeof obj.hint === "string" && obj.hint) parts.push(`hint: ${obj.hint}`);
    if (typeof obj.code === "string" && obj.code) parts.push(`code: ${obj.code}`);
    if (parts.length > 0) return parts.join(" — ");
    try {
      return JSON.stringify(e);
    } catch {
      return "[unserializable error]";
    }
  }
  return String(e);
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

/*
 * ── Live-schema boundary (probed against the live DB, 2026-08-11) ─────────
 *
 * prompts columns are creator_id (uuid, NOT NULL), price_usd_cents (integer),
 * encrypted_content / _iv / _tag / _kid, and showcase_images (jsonb array of
 * URL strings). The columns this route used to write — user_id, price, iv,
 * auth_tag, uploaded_photos, downloads, rating — do not exist (PostgREST 400
 * on every one), which made every save fail with PGRST204. downloads/rating
 * have no replacement anywhere live (prompt_engagement is a different
 * concern), so they are simply not written. Photos live in
 * prompts.showcase_images; the normalized prompt_showcase_images table also
 * exists but requires storage_provider/storage_url per row, which the
 * payload's plain URL strings don't carry.
 *
 * prompts_prompt_type_check accepts: create-now, showcase, free, paid
 * (probed by insert; free-prompt/paid-prompt/free_prompt/paid_prompt/sell
 * are all rejected), so the client's "free-prompt"/"paid-prompt"/
 * "premium-prompt" are mapped at this boundary and mapped back on GET.
 */
const PROMPT_TYPE_TO_DB: Record<string, string> = {
  "free-prompt": "free",
  "paid-prompt": "paid",
  "premium-prompt": "paid", // EnkiPromptEditor's name for a priced prompt
};
const PROMPT_TYPE_FROM_DB: Record<string, string> = {
  free: "free-prompt",
  paid: "paid-prompt",
};

/*
 * Variables live in prompt_variables (the bare `variables` table does not
 * exist — PostgREST 404). data_type is the enum variable_data_type:
 * text, long_text, number, slider, checkbox, boolean, single_select,
 * multi_select, radio, color, reference_image. The client's hyphenated
 * types and "image" are not labels of it. Constraints (all probed):
 *   chk_var_name_format      name ~ ^[a-z][a-z0-9_]*$ (empty rejected)
 *   uq_var_name_per_prompt   name unique per prompt
 *   chk_var_type_specific    slider needs min_value AND max_value;
 *                            single/multi_select need options
 */
const VAR_TYPE_TO_DB: Record<string, string> = {
  image: "reference_image",
  "multi-select": "multi_select",
  "single-select": "single_select",
};
const VAR_TYPE_FROM_DB: Record<string, string> = {
  reference_image: "image",
  multi_select: "multi-select",
  single_select: "single-select",
};
const DB_VAR_TYPES = new Set([
  "text",
  "long_text",
  "number",
  "slider",
  "checkbox",
  "boolean",
  "single_select",
  "multi_select",
  "radio",
  "color",
  "reference_image",
]);

function varTypeToDb(type: string): string {
  if (VAR_TYPE_TO_DB[type]) return VAR_TYPE_TO_DB[type];
  return DB_VAR_TYPES.has(type) ? type : "text";
}

// Editor variable names are free text (bracket tokens start out as name ""),
// but chk_var_name_format demands ^[a-z][a-z0-9_]*$ and
// uq_var_name_per_prompt demands uniqueness. Slug at the boundary instead of
// failing the whole save; the display text travels in label/description,
// which are stored verbatim.
function toDbVarName(name: unknown, position: number, taken: Set<string>): string {
  let slug = (typeof name === "string" ? name : "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!/^[a-z]/.test(slug)) slug = slug ? `v_${slug}` : `var_${position}`;
  let candidate = slug;
  let i = 2;
  while (taken.has(candidate)) candidate = `${slug}_${i++}`;
  taken.add(candidate);
  return candidate;
}

// Resolve the prompt's creator from the session — NEVER from the client
// (a client-supplied userId could claim any creator, and the payment quote
// pays the artist share to that creator's wallet). prompts.creator_id is
// NOT NULL on the live table, so anonymous saves are impossible: no session
// means 401, not a NULL-creator row. First save from a wallet creates the
// users row, same idiom as /api/auth/session.
async function resolveCreatorId(
  supabase: ReturnType<typeof getSupabaseServerClient>,
  req: Request,
): Promise<string | null> {
  const token = req.headers.get("X-Session-Token");
  if (!token) return null;

  const { data: session } = await supabase
    .from("auth_sessions")
    .select("wallet_address, wallet_type")
    .eq("token", token)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (!session) return null;

  const { data: walletRow } = await supabase
    .from("user_wallets")
    .select("user_id")
    .eq("address", session.wallet_address)
    .is("removed_at", null)
    .maybeSingle();
  if (walletRow?.user_id) return walletRow.user_id;

  // Previously looked the address up in turnkey_users to carry its casing over.
  // Turnkey is gone, and the lookup above already covers every wallet we know
  // about, so an unknown address just gets a bare user row.
  const { data: created, error: createError } = await supabase
    .from("users")
    .insert({})
    .select("id")
    .single();
  if (createError || !created?.id) {
    console.error("[prompt] creator user insert failed:", createError?.message);
    return null;
  }
  await supabase.from("user_wallets").insert({
    user_id: created.id,
    address: session.wallet_address,
    chain_family: session.wallet_type === "evm" ? "evm" : "solana",
    wallet_type: "external_eoa",
    is_primary: true,
  });
  return created.id;
}

// Ownership scope for updates: the users.id mapped via user_wallets.
// creator_id is a uuid column, so the raw wallet address (which the dead
// user_id column historically also held) can never belong in the filter —
// a non-uuid value in .in() is a Postgres type error, not a miss. Unlike
// resolveCreatorId this never creates rows: an update on a prompt you don't
// own must fail, not mint a user. null = no valid session; [] = a session
// with no user row, which owns nothing.
async function resolveOwnerIds(
  supabase: ReturnType<typeof getSupabaseServerClient>,
  req: Request,
): Promise<string[] | null> {
  const token = req.headers.get("X-Session-Token");
  if (!token) return null;

  const { data: session } = await supabase
    .from("auth_sessions")
    .select("wallet_address")
    .eq("token", token)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (!session) return null;

  const { data: walletRow } = await supabase
    .from("user_wallets")
    .select("user_id")
    .eq("address", session.wallet_address)
    .is("removed_at", null)
    .maybeSingle();
  return walletRow?.user_id ? [String(walletRow.user_id)] : [];
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as SaveBody;

    if (!body?.title || typeof body.title !== "string") {
      return NextResponse.json({ error: "title is required" }, { status: 400 });
    }

    if (typeof body.content !== "string") {
      return NextResponse.json({ error: "content is required" }, { status: 400 });
    }

    if (body.id && !isUuid(body.id)) {
      return NextResponse.json({ error: "invalid id" }, { status: 400 });
    }

    const tags = Array.isArray(body.tags)
      ? body.tags.filter((t): t is string => typeof t === "string")
      : [];

    const uploadedPhotos = Array.isArray(body.uploadedPhotos)
      ? body.uploadedPhotos.filter((p): p is string => typeof p === "string")
      : [];

    const supabase = getSupabaseServerClient();

    // lib/crypto owns the keyring: the ciphertext carries the kid of the key
    // that made it, so keys can rotate without re-encrypting old rows.
    const enc = encryptString(body.content);

    const nowIso = new Date().toISOString();

    // creator_id deliberately absent here: updates never change the creator
    // (re-saving used to null it), and inserts get the session-resolved
    // creator below — body.userId is ignored entirely.
    const clientPromptType = body.promptType ?? "create-now";

    /* Search tags (Kev, 2026-09-24: zero cost search). The vocabulary matcher
       runs HERE, on the plaintext the client sent, before it is encrypted:
       only canonical vocabulary tags reach prompts.tags, never a word of the
       body itself. Title, variable names and option values are matched in
       full; the body is matched with the paid rules when the prompt is
       sold, so a buyer's product keeps its colours, framing and technique
       to itself. The creator's own tags stay first. */
    const variableText = (Array.isArray(body.variables) ? body.variables : [])
      .flatMap((v) => [
        v.name,
        v.label,
        v.defaultValue,
        ...(v.options ?? []).flatMap((o) => [o.visibleName, o.label, o.promptValue]),
      ])
      .filter((s): s is string => typeof s === "string")
      .join("\n");
    const searchTags = mergeTags(tags, [
      ...extractTags(`${body.title}\n${variableText}`),
      ...extractTags(body.content, {
        paid: (PROMPT_TYPE_TO_DB[clientPromptType] ?? clientPromptType) === "paid",
      }),
    ]);

    const promptRow = {
      title: body.title,
      encrypted_content: enc.encrypted,
      encrypted_content_iv: enc.iv,
      encrypted_content_tag: enc.authTag,
      encrypted_content_kid: enc.kid,
      category: body.category ?? "",
      tags: searchTags,
      ai_model: body.aiModel ?? "gemini",
      // The body sends dollars (float); the column is integer cents.
      price_usd_cents:
        typeof body.price === "number" ? Math.round(body.price * 100) : 100,
      aspect_ratio: body.aspectRatio ?? null,
      photo_count: typeof body.photoCount === "number" ? body.photoCount : 1,
      prompt_type: PROMPT_TYPE_TO_DB[clientPromptType] ?? clientPromptType,
      showcase_images: uploadedPhotos,
      resolution: body.resolution ?? null,
      is_free_showcase: Boolean(body.isFreeShowcase ?? false),
      public_prompt_text: body.content.slice(0, 220),
      updated_at: nowIso,
      /* Lineage (Kev, 2026-08-24): a prompt built via "put prompt to
         editor" records its parent. The key is added only when a valid
         uuid arrives, so saves without lineage never touch the column
         (which lands with migrations/2026-08-24-prompt-provenance.sql). */
      ...(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String((body as { derivedFrom?: unknown }).derivedFrom ?? ""))
        ? { derived_from_prompt_id: String((body as { derivedFrom?: unknown }).derivedFrom) }
        : {}),
    };

    // Moderation. This route had none: a listed prompt is the one piece of
    // user text we hand to a model on someone else's behalf AND show publicly
    // (public_prompt_text is the first 220 characters, verbatim), so it is the
    // most consequential thing on the platform to leave unfiltered.
    //
    // Before BOTH branches. Gating only the insert would leave editing an
    // existing listing as the way round it — create something harmless, then
    // change it.
    //
    // The full content is checked, not just the public excerpt: encryption at
    // rest protects the artist's work from a database dump, it does not make
    // the prompt safe to run.
    const moderatedText = [body.title, body.content, ...(Array.isArray(tags) ? tags : [])]
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .join("\n");
    if (moderatedText) {
      const verdict = await moderate({ prompt: moderatedText, surface: "upload", signal: req.signal });
      after(recordModerationEvent(verdict, { surface: "upload", request: req, prompt: moderatedText }));
      if (!verdict.allowed) {
        return NextResponse.json({ error: CLIENT_BLOCK_MESSAGE }, { status: 422 });
      }
    }

    /* Every [slot] in the text must be a DEFINED variable WITH a value.
       The showcase image is generated from those values, and a prompt whose
       slots have none shows buyers raw brackets next to an image that
       cannot have used them (Kev, 2026-08-24: "jede variable soll auch
       einen wert haben der dann ja benutzt wurde um das angezeigte bild zu
       generieren" — raw DB seeds proved the gap). Checked at SAVE, the one
       door every prompt passes through. */
    const varsPayload = Array.isArray(body.variables) ? body.variables : [];
    const slotNames = new Set(
      Array.from(String(body.content ?? "").matchAll(/\[([^\]\n]+)\]/g), (m) => m[1].trim()),
    );
    if (slotNames.size > 0) {
      const valueByName = new Map(
        varsPayload.map((v) => [String(v.name ?? "").trim(), v.defaultValue]),
      );
      const missing = [...slotNames].filter((t) => {
        if (!valueByName.has(t)) return true;
        const dv = valueByName.get(t);
        return dv == null || String(dv).trim() === "";
      });
      if (missing.length > 0) {
        return NextResponse.json(
          {
            error:
              `Every [slot] needs a variable with a value — missing or empty: ${missing.join(", ")}. ` +
              "The showcase image is generated from these values, so none may be blank.",
          },
          { status: 422 },
        );
      }
    }

    let promptId: string;

    if (body.id) {
      promptId = body.id;

      // Ownership is part of the WHERE clause — the service-role client
      // bypasses RLS, so an unscoped update would let any caller overwrite
      // any prompt by uuid (same IDOR as the PATCH route, PR #59).
      // count:"exact" makes the 0-rows branch real; "not found" covers both
      // a missing prompt and someone else's prompt (no ownership oracle).
      const ownerIds = await resolveOwnerIds(supabase, req);
      if (!ownerIds) {
        return NextResponse.json(
          { error: "Authentication required" },
          { status: 401 }
        );
      }
      if (ownerIds.length === 0) {
        // A session whose wallet maps to no user row owns no prompts, and
        // .in() with an empty list is a PostgREST parse error, not a no-op.
        return NextResponse.json({ error: "not found" }, { status: 404 });
      }

      const { error: updateError, count } = await supabase
        .from("prompts")
        .update(promptRow, { count: "exact" })
        .eq("id", promptId)
        .in("creator_id", ownerIds);

      if (updateError) {
        throw updateError;
      }

      if (count === 0) {
        return NextResponse.json({ error: "not found" }, { status: 404 });
      }

      const { error: deleteError } = await supabase
        .from("prompt_variables")
        .delete()
        .eq("prompt_id", promptId);

      if (deleteError) {
        throw deleteError;
      }
    } else {
      const creatorId = await resolveCreatorId(supabase, req);
      if (!creatorId) {
        return NextResponse.json(
          { error: "Authentication required" },
          { status: 401 }
        );
      }

      const { data: inserted, error: insertError } = await supabase
        .from("prompts")
        .insert({
          ...promptRow,
          creator_id: creatorId,
          created_at: nowIso,
        })
        .select("id")
        .single();

      if (insertError) {
        throw insertError;
      }

      promptId = String(inserted?.id ?? "");
      if (!promptId) {
        throw new Error("Failed to create prompt");
      }
    }

    const vars = varsPayload;

    if (vars.length) {
      const takenNames = new Set<string>();
      const variableRows = vars.map((v) => {
        const dbType = varTypeToDb(v.type);
        return {
          prompt_id: promptId,
          name: toDbVarName(v.name, v.position, takenNames),
          label: v.label,
          description: v.description || "",
          data_type: dbType,
          default_value: v.defaultValue ?? null,
          is_required: Boolean(v.required ?? false),
          position: v.position,
          // chk_var_type_specific: a slider row without both bounds is
          // rejected outright, so absent bounds get the neutral 0..100.
          min_value: v.min ?? (dbType === "slider" ? 0 : null),
          max_value: v.max ?? (dbType === "slider" ? 100 : null),
          options: v.options ?? null,
          created_at: nowIso,
          updated_at: nowIso,
        };
      });

      const { error: varsError } = await supabase
        .from("prompt_variables")
        .insert(variableRows);

      if (varsError) {
        throw varsError;
      }
    }

    return NextResponse.json({
      id: promptId,
      title: body.title,
      category: body.category ?? "",
      tags: body.tags ?? [],
      aiModel: body.aiModel ?? "gemini",
      price: typeof body.price === "number" ? body.price : 1,
      aspectRatio: body.aspectRatio ?? null,
      photoCount: typeof body.photoCount === "number" ? body.photoCount : 1,
      promptType: clientPromptType,
      uploadedPhotos: body.uploadedPhotos ?? [],
      resolution: body.resolution ?? null,
      isFreeShowcase: Boolean(body.isFreeShowcase ?? false),
    });
  } catch (e: unknown) {
    console.error("/api/prompt POST failed:", e);
    return NextResponse.json(
      { error: getErrorMessage(e) || "Failed to save prompt" },
      { status: 500 }
    );
  }
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }

    if (!isUuid(id)) {
      return NextResponse.json({ error: "invalid id" }, { status: 400 });
    }

    const supabase = getSupabaseServerClient();

    const { data: prompt, error: promptError } = await supabase
      .from("prompts")
      .select(
        "id,title,encrypted_content,encrypted_content_iv,encrypted_content_tag,encrypted_content_kid,creator_id,category,tags,ai_model,price_usd_cents,aspect_ratio,photo_count,prompt_type,showcase_images,resolution,is_free_showcase"
      )
      .eq("id", id)
      .maybeSingle();

    if (promptError) {
      throw promptError;
    }

    if (!prompt) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    const { data: variables, error: varsError } = await supabase
      .from("prompt_variables")
      .select(
        "id,prompt_id,name,label,description,data_type,default_value,is_required,position,min_value,max_value,options"
      )
      .eq("prompt_id", id)
      .order("position", { ascending: true });

    if (varsError) {
      throw varsError;
    }

    // The kid names the key that wrote the row; rows from before the keyring
    // carry none and decryptString tries every key on the ring (the legacy
    // prompt key included), which GCM's auth tag makes safe.
    const content = decryptString({
      encrypted: String(prompt.encrypted_content),
      iv: String(prompt.encrypted_content_iv),
      authTag: String(prompt.encrypted_content_tag),
      kid: prompt.encrypted_content_kid
        ? String(prompt.encrypted_content_kid)
        : undefined,
    });

    const dbPromptType = (prompt.prompt_type as string | undefined) ?? "create-now";

    return NextResponse.json({
      id,
      title: String(prompt.title ?? ""),
      content,
      userId: (prompt.creator_id as string | null | undefined) ?? null,
      category: (prompt.category as string | undefined) ?? "",
      tags: Array.isArray(prompt.tags) ? (prompt.tags as string[]) : [],
      aiModel: (prompt.ai_model as string | undefined) ?? "gemini",
      price:
        typeof prompt.price_usd_cents === "number"
          ? prompt.price_usd_cents / 100
          : 1,
      aspectRatio: (prompt.aspect_ratio as string | null | undefined) ?? null,
      photoCount: typeof prompt.photo_count === "number" ? prompt.photo_count : 1,
      promptType: PROMPT_TYPE_FROM_DB[dbPromptType] ?? dbPromptType,
      uploadedPhotos: Array.isArray(prompt.showcase_images)
        ? (prompt.showcase_images as unknown[]).filter(
            (p): p is string => typeof p === "string"
          )
        : [],
      resolution: (prompt.resolution as string | null | undefined) ?? null,
      isFreeShowcase: Boolean(prompt.is_free_showcase ?? false),
      variables: (Array.isArray(variables) ? variables : []).map((v) => {
        const dbType = String(v.data_type ?? "text");
        return {
          id: typeof v.id === "string" ? v.id : undefined,
          promptId: typeof v.prompt_id === "string" ? v.prompt_id : id,
          name: String(v.name ?? ""),
          label: String(v.label ?? ""),
          description: typeof v.description === "string" ? v.description : "",
          type: VAR_TYPE_FROM_DB[dbType] ?? dbType,
          defaultValue: v.default_value ?? null,
          required: Boolean(v.is_required ?? false),
          position: typeof v.position === "number" ? v.position : 0,
          min: typeof v.min_value === "number" ? v.min_value : null,
          max: typeof v.max_value === "number" ? v.max_value : null,
          options: v.options ?? null,
        };
      }),
    });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: getErrorMessage(e) || "Failed to load prompt" },
      { status: 500 }
    );
  }
}
