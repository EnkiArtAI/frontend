import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Neither generation route needs a custom header to be reached, so a page on
 * another site could post a prompt in a visitor's name as a form or plain
 * text, which a browser sends without asking: each one cost a prompt check
 * and could earn the visitor's address warnings. Only JSON is taken now, and
 * JSON from another site has to ask first.
 */

const checked = vi.fn();
vi.mock("@/lib/moderation/prompt-check", async (orig) => ({
  ...(await orig<typeof import("@/lib/moderation/prompt-check")>()),
  checkPrompt: (...a: unknown[]) => checked(...a),
}));

// The paid route sweeps stale intents on every request; here the database answers nothing.
const { db } = vi.hoisted(() => {
  const db: unknown = new Proxy(function () {}, {
    get: (_t, key) => (key === "then" ? (ok: (v: unknown) => unknown) => ok({ data: null, error: null }) : db),
    apply: () => db,
  });
  return { db };
});
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => db, getSupabaseServerClientSafe: () => null }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: () => {} }));

import { POST as free } from "../../app/api/generate-free/route";
import { POST as paid } from "../../app/api/generate-image/route";

type Route = (req: NextRequest) => Promise<Response>;
const ROUTES: [string, Route][] = [["generate-free", free as Route], ["generate-image", paid as Route]];
const body = (fields: Record<string, unknown>) => JSON.stringify({ prompt: "an explicit request", modelId: "m1", intentId: "i1", ...fields });

/** A request as a browser would send it with this content type; null sends bytes, which carry none. */
function request(path: string, contentType: string | null, fields: Record<string, unknown> = {}) {
  const req = new NextRequest(`http://enki.test/api/${path}`, {
    method: "POST",
    headers: contentType ? { "Content-Type": contentType } : {},
    body: contentType ? body(fields) : new TextEncoder().encode(body(fields)),
  });
  if (contentType === null) expect(req.headers.get("content-type")).toBeNull();
  return req;
}

describe.each(ROUTES)("%s", (path, route) => {
  it("refuses a form, plain text or a body without a type before anything is checked", async () => {
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", null]) {
      expect((await route(request(path, type))).status).toBe(415);
    }
    expect(checked).not.toHaveBeenCalled();
  });

  it("takes JSON", async () => {
    // Refused right after the body is read, for a reason of its own: nothing further runs.
    const res = await route(request(path, "application/json; charset=utf-8", path === "generate-free" ? { prompt: "" } : { resolution: "8k" }));
    expect(res.status).toBe(400);
  });
});
