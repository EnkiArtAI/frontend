import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Link-preview bots read /generator/<id>'s head without the team cookie, and
 * every unfurl republishes it on X, Discord, Slack and Telegram. The card's
 * description fell back to the stored first characters of the prompt when
 * the creator wrote no description, for any id, drafts included.
 */

let row: Record<string, unknown> | null;

vi.mock("@/lib/supabaseServer", () => ({
  getSupabaseServerClient: () => {
    const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: row, error: null }) };
    return { from: () => q };
  },
}));

import { generateMetadata } from "../../app/generator/[id]/page";

const SECRET = "the artist's secret words around [subject]";
const LIVE = { is_listed: true, listing_status: "active", deleted_at: null };
const meta = async () => generateMetadata({ params: Promise.resolve({ id: "p1" }) });

beforeEach(() => {
  row = { title: "Paid", description: "", public_prompt_text: SECRET, price_usd_cents: 150, ...LIVE };
});

describe("the /generator/<id> social card", () => {
  it("never carries a prompt's words when the creator wrote no description", async () => {
    expect(JSON.stringify(await meta())).not.toContain("secret words");
  });

  it("leads with the creator's description", async () => {
    row = { ...row, description: "A moody portrait" };
    expect((await meta()).description).toContain("A moody portrait");
  });

  it("gives an unlisted prompt the brand card", async () => {
    row = { ...row, description: "A draft nobody should see yet", is_listed: false, listing_status: "draft" };
    expect((await meta()).title).toBe("Enki Art");
  });
});
