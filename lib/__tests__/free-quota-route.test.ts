import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ client: {}, getClient: vi.fn(), session: vi.fn(), quota: vi.fn() }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClientSafe: mocks.getClient }));
vi.mock("@/lib/session-user", () => ({ resolveSessionUserId: mocks.session }));
vi.mock("@/lib/generation/free-quota", () => ({ freeQuotaFor: mocks.quota }));
import { GET } from "../../app/api/generate-free/quota/route";

const USER = "11111111-1111-4111-8111-111111111111";
const quota = { used: 0, limit: 1, remaining: 1, exhausted: false, resetsAt: "2026-10-13T00:00:00Z" };
const request = (token?: string) => new NextRequest("http://localhost/api/generate-free/quota?userId=someone-else", { headers: token ? { "X-Session-Token": token } : {} });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getClient.mockReturnValue(mocks.client);
  mocks.session.mockResolvedValue(USER);
  mocks.quota.mockResolvedValue(quota);
});

describe("GET /api/generate-free/quota", () => {
  it("requires a session without looking up anyone's quota", async () => {
    expect((await GET(request())).status).toBe(401);
    expect(mocks.quota).not.toHaveBeenCalled();
  });

  it("requires the live, unsuspended account resolved from the session", async () => {
    mocks.session.mockResolvedValue(null);
    expect((await GET(request("invalid-session"))).status).toBe(401);
    expect(mocks.quota).not.toHaveBeenCalled();
  });

  it("ignores a requested account id and returns a private, noncached read", async () => {
    const result = await GET(request("valid-session"));
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ freeQuota: quota });
    expect(result.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.session).toHaveBeenCalledExactlyOnceWith(mocks.client, "valid-session");
    expect(mocks.quota).toHaveBeenCalledExactlyOnceWith(mocks.client, USER);
  });

  it("returns an outage when no database is configured", async () => {
    mocks.getClient.mockReturnValue(null);
    expect((await GET(request("valid-session"))).status).toBe(503);
    expect(mocks.session).not.toHaveBeenCalled();
  });

  it("does not expose provider or database error details", async () => {
    mocks.quota.mockRejectedValue(new Error("private upstream data"));
    const result = await GET(request("valid-session"));
    expect(result.status).toBe(503);
    expect(JSON.stringify(await result.json())).not.toContain("private upstream");
  });
});
