import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserId } from "@/lib/session-user";
import { isDbUnreachable, dbUnavailableResponse } from "@/lib/db-error";

/**
 * Private prompt / workflow library (Kev, 2026-09-05). Every row belongs to
 * the session's user and is only ever read back to that user — there is no
 * public listing and no other user's id is accepted anywhere.
 *   GET            → { items }      newest first
 *   POST  {name, kind, graph, promptText} → { item }
 *   DELETE ?id=    → { ok }
 */
export const dynamic = "force-dynamic";

const MAX_NAME = 120;
const MAX_TEXT = 20_000;
const MAX_GRAPH_BYTES = 400_000;

async function owner(request: NextRequest) {
  const supabase = getSupabaseServerClient();
  try {
    const userId = await resolveSessionUserId(supabase, request.headers.get("X-Session-Token"));
    return { supabase, userId, down: false };
  } catch (e) {
    if (isDbUnreachable(e)) return { supabase, userId: null, down: true };
    throw e;
  }
}

export async function GET(request: NextRequest) {
  const { supabase, userId, down } = await owner(request);
  if (down) return dbUnavailableResponse();
  if (!userId) return NextResponse.json({ error: "Login required" }, { status: 401 });
  const { data, error } = await supabase
    .from("saved_workflows")
    .select("id, name, kind, graph, prompt_text, created_at, updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(200);
  if (error) return isDbUnreachable(error) ? dbUnavailableResponse() : NextResponse.json({ error: "Library unavailable" }, { status: 500 });
  return NextResponse.json({ items: data ?? [] });
}

export async function POST(request: NextRequest) {
  const { supabase, userId, down } = await owner(request);
  if (down) return dbUnavailableResponse();
  if (!userId) return NextResponse.json({ error: "Login required" }, { status: 401 });
  let body: { name?: unknown; kind?: unknown; graph?: unknown; promptText?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const name = typeof body.name === "string" ? body.name.trim().slice(0, MAX_NAME) : "";
  if (!name) return NextResponse.json({ error: "A name is required" }, { status: 422 });
  const kind = body.kind === "prompt" ? "prompt" : "workflow";
  const promptText = typeof body.promptText === "string" ? body.promptText.slice(0, MAX_TEXT) : null;
  const graph = body.graph && typeof body.graph === "object" ? body.graph : null;
  if (graph && JSON.stringify(graph).length > MAX_GRAPH_BYTES) return NextResponse.json({ error: "Workflow too large to save" }, { status: 413 });
  if (!graph && !promptText) return NextResponse.json({ error: "Nothing to save" }, { status: 422 });

  const { data, error } = await supabase
    .from("saved_workflows")
    .insert({ user_id: userId, name, kind, graph, prompt_text: promptText })
    .select("id, name, kind, graph, prompt_text, created_at, updated_at")
    .single();
  if (error) return isDbUnreachable(error) ? dbUnavailableResponse() : NextResponse.json({ error: "Could not save" }, { status: 500 });
  return NextResponse.json({ item: data }, { status: 201 });
}

export async function DELETE(request: NextRequest) {
  const { supabase, userId, down } = await owner(request);
  if (down) return dbUnavailableResponse();
  if (!userId) return NextResponse.json({ error: "Login required" }, { status: 401 });
  const id = request.nextUrl.searchParams.get("id") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  // The owner filter is what makes this safe: a foreign id deletes nothing.
  const { error, count } = await supabase
    .from("saved_workflows")
    .delete({ count: "exact" })
    .eq("id", id)
    .eq("user_id", userId);
  if (error) return isDbUnreachable(error) ? dbUnavailableResponse() : NextResponse.json({ error: "Could not delete" }, { status: 500 });
  if (!count) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
