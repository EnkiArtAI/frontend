import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A prompt whose showcase image is one of our 18+ renders is 18+ itself. That
 * needs the stored URL to be the one the client was given: a render already in
 * our Blob store stays where it is instead of being copied under a new name
 * (found by round-2 review: the copy meant no URL ever matched).
 */

const puts: string[] = [];
vi.mock("@vercel/blob", () => ({ put: async (name: string) => { puts.push(name); return { url: `https://store.public.blob.vercel-storage.com/${name}` }; } }));
vi.mock("@/lib/imageDerivatives", () => ({ tryMakeDerivatives: async () => null }));

import { storeGeneratedImage } from "@/lib/generation/derivative-store";
import { showsAdultRender, promptMarkedAdult } from "@/lib/adult-content";

beforeEach(() => {
  puts.length = 0;
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test-token");
  vi.stubGlobal("fetch", async () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("storing a render", () => {
  it("keeps one already in our Blob store at the URL the client has", async () => {
    const url = "https://store.public.blob.vercel-storage.com/generations/1700000000_abc.png";
    const stored = await storeGeneratedImage(url, "user-1");
    expect(stored.imageUrl).toBe(url);
    expect(puts).toEqual([]);
  });

  it("still copies a provider's rented link into our store", async () => {
    const stored = await storeGeneratedImage("https://provider.example/tmp/x.png", "user-1");
    expect(puts).toHaveLength(1);
    expect(stored.imageUrl).toBe(`https://store.public.blob.vercel-storage.com/${puts[0]}`);
  });
});

describe("an 18+ showcase render", () => {
  const lookup = (opts: { adultUrls?: string[]; fail?: boolean }) => {
    const asked: unknown[][] = [];
    const fake = {
      from: () => {
        let urls: string[] = [];
        const q = {
          select: () => q, eq: () => q, limit: () => q,
          in: (_c: string, v: string[]) => { urls = v; asked.push(v); return q; },
          then: (ok: (r: unknown) => unknown) => Promise.resolve(opts.fail
            ? { data: null, error: { message: "fetch failed" } }
            : { data: urls.filter((u) => opts.adultUrls?.includes(u)).map((u) => ({ id: u })), error: null }).then(ok),
        };
        return q;
      },
    } as unknown as SupabaseClient;
    return { fake, asked };
  };

  it("marks the prompt", async () => {
    const { fake } = lookup({ adultUrls: ["https://store/a.png"] });
    expect(await showsAdultRender(fake, ["https://store/a.png"])).toBe(true);
  });

  it("does not mark it for an ordinary render", async () => {
    const { fake } = lookup({ adultUrls: [] });
    expect(await showsAdultRender(fake, ["https://store/b.png"])).toBe(false);
  });

  it("never sends a data: URL to the database", async () => {
    const { fake, asked } = lookup({});
    await showsAdultRender(fake, ["data:image/png;base64,AAAA", "https://store/c.png"]);
    for (const urls of asked) expect(urls).toEqual(["https://store/c.png"]);
  });

  it("reports a failed lookup as unknown, never as a mark", async () => {
    const { fake } = lookup({ fail: true });
    expect(await showsAdultRender(fake, ["https://store/d.png"])).toBeNull();
  });
});

describe("a stored prompt's mark", () => {
  it("reports a failed read as unknown, never as a mark", async () => {
    const fake = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "fetch failed" } }) }) }) }) } as unknown as SupabaseClient;
    expect(await promptMarkedAdult(fake, "p1")).toBeNull();
  });
});
