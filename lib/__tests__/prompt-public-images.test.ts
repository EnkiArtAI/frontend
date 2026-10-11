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

  it("leave out the images of a banned or deleted account", async () => {
    db.current!.tables.generated_images = [img("g1", { user_id: "kept" }), img("g2", { user_id: "gone" }), img("g3", { user_id: "barred" })];
    db.current!.tables.users = [
      { id: "kept", deleted_at: null, account_status: "active" },
      { id: "gone", deleted_at: "2026-10-01T00:00:00Z", account_status: "deleted" },
      { id: "barred", deleted_at: null, account_status: "active" },
    ];
    db.current!.tables.bans = [{ user_id: "barred", lifted_at: null, expires_at: null }];
    expect((await read()).body.images.map((i: { id: string }) => i.id)).toEqual(["g1"]);
  });

  it("are none for a banned creator's prompt, whoever made them", async () => {
    db.current!.tables.generated_images = [img("g1", { user_id: "kept" })];
    db.current!.tables.users = [{ id: "kept", deleted_at: null, account_status: "active" }];
    db.current!.tables.bans = [{ user_id: "artist", lifted_at: null, expires_at: null }];
    expect((await read()).body).toEqual({ images: [] });
  });

  it("refuse an id that is not a prompt id", async () => {
    expect((await read("../x")).status).toBe(400);
  });
});

describe("the current image UI", () => {
  const view = readSource(join(__dirname, "..", "..", "components", "image-view", "useImageViewModel.ts"));
  const panel = readSource(join(__dirname, "..", "..", "components", "image-view", "ViewerPanel.tsx"));
  it("reads public images with the viewer headers and keeps them in the strip", () => {
    expect(view).toContain('/images'); expect(view).toContain('headers: viewerHeaders()');
    expect(readSource(join(__dirname, "..", "..", "components", "image-view", "PreviewStrip.tsx"))).toContain('const tiles = [...m.examples, ...m.community];');
  });
  it("offers the public switch on a recorded render and updates its two lists", () => {
    expect(panel).toContain('onChange={(e) => void m.setPublic(record, e.target.checked)}');
    expect(view).toContain('body: JSON.stringify({ visibility: on ? "public" : "private" }),');
    expect(view).toContain('queryKey: ["user-generations"]'); expect(view).toContain('queryKey: ["prompt-public-images"]');
  });
  it("does not give an upload a public record", async () => {
    const { recordOf } = await import("@/lib/ui/image-view/history");
    const row = { id: "upload", image_url: "https://local.example/u.png", image_urls: [], thumbnail_url: null, isUploaded: true, visibility: "private" as const, prompt_id: null, created_at: "" };
    expect(recordOf([row], row.image_url)).toBeUndefined();
  });
  it("says where a public image shows and retains its prompt relation", () => {
    expect(panel).toContain('record.prompt_id === m.promptId ? "Shown under this prompt and on your profile" : "Shown on your profile"');
    const list = readSource(join(__dirname, "..", "..", "app", "api", "generations", "route.ts"));
    expect(list).toContain('prompt_id: row.prompt_id ?? null,');
  });
  it("polls for an unrecorded render for at most one minute", () => {
    const own = readSource(join(__dirname, "..", "..", "components", "image-view", "useOwnRenders.ts"));
    expect(own).toContain('setInterval(refetch, 3000)');
    expect(own).toContain('setTimeout(() => clearInterval(tick), 60_000)');
    expect(own).toContain('waiting ? pollWhile(() => void refetch()) : undefined');
  });
});
