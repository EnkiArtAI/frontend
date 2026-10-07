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

describe("the prompt editor", () => {
  const EDITOR = readSource(join(__dirname, "..", "..", "components", "EnkiPromptEditor.tsx"));

  it("saves, releases and rolls dice with the signed-in session", () => {
    expect(EDITOR).toMatch(/fetch\("\/api\/prompt", \{\n\s+method: "POST",\n\s+headers: \{ "Content-Type": "application\/json", \.\.\.sessionAuthHeaders\(\) \},/);
    // A release is that same save (lib/__tests__/editor-release.test.ts), so it carries the session too.
    expect(EDITOR).toContain("await savePromptMutation.mutateAsync({ release: true });");
    expect(EDITOR).toMatch(/headers=\{sessionAuthHeaders\(\)\}/);
  });

  it("never reads the retired Turnkey token", () => {
    expect(EDITOR).not.toMatch(/turnkey_session_token/);
    expect(readSource(join(__dirname, "..", "queryClient.ts"))).not.toMatch(/turnkey_session_token/);
  });
});
