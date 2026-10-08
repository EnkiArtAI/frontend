/**
 * POST { targetType, targetId, reason, details? } — a signed-in user reports a
 * prompt, an image or a profile (Kev, 2026-10-08). The report waits in the
 * admin panel's Reports tab. Reporting the same thing again while the first
 * report is still open changes nothing.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserId } from "@/lib/session-user";
import { dbUnavailableResponse, isDbUnreachable } from "@/lib/db-error";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { REPORT_REASONS, REPORT_TARGETS } from "@/lib/report-reasons";

/** Where each target's id lives. */
const TABLE = { prompt: "prompts", generation: "generated_images", user: "users" } as const;

const schema = z
  .object({
    targetType: z.enum(REPORT_TARGETS),
    targetId: z.string().uuid(),
    reason: z.enum(REPORT_REASONS.map((r) => r.value)),
    details: z.string().trim().max(1000).optional(),
  })
  .refine((v) => v.reason !== "other" || !!v.details, { message: "Tell us what is wrong" });

export async function POST(req: NextRequest) {
  const supabase = getSupabaseServerClient();
  try {
    const userId = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
    if (!userId) return NextResponse.json({ error: "Sign in to report" }, { status: 401 });
    const limit = checkRequestRateLimit(rateLimitKey(req, "report", userId), 10, 3_600_000);
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid report" }, { status: 400 });
    }
    const { targetType, targetId, reason, details } = parsed.data;

    const [target, open] = await Promise.all([
      supabase.from(TABLE[targetType]).select("id").eq("id", targetId).maybeSingle(),
      supabase.from("reports").select("id")
        .eq("reporter_user_id", userId).eq("target_type", targetType).eq("target_uuid", targetId)
        .eq("status", "pending").limit(1),
    ]);
    if (target.error || open.error) throw target.error ?? open.error;
    if (!target.data) return NextResponse.json({ error: "Nothing to report here" }, { status: 404 });
    if (open.data?.length) return NextResponse.json({ ok: true });

    const { error } = await supabase.from("reports").insert({
      reporter_user_id: userId,
      target_type: targetType,
      target_uuid: targetId,
      reason,
      details: details || null,
      severity: REPORT_REASONS.find((r) => r.value === reason)!.severity,
    });
    if (error) throw error;
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (e) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    console.error("[reports] failed:", (e as { message?: string })?.message ?? e);
    return NextResponse.json({ error: "Could not send the report. Try again." }, { status: 500 });
  }
}
