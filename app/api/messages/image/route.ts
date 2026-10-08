import { NextRequest, NextResponse, after } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserId } from "@/lib/session-user";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { DM_BUCKET, UUID_RE, loadThreadFor, readColFor, shapeMessages, type DmMessageRow } from "@/lib/dm";
import { checkImageBytes, MESSAGE_IMAGE_ADULT, UPLOAD_REFUSED, UPLOAD_UNCHECKED } from "@/lib/moderation/image-check-bytes";
import { recordImageCase } from "@/lib/moderation/image-case";

const IMAGE_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const MAX_IMAGE = 8 * 1024 * 1024;

// Send an image message: multipart { threadId, file }. Stored in the PRIVATE
// "dm" bucket; readers get short-lived signed URLs from the thread fetch.
export async function POST(req: NextRequest) {
  const supabase = getSupabaseServerClient();
  const userId = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const limit = checkRequestRateLimit(rateLimitKey(req, "dm:image", userId), 10, 60_000);
  if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

  let fd: FormData;
  try {
    fd = await req.formData();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const threadId = String(fd.get("threadId") ?? "");
  const file = fd.get("file");
  if (!UUID_RE.test(threadId) || !(file instanceof File)) {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const ext = IMAGE_EXT[file.type];
  if (!ext) return NextResponse.json({ error: "Use a PNG, JPG or WebP image" }, { status: 400 });
  if (file.size > MAX_IMAGE) return NextResponse.json({ error: "Images can be up to 8 MB" }, { status: 400 });

  const thread = await loadThreadFor(supabase, threadId, userId);
  if (!thread) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // The image check before it is stored or reaches the other member (Kev,
  // 2026-10-08: every image). A message has no 18+ mark and can reach
  // anyone, so only a clear image is sent; a child-safety verdict becomes a
  // case an admin decides.
  const buf = Buffer.from(await file.arrayBuffer());
  const seen = await checkImageBytes(buf, { signal: req.signal });
  if (seen.verdict !== "clear") {
    if (seen.verdict === "child_safety") {
      after(recordImageCase(supabase, { surface: "dm", request: req, bytes: buf, scores: seen.scores, about: "An image sent in a direct message." }));
    }
    return seen.verdict === "unavailable"
      ? NextResponse.json({ error: UPLOAD_UNCHECKED }, { status: 503 })
      : NextResponse.json({ error: seen.verdict === "adult" ? MESSAGE_IMAGE_ADULT : UPLOAD_REFUSED }, { status: 422 });
  }

  // Private bucket — DM images must never get a public URL. Tolerates "exists".
  await supabase.storage.createBucket(DM_BUCKET, { public: false }).catch(() => {});

  const path = `${threadId}/${userId}-${Date.now()}.${ext}`;
  const up = await supabase.storage.from(DM_BUCKET).upload(path, buf, { contentType: file.type, upsert: false });
  if (up.error) return NextResponse.json({ error: "Could not upload the image" }, { status: 500 });

  const { data: msg, error } = await supabase
    .from("dm_messages")
    .insert({ thread_id: threadId, sender_id: userId, image_path: path })
    .select("id, sender_id, body, image_path, created_at")
    .single();
  if (error || !msg) {
    // Don't leave orphaned bytes behind if the row insert failed.
    await supabase.storage.from(DM_BUCKET).remove([path]).catch(() => {});
    return NextResponse.json({ error: "Could not send" }, { status: 500 });
  }

  await supabase
    .from("dm_threads")
    .update({ last_message_at: msg.created_at, [readColFor(thread, userId)]: msg.created_at })
    .eq("id", threadId);

  return NextResponse.json(
    { message: (await shapeMessages(supabase, [msg as DmMessageRow], userId))[0] },
    { status: 201 },
  );
}
