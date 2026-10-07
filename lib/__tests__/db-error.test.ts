import { describe, it, expect } from "vitest";
import { isDbUnreachable, dbUnavailableResponse, DbUnreachableError, DB_UNAVAILABLE_CODE } from "@/lib/db-error";

describe("isDbUnreachable", () => {
  it("recognises the helper-thrown marker, whatever its message says", () => {
    expect(isDbUnreachable(new DbUnreachableError())).toBe(true);
    expect(isDbUnreachable(new Error("database unreachable"))).toBe(false); // a plain Error with that text is not the marker
  });

  it("recognises the exact shape supabase-js hands a route on a dead host", () => {
    // Copied from the dev-server log of 2026-09-05 (paused project).
    expect(isDbUnreachable({
      message: "TypeError: fetch failed",
      details: "TypeError: fetch failed\n\nCaused by: Error: getaddrinfo ENOTFOUND qxbnuepqpnsixirnmdmu.supabase.co (ENOTFOUND)",
      hint: "",
      code: "",
    })).toBe(true);
  });

  it("recognises a thrown fetch error with the node cause attached", () => {
    const err = new TypeError("fetch failed");
    (err as { cause?: unknown }).cause = { code: "ECONNREFUSED", message: "connect ECONNREFUSED 127.0.0.1:54321" };
    expect(isDbUnreachable(err)).toBe(true);
  });

  it("does NOT fire on ordinary query errors — those keep their own messages", () => {
    expect(isDbUnreachable({ message: 'relation "saved_workflows" does not exist', code: "42P01", details: null, hint: null })).toBe(false);
    expect(isDbUnreachable({ message: "duplicate key value violates unique constraint", code: "23505" })).toBe(false);
    expect(isDbUnreachable(null)).toBe(false);
    expect(isDbUnreachable(undefined)).toBe(false);
    expect(isDbUnreachable("fetch failed")).toBe(false); // a bare string is not an error object
  });
});

describe("dbUnavailableResponse", () => {
  it("is a 503 with a human sentence, a machine code and a retry hint", async () => {
    const res = dbUnavailableResponse();
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("30");
    const body = await res.json();
    expect(body.code).toBe(DB_UNAVAILABLE_CODE);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/database is unreachable/i);
    expect(body.error).not.toMatch(/nonce|fetch|ENOTFOUND/i);
  });
});
