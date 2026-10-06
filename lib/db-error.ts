import { NextResponse } from "next/server";

/**
 * "Database unreachable" as a first-class answer (Kev, 2026-09-05: "wenn die
 * datenbank fehlt, so soll bitte ein fehler kommen und nicht einfach ne
 * cryptische fehlermeldung").
 *
 * supabase-js never throws on a dead host — it hands the route an error
 * object whose message is the raw fetch failure ("TypeError: fetch failed",
 * "getaddrinfo ENOTFOUND …"). Routes used to fold that into their generic
 * failure text ("Failed to generate nonce", "Wrong login or password"), so a
 * paused project looked like a user mistake. This maps the network class of
 * error to one honest 503 that every client can show verbatim.
 */
export const DB_UNAVAILABLE_CODE = "DB_UNAVAILABLE";
export const DB_UNAVAILABLE_MESSAGE =
  "The database is unreachable right now, so this can't be completed. Nothing is wrong on your side. Please try again in a minute.";

const NETWORK_FAILURE = /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|UND_ERR_CONNECT|UND_ERR_SOCKET/i;

/** For helpers that answer a boolean (allow-listed? exists?) and have no
    honest answer while the host is down: throw this instead of "false". */
export class DbUnreachableError extends Error {
  constructor() {
    super("database unreachable");
    this.name = "DbUnreachableError";
  }
}

/** True when a supabase-js / fetch error means the host could not be reached at all. */
export function isDbUnreachable(err: unknown): boolean {
  if (err instanceof DbUnreachableError) return true;
  if (!err || typeof err !== "object") return false;
  const e = err as { message?: unknown; details?: unknown; code?: unknown; cause?: unknown };
  const cause = e.cause as { message?: unknown; code?: unknown } | undefined;
  const text = [e.message, e.details, e.code, cause?.message, cause?.code]
    .filter((s): s is string => typeof s === "string")
    .join(" ");
  return NETWORK_FAILURE.test(text);
}

/** The one 503 every route returns when the database is down. */
export function dbUnavailableResponse() {
  return NextResponse.json(
    { success: false, error: DB_UNAVAILABLE_MESSAGE, code: DB_UNAVAILABLE_CODE },
    { status: 503, headers: { "Retry-After": "30" } },
  );
}
