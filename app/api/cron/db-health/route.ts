import { NextRequest, NextResponse } from "next/server";
import { list, put, del } from "@vercel/blob";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { sendMail } from "@/lib/mailer";
import { cronDenied } from "@/lib/cron";

/* An open outage is a marker file in Blob storage, not a row: the database
   is the thing that is down. One mail when it appears, one when it goes. */
const MARKER = "ops/db-down.txt";

async function databaseAnswers(): Promise<boolean> {
  try {
    const { error } = await getSupabaseServerClient()
      .from("users").select("id").limit(1)
      .abortSignal(AbortSignal.timeout(10_000));
    return !error;
  } catch {
    return false;
  }
}

async function tell(to: string[], subject: string, text: string): Promise<boolean> {
  const sent = await Promise.all(to.map((address) => sendMail({ to: address, subject, text })));
  return sent.some((r) => r.ok);
}

/**
 * Every five minutes (vercel.json): is the database answering? Supabase was
 * paused for days in September and nobody heard of it, because notifyAdmins
 * reads its recipients from the database it would have to report on (ENG-08).
 * Recipients come from OPS_ALERT_EMAILS instead. The marker changes only once
 * a mail went out, so a failed send is retried on the next run, never lost.
 */
export async function GET(req: NextRequest) {
  const denied = cronDenied(req);
  if (denied) return denied;
  const to = (process.env.OPS_ALERT_EMAILS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!to.length || !process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json({ error: "Outage alerts are not configured on this environment (OPS_ALERT_EMAILS, BLOB_READ_WRITE_TOKEN)." }, { status: 503 });
  }

  const up = await databaseAnswers();
  const { blobs } = await list({ prefix: MARKER, limit: 1 });
  const open = blobs.find((b) => b.pathname === MARKER);
  const host = new URL(process.env.SUPABASE_URL ?? "http://unset").host;

  if (!up && !open) {
    const since = new Date().toISOString();
    if (await tell(to, "Enki: database unreachable", `The database (${host}) stopped answering at ${since}. The app answers 503 to everything that needs it. You get one more mail when it is back.`)) {
      await put(MARKER, since, { access: "public", addRandomSuffix: false, allowOverwrite: true, contentType: "text/plain" });
    }
  } else if (up && open) {
    if (await tell(to, "Enki: database back", `The database (${host}) answers again (${new Date().toISOString()}). It had been unreachable since ${open.uploadedAt.toISOString()}.`)) {
      await del(open.url);
    }
  }
  return NextResponse.json({ up });
}
