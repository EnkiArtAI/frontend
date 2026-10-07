import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The child-safety auto-ban bans an account for good on the classifier's
 * sexual/minors score. On a marketplace prompt that score is of the artist's
 * words filled with the buyer's values, so it banned the buyer for good for
 * what the artist wrote.
 */

type Row = Record<string, unknown>;
let events: Row[];
const banUntil = vi.fn(async () => ({ id: "ban-1" }));

const table = (name: string) => {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "update"]) q[m] = () => q;
  q.insert = (row: Row) => { if (name === "automod_events") events.push(row); return q; };
  q.single = async () => ({ data: { id: "event-1" }, error: null });
  q.maybeSingle = async () => ({ data: name === "moderation_policy" ? { owner_user_id: "owner-1" } : null, error: null });
  q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(ok);
  return q;
};
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClientSafe: () => ({ from: table }) }));
vi.mock("@/lib/session-user", () => ({ resolveSessionUserWithBan: async () => ({ userId: "buyer-1", ban: null }) }));
vi.mock("@/lib/moderation/bans", () => ({ banUntil: (...a: unknown[]) => banUntil(...(a as [])) }));
vi.mock("@/lib/crypto", () => ({ encryptString: () => ({ encrypted: "ct", iv: "iv", authTag: "tag", kid: "k1" }) }));

import { childSafetyScore, recordModerationEvent } from "@/lib/moderation-enforcement";
import type { ModerationVerdict } from "@/lib/moderation";

const MINORS: ModerationVerdict = {
  allowed: false, tier: 2, category: "sexual/minors", enforcement: "review", matchedRules: [],
  scores: { "sexual/minors": 0.95 }, promptHash: "h", tier2Degraded: false,
} as unknown as ModerationVerdict;
const request = { headers: new Headers({ "X-Session-Token": "t" }) };

beforeEach(() => {
  events = [];
  banUntil.mockClear();
});

describe("the child-safety auto-ban", () => {
  it("bans the account for its own prompt", async () => {
    await recordModerationEvent(MINORS, { surface: "generate-image", request, prompt: "their own words" });
    expect(banUntil).toHaveBeenCalledOnce();
  });

  it("acts only on the classifier's own score at 0.9 and above", () => {
    expect(childSafetyScore(MINORS)).toBe(0.95);
    expect(childSafetyScore({ ...MINORS, scores: { "sexual/minors": 0.89 } })).toBeNull();
    // The word list reads letters, never meaning: it never acts on its own.
    expect(childSafetyScore({ ...MINORS, tier: 1 } as ModerationVerdict)).toBeNull();
  });

  it("never bans a buyer for good for one hit on an artist's words, and keeps the event for a human", async () => {
    await recordModerationEvent(MINORS, { surface: "generate-image", request, prompt: '{"subject":"a girl"}', promptId: "p1" });
    expect(banUntil).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ user_id: "buyer-1", review_state: "pending" });
  });
});
