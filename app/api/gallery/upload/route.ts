import { NextRequest, after } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserId } from "@/lib/session-user";
import { createErrorResponse, createSuccessResponse } from "../../../middleware/validation";
import { tryMakeDerivatives } from "@/lib/imageDerivatives";
import { moderate, CLIENT_BLOCK_MESSAGE } from "@/lib/moderation";
import { recordModerationEvent } from "@/lib/moderation-enforcement";

/**
 * The metadata field is client-supplied text. `JSON.parse` on it threw
 * straight out of the handler for anything malformed — a 500 for a typo, and
 * an upload already written to blob storage with no row to point at it.
 */
function safeJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];

/**
 * Validates file type and size
 */
function validateFile(file: File): { valid: boolean; error?: string } {
  if (!ALLOWED_TYPES.includes(file.type)) {
    return {
      valid: false,
      error: `Invalid file type. Allowed types: PNG, JPEG, WebP`
    };
  }

  if (file.size > MAX_FILE_SIZE) {
    return {
      valid: false,
      error: `File size exceeds 10MB limit. Current size: ${(file.size / 1024 / 1024).toFixed(2)}MB`
    };
  }

  return { valid: true };
}

/**
 * Uploads image file to blob storage
 */
async function uploadToBlob(file: File, userId: string): Promise<string> {
  // Convert File to Buffer (works in both browser and Node.js)
  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  try {
    const { put } = await import('@vercel/blob');
    
    // Create unique filename
    const timestamp = Date.now();
    const randomSuffix = Math.random().toString(36).substring(2, 9);
    const extension = file.name.split('.').pop() || 'png';
    const filename = `gallery/${userId}/${timestamp}_${randomSuffix}.${extension}`;

    // Upload to Vercel Blob
    const { url } = await put(filename, buffer, {
      access: 'public',
      contentType: file.type,
      addRandomSuffix: false
    });

    console.log(`✅ Image uploaded to blob storage: ${url}`);
    return url;
  } catch (error: any) {
    console.error('❌ Failed to upload to blob storage:', error);
    throw new Error(`Failed to upload image: ${error.message || 'Unknown error'}`);
  }
}

/**
 * Store one derivative. Returns null rather than throwing: a missing preview
 * degrades the gallery, a failed upload loses the user's image.
 */
async function putDerivative(filename: string, buffer: Buffer): Promise<string | null> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  try {
    const { put } = await import("@vercel/blob");
    const { url } = await put(filename, buffer, {
      access: "public",
      contentType: "image/webp",
      addRandomSuffix: false,
    });
    return url;
  } catch (error) {
    console.warn("⚠️ derivative upload failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Sanitizes user input string
 */
function sanitizeString(input: string | null | undefined, maxLength: number = 1000): string {
  if (!input) return '';
  return input
    .trim()
    .slice(0, maxLength)
    .replace(/[<>]/g, ''); // Remove potential HTML tags
}

export async function POST(req: NextRequest) {
  try {
    /* Whose upload this is comes from the session, never from the request:
       a header equal to a form field proved only that the caller typed the
       same address twice, so anyone could file images under anyone. A
       banned session resolves to nobody. Checked before a 10 MB body is read. */
    const supabase = getSupabaseServerClient();
    const userId = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
    if (!userId) {
      return createErrorResponse('Sign in to upload images', 401);
    }
    /* A data URL used to stand in for the store here, and landed in the row
       as megabytes of text. No store, no upload. */
    if (!process.env.BLOB_READ_WRITE_TOKEN?.trim()) {
      return createErrorResponse('Image uploads are not configured on this environment', 503);
    }

    // Parse FormData
    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    const prompt = formData.get('prompt') as string | null;
    const metadata = formData.get('metadata') as string | null;

    // Validate required fields
    if (!file) {
      return createErrorResponse('File is required', 400);
    }

    // Validate file
    const fileValidation = validateFile(file);
    if (!fileValidation.valid) {
      return createErrorResponse(fileValidation.error || 'Invalid file', 400);
    }

    // Sanitize optional fields
    const sanitizedPrompt = sanitizeString(prompt, 2000);
    const sanitizedMetadata = metadata ? sanitizeString(metadata, 5000) : null;

    // Moderation. This route had NONE: generate-image and generate-free both
    // gate on it, so an upload was the one way into the gallery that no filter
    // watched — and it is the easier one, because the attacker brings the
    // image and only has to get the text past us.
    //
    // Runs BEFORE the blob upload on purpose: a refused caption must not leave
    // a file paid for and stored, and a refusal after the upload would mean
    // deleting something we had already written.
    //
    // The title travels with the caption. It is displayed in the same places
    // and moderating one while ignoring the other just moves the payload one
    // field across.
    const rawTitle = sanitizedMetadata ? safeJson(sanitizedMetadata)?.title : null;
    const title = typeof rawTitle === "string" ? rawTitle : null;
    const moderatedText = [sanitizedPrompt, title].filter(Boolean).join("\n");
    if (moderatedText) {
      const verdict = await moderate({ prompt: moderatedText, surface: "upload", signal: req.signal });
      // after() rather than a bare void: on a block this route returns at once,
      // and a floating promise can be frozen with the lambda before the insert
      // lands — losing exactly the events worth keeping.
      after(recordModerationEvent(verdict, { surface: "upload", request: req, prompt: moderatedText }));
      if (!verdict.allowed) {
        return createErrorResponse(CLIENT_BLOCK_MESSAGE, 422);
      }
    }

    // Upload image to blob storage
    console.log(`📤 Uploading image for user ${userId}...`);
    const imageUrl = await uploadToBlob(file, userId);

    // Preview + thumbnail. Without them the grid loads originals — measured
    // 2026-08-06 against the real providers, 3.0 MB for a 2K image and up to
    // 21.1 MB at 4K. Best-effort on purpose: a failed derivative must cost us
    // the smaller renditions, never the upload the user is waiting on.
    const original = Buffer.from(await file.arrayBuffer());
    const derived = await tryMakeDerivatives(original);
    let previewUrl: string | null = null;
    let thumbnailUrl: string | null = null;
    if (derived) {
      const base = `gallery/${userId}/${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      [previewUrl, thumbnailUrl] = await Promise.all([
        putDerivative(`${base}_preview.webp`, derived.preview.buffer),
        putDerivative(`${base}_thumb.webp`, derived.thumb.buffer),
      ]);
      console.log(
        `🖼️ derivatives: preview ${(derived.preview.bytes / 1024).toFixed(0)}KB, ` +
        `thumb ${(derived.thumb.bytes / 1024).toFixed(0)}KB, ` +
        `original ${(original.length / 1048576).toFixed(2)}MB`,
      );
    }

    // An upload belongs in generated_images, not generations.
    //
    // This used to insert into `generations` with final_prompt / status /
    // image_urls / payment_verified — none of which exist on that table any
    // more, so every upload failed with PGRST204. The live split is:
    //   generations      the generation record; prompt_id and the encrypted
    //                    prompt envelope are NOT NULL, so an upload (no prompt,
    //                    no generation) cannot be represented there at all
    //   generated_images the actual images, with generation_id optional and an
    //                    is_uploaded flag for exactly this case
    // Verified against the live schema before writing.
    const nowIso = new Date().toISOString();
    const generationData: Record<string, unknown> = {
      user_id: userId,
      generation_id: null,   // nothing generated it — the user brought it
      prompt_id: null,
      sequence_index: 0,
      storage_provider: 'vercel_blob',
      storage_url: imageUrl,
      preview_url: previewUrl,
      thumbnail_url: thumbnailUrl,
      width: derived?.width ?? null,
      height: derived?.height ?? null,
      mime_type: file.type || 'image/png',
      is_uploaded: true,
      is_watermarked: false,
      visibility: 'private',
      accepted: true,
      file_size_bytes: file.size ?? null,
      // The caption the user typed. Kept as the image's own description rather
      // than as a prompt: it never produced anything.
      description: sanitizedPrompt || null,
      // Parsed once, above, where it is also moderated — parsing it twice
      // risked the two disagreeing about what the title actually is.
      title,
      created_at: nowIso,
    };

    // Store in database
    const { data, error } = await supabase
      .from('generated_images')
      .insert([generationData])
      .select('id, user_id, storage_url, created_at')
      .single();

    if (error) {
      console.error('❌ Database error:', error);
      // The row is what owns the files; without it they are orphans nobody can see or delete.
      const stored = [imageUrl, previewUrl, thumbnailUrl].filter((u): u is string => Boolean(u));
      await import("@vercel/blob").then(({ del }) => del(stored)).catch((e) =>
        console.warn("⚠️ orphan cleanup failed:", e instanceof Error ? e.message : e),
      );
      return createErrorResponse('Failed to create gallery entry', 500, error.message);
    }

    console.log(`✅ Gallery entry created: ${data.id}`);

    return createSuccessResponse({
      success: true,
      imageUrl: imageUrl,
      galleryItemId: data.id,
      message: 'Image uploaded successfully'
    }, 201);

  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('❌ Upload error:', message);
    return createErrorResponse('Internal server error', 500, message);
  }
}

