import { NextResponse, after } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { encryptString, decryptString } from "@/lib/crypto";
import { moderate, CLIENT_BLOCK_MESSAGE } from "@/lib/moderation";
import { recordModerationEvent } from "@/lib/moderation-enforcement";
import { checkPrompt, savedPromptInputs } from "@/lib/moderation/prompt-check";
import { recordWarning, warningMessage } from "@/lib/moderation/warnings";
import { showsAdultRender } from "@/lib/adult-content";
import { resolveOwnerIds, resolveSessionUserId, resolveSessionUserWithBan } from "@/lib/session-user";
import { isPublicText } from "@/lib/prompt-visibility";
import { artistPayoutWallet } from "@/lib/payments/generation-quote";

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
  /** The artist releases the prompt: once this save has passed the checks it is listed for sale. */
  release?: boolean;
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

/* What a variable may carry: text in its name, label, description and
   options; a text, number, yes/no or one flat list of those as its default.
   The prompt check reads exactly these, one level deep, so anything nested
   would be stored, shown and generated from without ever being judged. */
const plain = (x: unknown) => x == null || ["string", "number", "boolean"].includes(typeof x);
const text = (x: unknown) => x == null || typeof x === "string";
function isPlainVariable(v: VariablePayload): boolean {
  return (
    typeof v === "object" && v !== null && text(v.name) && text(v.label) && text(v.description) &&
    (Array.isArray(v.defaultValue) ? v.defaultValue.every(plain) : plain(v.defaultValue)) &&
    (v.options == null ||
      (Array.isArray(v.options) && v.options.every((o) => typeof o === "object" && o !== null && text(o.visibleName) && text(o.label) && text(o.promptValue))))
  );
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

  // Every session the rest of the app knows, bans honoured: an email login
  // carries the users.id itself until a wallet is attached, and looking that
  // up as a wallet address minted a second, empty user for it.
  const known = await resolveSessionUserWithBan(supabase, token);
  if (known.ban) return null;
  if (known.userId) return known.userId;

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

export async function POST(req: Request) {
  // A listed prompt is off sale from its first write until its last one.
  let offSale = false;
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

    // Stored and handed out with the prompt, so text only: it is judged with the rest.
    if ([body.category, body.aspectRatio, body.resolution].some((x) => x != null && typeof x !== "string")) {
      return NextResponse.json({ error: "category, aspectRatio and resolution must be text" }, { status: 400 });
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
    /* The model this prompt is made for is the one its creator picked. It
       defaulted to "gemini", which is no catalogue row, and a re-save without
       a model overwrote the creator's pick with it. Absent on an update now
       leaves the stored value; absent on a new prompt is refused below. */
    const aiModel = typeof body.aiModel === "string" ? body.aiModel.trim() : "";
    const dbPromptType = PROMPT_TYPE_TO_DB[clientPromptType] ?? clientPromptType;
    const isFreeShowcase = Boolean(body.isFreeShowcase ?? false);
    // A free prompt: its text is public and it has no price.
    const publicText = isPublicText({ prompt_type: dbPromptType, is_free_showcase: isFreeShowcase });
    // The body sends dollars (float); the column is integer cents.
    // A free prompt is stored at 0 whatever was sent: the share card, the
    // price filter and the card price read "free" from the cents alone.
    const priceCents = publicText ? 0 : typeof body.price === "number" ? Math.round(body.price * 100) : 100;
    if (!Number.isFinite(priceCents) || priceCents < 0) {
      return NextResponse.json({ error: "The price must be zero or more." }, { status: 400 });
    }
    /* Every [slot] in the text must be a DEFINED variable WITH a value.
       The showcase image is generated from those values, and a prompt whose
       slots have none shows buyers raw brackets next to an image that
       cannot have used them (Kev, 2026-08-24: "jede variable soll auch
       einen wert haben der dann ja benutzt wurde um das angezeigte bild zu
       generieren" — raw DB seeds proved the gap). Checked at SAVE, the one
       door every prompt passes through. */
    const varsPayload = Array.isArray(body.variables) ? body.variables : [];
    if (!varsPayload.every(isPlainVariable)) {
      return NextResponse.json(
        { error: "A variable holds a value that cannot be saved: its name, label, description and options must be text, its default a text, a number, yes/no or a plain list of those." },
        { status: 400 },
      );
    }
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

    if (!body.id && !aiModel) {
      return NextResponse.json({ error: "Pick the model this prompt is made for." }, { status: 400 });
    }

    // Who saves, before anything is judged: an anonymous or foreign save must
    // neither cost a check nor earn anyone a warning. On an update the
    // ownership is also part of the WHERE clause below — the service-role
    // client bypasses RLS, so an unscoped update would let any caller
    // overwrite any prompt by uuid (same IDOR as the PATCH route, PR #59).
    // "not found" covers both a missing prompt and someone else's prompt (no
    // ownership oracle).
    let ownerIds: string[] = [];
    let creatorId: string | null = null;
    // The description is not part of this save (it is edited through the
    // PATCH route) but is shown with the prompt, so an update judges it too.
    let storedDescription: string | null = null;
    // A release lists the prompt (Kev, 2026-10-05: the artist lists when they
    // want, once the checks have passed). A first listing keeps its dates.
    let listedSince: { listed_at?: unknown; published_at?: unknown } = {};
    // What this save writes is for sale: it is released now, or is listed already.
    let live = body.release === true;
    // Whose prompt it is: a paid prompt's buyers pay this creator.
    let payee: string;
    // The content this save read. Every save stores a fresh IV, so a write
    // that still finds this one lands on the prompt as it was read and
    // judged, not on what another save put there meanwhile.
    let readIv: string | null = null;
    let wasListed = false;
    if (body.id) {
      const owners = await resolveOwnerIds(supabase, req.headers.get("X-Session-Token"));
      if (!owners) {
        return NextResponse.json({ error: "Authentication required" }, { status: 401 });
      }
      // A session whose wallet maps to no user row owns no prompts, and
      // .in() with an empty list is a PostgREST parse error, not a no-op.
      if (owners.length === 0) return NextResponse.json({ error: "not found" }, { status: 404 });
      const { data: own } = await supabase.from("prompts").select("id, creator_id, description, encrypted_content_iv, is_listed, delisted_at, listed_at, published_at").eq("id", body.id).in("creator_id", owners).maybeSingle();
      if (!own) return NextResponse.json({ error: "not found" }, { status: 404 });
      // What a moderator took down stays down: releasing it again would undo the takedown.
      if (body.release === true && own.delisted_at) {
        return NextResponse.json({ error: "This prompt was taken down by a moderator and cannot be released again. Nothing was saved." }, { status: 403 });
      }
      listedSince = own;
      wasListed = own.is_listed === true;
      live ||= wasListed;
      payee = String(own.creator_id);
      readIv = (own.encrypted_content_iv as string | null) ?? null;
      storedDescription = (own.description as string | null) ?? null;
      ownerIds = owners;
    } else {
      creatorId = await resolveCreatorId(supabase, req);
      if (!creatorId) {
        return NextResponse.json({ error: "Authentication required" }, { status: 401 });
      }
      payee = creatorId;
    }

    // What is for sale must be sellable: it has a text, it is free or paid,
    // and a paid one has a price. Asked before any check is paid for.
    if (live) {
      const unsellable = !body.content.trim()
        ? "A prompt for sale needs its text."
        : !publicText && dbPromptType !== "paid"
          ? "A prompt for sale is either free or paid."
          : // A price that was not sent is stored as $1.00 for a draft; nothing goes
            // or stays on sale at a price its artist never set.
            !publicText && (typeof body.price !== "number" || priceCents < 1)
            ? "A paid prompt for sale needs a price of at least $0.01."
            : null;
      if (unsellable) return NextResponse.json({ error: `${unsellable} Nothing was saved.` }, { status: 422 });
      // A paid prompt's buyers pay the artist's share to the artist's Solana
      // wallet, by the rule the quote applies. Without one every purchase
      // would be refused at the quote: listed, and for sale to nobody.
      if (!publicText) {
        const payout = await artistPayoutWallet(supabase, payee);
        if (!payout.ok) {
          return payout.status === 500
            ? NextResponse.json({ error: "This prompt could not be checked right now. Nothing was saved." }, { status: 503 })
            : NextResponse.json({ error: "A paid prompt for sale needs a Solana wallet on your account to be paid to: connect one, or link yours again. Nothing was saved." }, { status: 422 });
        }
      }
    }

    // Judged like a generation before it is stored, and whole: everything a
    // saved prompt can put into an image or show a buyer — title, text, tags,
    // every variable's default and options. Explicit and child-safety text is
    // refused with a warning; a suggestive prompt is marked 18+ by itself, as
    // is one whose showcase images are 18+ renders, so the creator never has
    // to (Kev, 2026-10-03). An outage of the check saves nothing rather than
    // an unjudged prompt.
    const judged = savedPromptInputs({ ...body, tags, description: storedDescription });
    // A record of a refused save shows what a buyer could see; the body is
    // the artist's and is withheld from every moderator (lib/moderation/evidence).
    const { content: artistText, ...shownInputs } = judged;
    const check = await checkPrompt(judged, { hidden: false, signal: req.signal });
    if (check.verdict === "minor_sexual" || check.verdict === "explicit_sexual") {
      const outcome = await recordWarning(supabase, {
        surface: "upload", request: req, category: check.verdict, text: JSON.stringify(shownInputs), withheld: artistText, confidence: check.confidence,
      });
      return NextResponse.json({ error: warningMessage(check.verdict, outcome, "save") }, { status: 422 });
    }
    if (check.verdict !== "clear") {
      return NextResponse.json({ error: "This prompt could not be checked right now. Nothing was saved." }, { status: 503 });
    }
    const shownAdult = await showsAdultRender(supabase, uploadedPhotos);
    if (shownAdult === null) {
      return NextResponse.json({ error: "This prompt could not be checked right now. Nothing was saved." }, { status: 503 });
    }
    const adult = check.adult === true || shownAdult;

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
    // Tier 2 reads the same whole as the prompt check.
    const moderatedText = Object.values(judged).join("\n");
    if (moderatedText) {
      const verdict = await moderate({ prompt: moderatedText, surface: "upload", signal: req.signal, adultJudged: true });
      after(recordModerationEvent(verdict, { surface: "upload", request: req, prompt: Object.values(shownInputs).join("\n"), withheld: artistText }));
      if (!verdict.allowed) {
        return NextResponse.json({ error: CLIENT_BLOCK_MESSAGE }, { status: 422 });
      }
      // Tier 2 answers "allowed" when it is down. That is right for a draft,
      // which is judged again when it is released, and wrong for what is or
      // goes on sale: nothing reaches the marketplace on a check that never ran.
      if (verdict.tier2Degraded && live) {
        return NextResponse.json({ error: "This prompt could not be checked right now. Nothing was saved." }, { status: 503 });
      }
    }

    const promptRow = {
      is_adult: adult,
      title: body.title,
      encrypted_content: enc.encrypted,
      encrypted_content_iv: enc.iv,
      encrypted_content_tag: enc.authTag,
      encrypted_content_kid: enc.kid,
      category: body.category ?? "",
      tags,
      ...(aiModel ? { ai_model: aiModel } : {}),
      price_usd_cents: priceCents,
      aspect_ratio: body.aspectRatio ?? null,
      photo_count: typeof body.photoCount === "number" ? body.photoCount : 1,
      prompt_type: dbPromptType,
      showcase_images: uploadedPhotos,
      resolution: body.resolution ?? null,
      is_free_showcase: isFreeShowcase,
      // The first 220 characters, verbatim: only a free prompt may carry its
      // text in the clear. A paid prompt's body is the artist's secret, and a
      // draft's is nobody else's business.
      public_prompt_text: publicText ? body.content.slice(0, 220) : null,
      updated_at: nowIso,
      /* Lineage (Kev, 2026-08-24): a prompt built via "put prompt to
         editor" records its parent. The key is added only when a valid
         uuid arrives, so saves without lineage never touch the column
         (which lands with migrations/2026-08-24-prompt-provenance.sql). */
      ...(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String((body as { derivedFrom?: unknown }).derivedFrom ?? ""))
        ? { derived_from_prompt_id: String((body as { derivedFrom?: unknown }).derivedFrom) }
        : {}),
    };

    let promptId: string;

    if (body.id) {
      promptId = body.id;

      // Only onto the prompt as it was read. The rules above (for sale or
      // not, sellable, tier 2) were decided on that read, and the checks took
      // seconds: a second save of the same prompt may have been judged as a
      // draft and would otherwise land on what this one lists, or the other
      // way round. The description goes back as it was judged, so an edit of
      // it that landed meanwhile cannot sit under a mark it was not part of.
      const asRead = supabase
        .from("prompts")
        // Off sale in the same write that changes it; a listed prompt comes
        // back with the last write below. Its new text is never for sale
        // without its new variables, whatever fails in between.
        .update({ ...promptRow, description: storedDescription, is_listed: false }, { count: "exact" })
        .eq("id", promptId)
        .in("creator_id", ownerIds);
      const { error: updateError, count } = await (readIv === null ? asRead.is("encrypted_content_iv", null) : asRead.eq("encrypted_content_iv", readIv));

      if (updateError) {
        throw updateError;
      }

      if (count === 0) {
        return NextResponse.json({ error: "This prompt was changed by another save while this one was being checked. Nothing was saved; save it again." }, { status: 409 });
      }
      offSale = wasListed;

      const { error: deleteError } = await supabase
        .from("prompt_variables")
        .delete()
        .eq("prompt_id", promptId);

      if (deleteError) {
        throw deleteError;
      }
    } else {
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

    // Listed last: after the prompt check and moderation let this very save
    // through, and once the prompt and its variables are both written, so a
    // save that fails halfway leaves nothing half-made for sale. A save
    // without a release puts a listed prompt back on sale and lists nothing
    // else. The takedown mark is part of the write itself: a moderator may
    // take the prompt down between the ownership read above and here, and
    // what is taken down stays down.
    if (live) {
      const { error: listError, count: nowListed } = await supabase
        .from("prompts")
        .update(
          { is_listed: true, listing_status: "active", listed_at: listedSince.listed_at ?? nowIso, published_at: listedSince.published_at ?? nowIso },
          { count: "exact" },
        )
        .eq("id", promptId)
        // Still the content this very save wrote, not another save's.
        .eq("encrypted_content_iv", enc.iv)
        .is("delisted_at", null);
      if (listError) throw listError;
      if (nowListed === 0) {
        const { data: now } = await supabase.from("prompts").select("delisted_at").eq("id", promptId).maybeSingle();
        return now?.delisted_at
          ? NextResponse.json({ error: "This prompt was taken down by a moderator and cannot be released again. Your changes were saved; it stays unlisted." }, { status: 403 })
          : NextResponse.json({ error: "This prompt was changed by another save while it was being released, so it stays unlisted. Release it again." }, { status: 409 });
      }
    }

    return NextResponse.json({
      id: promptId,
      title: body.title,
      category: body.category ?? "",
      tags: body.tags ?? [],
      aiModel: aiModel || null,
      price: publicText ? 0 : typeof body.price === "number" ? body.price : 1,
      aspectRatio: body.aspectRatio ?? null,
      photoCount: typeof body.photoCount === "number" ? body.photoCount : 1,
      promptType: clientPromptType,
      uploadedPhotos: body.uploadedPhotos ?? [],
      resolution: body.resolution ?? null,
      isFreeShowcase: Boolean(body.isFreeShowcase ?? false),
      // The check marks a prompt 18+ by itself; its artist is told, since an
      // 18+ prompt is shown only to viewers who may see 18+.
      adult,
    });
  } catch (e: unknown) {
    console.error("/api/prompt POST failed:", e);
    return NextResponse.json(
      { error: offSale ? "This prompt could not be saved completely and is off sale now. Release it again." : getErrorMessage(e) || "Failed to save prompt" },
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

    // Owner only: this returns the decrypted body, which is the creator's
    // secret (a paid prompt's buyers see its variables, never its text). It
    // answered anyone who knew an id, and listed ids are public.
    const userId = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
    if (!userId) {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }

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

    // Someone else's prompt answers like a missing one: no decrypt, and no
    // confirmation that the id exists. Ownership is also checked the way a
    // save checks it (resolveOwnerIds): a prompt an email session saved before
    // its wallet was attached is owned through that session's own mapping.
    const owners =
      prompt && prompt.creator_id !== userId ? ((await resolveOwnerIds(supabase, req.headers.get("X-Session-Token"))) ?? []) : [];
    if (!prompt || (prompt.creator_id !== userId && !owners.includes(String(prompt.creator_id)))) {
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
      aiModel: (prompt.ai_model as string | undefined) ?? null,
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
