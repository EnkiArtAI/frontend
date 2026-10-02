import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Link-preview bots read /generator/<id>'s head without the team cookie, and
 * every unfurl republishes it on X, Discord, Slack and Telegram. The card's
 * description fell back to the stored first characters of the prompt when
 * the creator wrote no description, for any id, drafts included.
 */

let row: Record<string, unknown> | null;
let ogRow: Record<string, unknown> | null = null;

vi.mock("@/lib/supabaseServer", () => ({
  getSupabaseServerClient: () => {
    const q = (t: string) => {
      const c: Record<string, unknown> = { maybeSingle: async () => ({ data: t === "prompts" ? (ogRow ?? row) : null, error: null }) };
      c.select = () => c;
      c.eq = () => c;
      return c;
    };
    return { from: q };
  },
}));

vi.mock("next/og", () => ({ ImageResponse: class { constructor(public element: unknown) {} } }));

import { generateMetadata } from "../../app/generator/[id]/page";
import { GET as ogImage } from "../../app/api/og/[id]/route";

const SECRET = "the artist's secret words around [subject]";
const LIVE = { is_listed: true, listing_status: "active", deleted_at: null };
const meta = async () => generateMetadata({ params: Promise.resolve({ id: "p1" }) });

beforeEach(() => {
  ogRow = null;
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

describe("the /api/og/<id> card image", () => {
  async function rendered(r: Record<string, unknown>) {
    ogRow = r;
    const res = (await ogImage(new Request("http://localhost/api/og/p1"), { params: Promise.resolve({ id: "p1" }) })) as unknown as { element: unknown };
    return JSON.stringify(res.element);
  }

  it("never shows the title of a prompt that is not live", async () => {
    expect(await rendered({ title: "the artist's secret words", is_listed: false, listing_status: "draft", deleted_at: null })).not.toContain("secret words");
  });

  it("shows a live prompt's title", async () => {
    expect(await rendered({ title: "Neon Koi", ...LIVE })).toContain("Neon Koi");
  });
});
