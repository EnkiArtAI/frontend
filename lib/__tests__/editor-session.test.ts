import { describe, it, expect, vi, afterEach } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * The editor and apiRequest read Turnkey's session token only. Nothing writes
 * it since Turnkey was retired, so every prompt save went out anonymous and
 * was refused (found by review, 2026-10-03). They send the signed-in session.
 */

afterEach(() => vi.unstubAllGlobals());

describe("apiRequest", () => {
  it("sends the email session", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("localStorage", { getItem: (k: string) => (k === "enki_session_token" ? "email-tok" : null) });
    const seen: Record<string, string>[] = [];
    vi.stubGlobal("fetch", async (_u: string, init: { headers: Record<string, string> }) => {
      seen.push(init.headers);
      return new Response("{}", { status: 200 });
    });
    const { apiRequest } = await import("@/lib/queryClient");
    await apiRequest("POST", "/api/x", { a: 1 });
    expect(seen[0]["X-Session-Token"]).toBe("email-tok");
  });
});

describe("the current prompt editor's session", () => {
  const EDITOR = readSource(join(__dirname, "..", "..", "components", "prompt-editor", "PromptEditor.tsx"));
  const DICE = readSource(join(__dirname, "..", "..", "hooks", "useDiceRoll.ts"));
  it("sends the signed-in session with Release and Vary", () => {
    for (const code of [EDITOR, DICE]) expect(code).toContain('headers: { "Content-Type": "application/json", ...sessionAuthHeaders() }');
    expect(EDITOR).toContain('fetch("/api/prompt", {');
    expect(DICE).toContain('fetch("/api/workflow/variables", {');
  });
  it("does not read the retired session token", () => {
    for (const code of [EDITOR, DICE]) expect(code).not.toContain('turnkey_session_token');
    expect(readSource(join(__dirname, "..", "queryClient.ts"))).not.toContain('turnkey_session_token');
  });
});
