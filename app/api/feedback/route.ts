/**
 * POST /api/feedback — the "$100 for feedback" program.
 *
 * multipart/form-data: severity (bug|issue|annoying|minor), description,
 * files[] (image/video, at most 5, 4 MB together). Requires a session — the payout needs
 * an account to land in. Rows go to feedback_submissions (+ attachments in
 * the PRIVATE "feedback" bucket) and surface in the admin panel's queue.
 * Columns verified live 2026-07-20.
 */
import { NextRequest, NextResponse, after } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserId } from "@/lib/session-user";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { createHash } from "crypto";
import { encryptString } from "@/lib/crypto";
import { checkImageBytes, NOT_AN_IMAGE } from "@/lib/moderation/image-check-bytes";
import { recordImageCase } from "@/lib/moderation/image-case";
import { FEEDBACK_BUCKET, FEEDBACK_FILE_EXT, FEEDBACK_MAX_BYTES, FEEDBACK_MAX_FILES } from "@/lib/feedback";

/** A video container by its own first bytes: MP4 and MOV (ftyp), WebM (EBML). */
const isVideo = (b: Buffer) => b.toString("latin1", 4, 8) === "ftyp" || b.subarray(0, 4).toString("hex") === "1a45dfa3";
// UI ids → live check-constraint values (probed 2026-07-21: severity ∈
// {critical, high, medium, low}, category ∈ {bug, other, …})
const SEV_MAP: Record<string, { severity: string; category: string }> = {
  bug: { severity: "critical", category: "bug" },
  issue: { severity: "high", category: "other" },
  annoying: { severity: "medium", category: "other" },
  minor: { severity: "low", category: "other" },
};

export async function POST(req: NextRequest) {
  const supabase = getSupabaseServerClient();
  const userId = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
  if (!userId) return NextResponse.json({ error: "Sign in first — the $100 needs an account to land in." }, { status: 401 });

  const limit = checkRequestRateLimit(rateLimitKey(req, "feedback:submit", userId), 5, 10 * 60_000);
  if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

  let fd: FormData;
  try {
    fd = await req.formData();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const sevId = String(fd.get("severity") ?? "");
  const description = String(fd.get("description") ?? "").trim();
  const mapped = SEV_MAP[sevId];
  if (!mapped) return NextResponse.json({ error: "Pick a severity" }, { status: 400 });
  if (description.length < 10) return NextResponse.json({ error: "Describe the change in a bit more detail (at least 10 characters)" }, { status: 400 });
  if (description.length > 4000) return NextResponse.json({ error: "Keep it under 4000 characters" }, { status: 400 });

  const files = fd.getAll("files").filter((f): f is File => f instanceof File).slice(0, FEEDBACK_MAX_FILES);
  // Own keys only: "constructor" is no file type.
  if (files.some((f) => !Object.hasOwn(FEEDBACK_FILE_EXT, f.type))) {
    return NextResponse.json({ error: "Attachments can be PNG, JPG, WebP, GIF, MP4, WebM or MOV" }, { status: 400 });
  }
  // The modal stays under this before sending; only another client gets here.
  if (files.reduce((n, f) => n + f.size, 0) > FEEDBACK_MAX_BYTES) {
    return NextResponse.json({ error: "Attachments can be up to 4 MB in total" }, { status: 413 });
  }

  // submitter_email_ct is NOT NULL (verified live 2026-07-21). An account's
  // email lives in its password sign-in (password_credentials.email, stored
  // lowercased); users.email_ct is written by no code. A wallet-only account
  // has none and gets an encrypted empty string, which the panel shows as none.
  const [{ data: me }, { data: cred }] = await Promise.all([
    supabase.from("users").select("handle").eq("id", userId).maybeSingle(),
    supabase.from("password_credentials").select("email").eq("user_id", userId).maybeSingle(),
  ]);
  const email = typeof cred?.email === "string" ? cred.email : "";
  const enc = encryptString(email);

  const { data: row, error } = await supabase
    .from("feedback_submissions")
    .insert({
      user_id: userId,
      submitter_name: (me?.handle as string) ?? "unnamed",
      submitter_email_ct: enc.encrypted,
      submitter_email_iv: enc.iv,
      submitter_email_tag: enc.authTag,
      submitter_email_kid: enc.kid ?? null,
      // NOT NULL live: sha256 of the lowercased email.
      submitter_email_lookup_hash: createHash("sha256").update(email.toLowerCase()).digest("hex"),
      description,
      severity: mapped.severity,
      category: mapped.category,
    })
    .select("id")
    .single();
  if (error || !row) {
    return NextResponse.json({ error: `Could not save your feedback${error?.message ? ": " + error.message : ""}` }, { status: 500 });
  }

  // attachments are best-effort — the submission stands even if one fails,
  // and the sender is told how many were not kept
  let kept = 0;
  if (files.length) {
    await supabase.storage.createBucket(FEEDBACK_BUCKET, { public: false }).catch(() => {});
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const path = `${row.id}/${i}-${Date.now()}.${FEEDBACK_FILE_EXT[f.type]}`;
      const buf = Buffer.from(await f.arrayBuffer());
      // Every attachment is judged by its bytes, never by its label (Kev,
      // 2026-10-08: every image). Admins alone see attachments, so 18+ stays;
      // one refused or not judged is dropped while the report stands, and a
      // child-safety one becomes a case. A video alone cannot be judged: it is
      // kept when it is declared one, no image decoder reads it, and its own
      // bytes open as a video container.
      const seen = await checkImageBytes(buf, { signal: req.signal });
      if (seen.verdict === "child_safety") {
        after(recordImageCase(supabase, { surface: "feedback", request: req, bytes: buf, scores: seen.scores, about: "An attachment to a feedback report." }));
      }
      const video = seen.verdict === "blocked" && seen.reason === NOT_AN_IMAGE && f.type.startsWith("video/") && isVideo(buf);
      if (!video && seen.verdict !== "clear" && seen.verdict !== "adult") continue;
      const up = await supabase.storage.from(FEEDBACK_BUCKET).upload(path, buf, { contentType: f.type, upsert: false });
      if (up.error) continue;
      const { error: rowError } = await supabase.from("feedback_attachments").insert({
        feedback_id: row.id, image_url: path, storage_key: path,
        file_size_bytes: f.size, mime_type: f.type, sort_order: i,
      });
      // A file no row points to is one no admin ever sees: taken down, not kept.
      if (rowError) {
        await supabase.storage.from(FEEDBACK_BUCKET).remove([path]);
        continue;
      }
      kept++;
    }
  }

  return NextResponse.json({ ok: true, dropped: files.length - kept }, { status: 201 });
}
