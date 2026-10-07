/**
 * POST /api/recovery/approve  { requestId, guardianId, code } → { ok, approved, threshold }
 *
 * A guardian redeems their emailed 7-digit code. At the threshold the request
 * flips to 'approved' and the OWNER can set a new password (complete route).
 * Brute force: 5 tries per request+guardian per window + code is hash-stored.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { sha256 } from "@/lib/password-reset";
import { recoveryThreshold } from "@/lib/recovery/threshold";

const bodySchema = z.object({
  requestId: z.string().uuid(),
  guardianId: z.string().uuid(),
  code: z.string().regex(/^\d{7}$/),
});

export async function POST(req: NextRequest) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const { requestId, guardianId, code } = parsed.data;

  const limit = checkRequestRateLimit(
    rateLimitKey(req, "recovery:approve", `${requestId}:${guardianId}`),
    5,
    15 * 60 * 1000,
  );
  if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

  const supabase = getSupabaseServerClient();
  const { data: request } = await supabase
    .from("recovery_requests")
    .select("id, user_id, status, expires_at")
    .eq("id", requestId)
    .maybeSingle();
  if (!request || request.status !== "pending" ||
      (request.expires_at && new Date(request.expires_at).getTime() <= Date.now())) {
    return NextResponse.json({ error: "This recovery request isn't active" }, { status: 400 });
  }

  const { data: approval } = await supabase
    .from("recovery_approvals")
    .select("code_hash, approved_at")
    .eq("request_id", requestId)
    .eq("guardian_id", guardianId)
    .maybeSingle();
  if (!approval) return NextResponse.json({ error: "Wrong code" }, { status: 400 });
  if (!approval.approved_at) {
    if (approval.code_hash !== sha256(code)) {
      return NextResponse.json({ error: "Wrong code" }, { status: 400 });
    }
    await supabase
      .from("recovery_approvals")
      .update({ approved_at: new Date().toISOString() })
      .eq("request_id", requestId)
      .eq("guardian_id", guardianId);
  }

  const [{ count: approved }, threshold] = await Promise.all([
    supabase
      .from("recovery_approvals")
      .select("guardian_id", { count: "exact", head: true })
      .eq("request_id", requestId)
      .not("approved_at", "is", null),
    recoveryThreshold(supabase, request.user_id),
  ]);

  if ((approved ?? 0) >= threshold) {
    await supabase.from("recovery_requests").update({ status: "approved" }).eq("id", requestId).eq("status", "pending");
  }

  return NextResponse.json({ ok: true, approved: approved ?? 0, threshold });
}
