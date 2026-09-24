import { NextResponse } from "next/server";

/*
 * migrations/2026-09-24-search.sql is applied by Kev in the SQL editor,
 * never by the app. Until then the RPCs do not exist and PostgREST answers
 * with PGRST202 ("could not find the function ... in the schema cache"),
 * Postgres with 42883 (undefined function) or 42703 (undefined column).
 * That is one honest sentence, not a stack trace.
 */
export const SEARCH_NOT_MIGRATED_CODE = "SEARCH_NOT_MIGRATED";
export const SEARCH_NOT_MIGRATED_MESSAGE = "Search is not migrated yet.";

const MISSING_OBJECT = new Set(["PGRST202", "42883", "42703"]);

export function isSearchNotMigrated(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && MISSING_OBJECT.has(code);
}

export function searchNotMigratedResponse() {
  return NextResponse.json(
    { error: SEARCH_NOT_MIGRATED_MESSAGE, code: SEARCH_NOT_MIGRATED_CODE },
    { status: 503 },
  );
}

/** Query text as the SQL functions receive it: trimmed and bounded. */
export function searchQuery(raw: string | null): string {
  return (raw ?? "").trim().slice(0, 200);
}
