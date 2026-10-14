import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()), useState: <T>(v: T) => [v, vi.fn()], useRef: <T>(v: T) => ({ current: v }) }));
vi.mock("@/lib/session-headers", () => ({ sessionAuthHeaders: () => ({ "X-Session-Token": "local-test-session" }) }));
vi.mock("@/components/kit/notify", () => ({ notify: vi.fn() }));
import { useDiceRoll } from "@/hooks/useDiceRoll";
afterEach(() => vi.unstubAllGlobals());
describe("the current editor's Vary request", () => {
  it("posts named text variables to the guarded endpoint with the session", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ values: { subject: "fox", invalid: 3 } })));
    vi.stubGlobal("fetch", fetcher);
    expect(await useDiceRoll({ variables: ["", "subject"], context: "a portrait" }).roll()).toEqual({ subject: "fox" });
    expect(fetcher).toHaveBeenCalledWith("/api/workflow/variables", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Session-Token": "local-test-session" },
      body: JSON.stringify({ variables: [{ id: "subject", name: "subject", label: "subject", type: "text" }], context: "a portrait" }),
    });
  });
  it("calls no API without a named variable", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    expect(await useDiceRoll({ variables: [""], context: "" }).roll()).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("excludes checkboxes before asking and never calls the unguarded endpoint", () => {
    const editor = readSource(join(__dirname, "..", "..", "components", "prompt-editor", "PromptEditor.tsx"));
    const hook = readSource(join(__dirname, "..", "..", "hooks", "useDiceRoll.ts"));
    expect(editor).toContain('variables: varNames(doc.prompt).filter((n) => n && (doc.kinds[n] ?? "text") === "text"),');
    expect(editor + hook).not.toContain('/api/grok-fill');
    expect(existsSync(join(__dirname, "..", "..", "app", "api", "grok-fill", "route.ts"))).toBe(false);
  });
});
