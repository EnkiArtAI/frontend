import { describe, it, expect, beforeEach, vi } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";
import { fakePostgrest } from "./_fake-postgrest";

/**
 * Public images of a prompt (Kev, 2026-10-08): every generation is private
 * until its owner makes it public, in My Gallery or in the image UI when
 * clicking the image in the history; public ones show in a row "Made with
 * this prompt" below the showcase strip. Only a listed prompt shows them, and
 * 18+ ones only to a viewer who may see 18+.
 */

const db = vi.hoisted(() => ({ current: null as ReturnType<typeof import("./_fake-postgrest").fakePostgrest> | null }));
const seen = vi.hoisted(() => ({ showAdult: false, userId: null as string | null }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => db.current!.client }));
vi.mock("@/lib/adult-content", async (original) => ({
  ...(await original<typeof import("@/lib/adult-content")>()),
  viewer: async () => ({ userId: seen.userId, showAdult: seen.showAdult }),
}));

import { GET } from "../../app/api/prompts/[id]/images/route";

const P = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER = "aaaaaaaa-0000-4000-8000-000000000002";
const LISTED = { id: P, creator_id: "artist", is_listed: true, listing_status: "active", deleted_at: null, is_adult: false };
const img = (id: string, extra: Record<string, unknown> = {}) => ({
  id, prompt_id: P, storage_url: `https://blob/${id}.png`, preview_url: `https://blob/${id}.preview.webp`,
  thumbnail_url: `https://blob/${id}.thumb.webp`, visibility: "public", is_uploaded: false, deleted_at: null, is_adult: false,
  created_at: "2026-10-08T10:00:00Z", ...extra,
});

const read = async (id = P) => {
  const res = await GET(new Request(`http://enki.test/api/prompts/${id}/images`), { params: Promise.resolve({ id }) });
  return { status: res.status, body: await res.json() };
};

beforeEach(() => {
  db.current = fakePostgrest();
  db.current.tables.prompts = [LISTED];
  db.current.tables.generated_images = [];
  Object.assign(seen, { showAdult: false, userId: null });
});

describe("the images people made public with a prompt", () => {
  it("are the public, recorded, live ones of this prompt only, as the preview with its thumbnail", async () => {
    db.current!.tables.generated_images = [
      img("g1"),
      img("g2", { visibility: "private" }),
      img("g3", { is_uploaded: true }),
      img("g4", { deleted_at: "2026-10-08T11:00:00Z" }),
      img("g5", { prompt_id: OTHER }),
      img("g6", { preview_url: null, thumbnail_url: null }),
    ];
    const { status, body } = await read();
    expect(status).toBe(200);
    expect(body.images).toEqual([
      { id: "g1", url: "https://blob/g1.preview.webp", thumbnailUrl: "https://blob/g1.thumb.webp", createdAt: "2026-10-08T10:00:00Z" },
      { id: "g6", url: "https://blob/g6.png", thumbnailUrl: "https://blob/g6.png", createdAt: "2026-10-08T10:00:00Z" },
    ]);
  });

  it("show 18+ ones only to a viewer who may see 18+", async () => {
    db.current!.tables.generated_images = [img("g1"), img("g2", { is_adult: true })];
    expect((await read()).body.images.map((i: { id: string }) => i.id)).toEqual(["g1"]);
    seen.showAdult = true;
    expect((await read()).body.images.map((i: { id: string }) => i.id)).toEqual(["g1", "g2"]);
  });

  it("are none for a prompt that is not on sale, or 18+ to a viewer who may not see it", async () => {
    db.current!.tables.generated_images = [img("g1")];
    db.current!.tables.prompts = [{ ...LISTED, is_listed: false }];
    expect((await read()).body.images).toEqual([]);
    db.current!.tables.prompts = [{ ...LISTED, deleted_at: "2026-10-08T09:00:00Z" }];
    expect((await read()).body.images).toEqual([]);
    db.current!.tables.prompts = [{ ...LISTED, is_adult: true }];
    expect((await read()).body.images).toEqual([]);
    seen.showAdult = true;
    expect((await read()).body.images).toHaveLength(1);
  });

  it("refuse an id that is not a prompt id", async () => {
    expect((await read("../x")).status).toBe(400);
  });
});

describe("the image UI", () => {
  const VIEW = readSource(join(__dirname, "..", "..", "components", "PromptGeneratorView.tsx"));

  it("shows them in a row below the showcase strip, above the comments", () => {
    const row = VIEW.indexOf('aria-label="Made with this prompt"');
    expect(row).toBeGreaterThan(VIEW.indexOf('className="pgv-thumb-row"'));
    expect(row).toBeLessThan(VIEW.indexOf('className="pgv-center-tabs"'));
    expect(VIEW).toContain("fetch(`/api/prompts/${encodeURIComponent(promptId)}/images`, { headers: viewerHeaders() })");
  });

  it("offers the Public switch on your own image in the large view, and makes it public or private", () => {
    expect(VIEW).toMatch(/for \(const url of \[g\.image_url, \.\.\.\(g\.image_urls \?\? \[\]\)\]\)/);
    expect(VIEW).toContain("const own = history.includes(url) ? ownImages.get(url) : undefined;");
    expect(VIEW).toContain('body: JSON.stringify({ visibility: isPublic ? "public" : "private" })');
    expect(VIEW).toContain("onChange={(e) => void setImagePublic(own.id, e.target.checked)}");
    expect(VIEW).toContain("queryClient.invalidateQueries({ queryKey: publicQueryKey });");
  });

  it("offers no switch on an upload, which never goes public", () => {
    expect(VIEW).toMatch(/for \(const g of genData\?\.data\?\.generations \?\? genData\?\.generations \?\? \[\]\) \{\n\s+if \(g\.isUploaded\) continue;/);
  });

  it("says where a public image shows: under this prompt only when it was made with it, and on the profile", () => {
    expect(VIEW).toContain('{!own.isPublic ? "Only you see it" : own.promptId === promptId ? "Shown under this prompt and on your profile" : "Shown on your profile"}');
    const list = readSource(join(__dirname, "..", "..", "app", "api", "generations", "route.ts"));
    expect(list).toContain("prompt_id: row.prompt_id ?? null,");
    expect(list).toMatch(/\.select\("id, prompt_id, storage_url/);
  });

  it("checks back while a fresh render is not recorded yet, every 3 s for 60 s at most", () => {
    expect(VIEW).toContain("return waiting && Date.now() - lastRunAt.current < 60_000 ? 3000 : false;");
    expect(VIEW).toContain("const waiting = localHistoryRef.current.some((url) => !known.has(url));");
    expect(VIEW).toMatch(/lastRunAt\.current = Date\.now\(\);\n\s+if \(userKey\) queryClient\.invalidateQueries\(\{ queryKey: genQueryKey \}\);/);
    expect(VIEW).toContain("localHistoryRef.current = localHistory;");
  });
});
