import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * REC-1: the payment link (payment_intent_id, transaction_hash,
 * amount_paid_cents) reaches the generations row, recordGeneration returns
 * the generated_images id so the route can hand it back as imageId, a
 * generated_images insert failure still returns the generationId rather than
 * losing the whole record, and a recording failure on a PAID generation
 * alerts admins (not just a console.warn nobody reads) while a free
 * generation's failure does not spam them.
 */

type Row = Record<string, unknown>;
let inserts: { table: string; row: Row }[];
let updates: { table: string; row: Row }[];
let genImagesInsertError: { message: string } | null;
let notifyAdminsCalls: unknown[];

function chain(table: string) {
  const q: Record<string, unknown> = {
    insert: (row: Row) => {
      inserts.push({ table, row });
      return q;
    },
    update: (row: Row) => {
      updates.push({ table, row });
      return q;
    },
    single: async () => {
      if (table === "generated_images" && genImagesInsertError) {
        return { data: null, error: genImagesInsertError };
      }
      return { data: { id: `${table}-1` }, error: null };
    },
    then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok),
  };
  for (const m of ["select", "eq", "in", "is", "order", "limit", "maybeSingle"]) q[m] = () => q;
  return q;
}
const fake = { from: chain };

const store = vi.fn(async (url: string) => ({
  imageUrl: url,
  previewUrl: `${url}.preview.webp`,
  thumbnailUrl: `${url}.thumb.webp`,
}));
vi.mock("@/lib/crypto", () => ({ encryptString: () => ({ encrypted: "ct", iv: "iv", authTag: "tag", kid: "k1" }) }));
vi.mock("@/lib/generation/derivative-store", () => ({ storeGeneratedImage: (url: string) => store(url) }));
vi.mock("@/lib/admin-notify", () => ({
  notifyAdmins: (...args: unknown[]) => {
    notifyAdminsCalls.push(args);
    return Promise.resolve();
  },
}));

import { recordGeneration, attachImageDerivatives } from "@/lib/generation/record";

const OURS = "https://abc.public.blob.vercel-storage.com/generations/u1/1.png";
const baseRec = (extra: Row) =>
  ({
    userId: "u1", promptId: "p1", finalPrompt: "a", effectivePrompt: "a", variableValues: {},
    model: { id: "m1", name: "Model" } as never, route: { provider: "p", providerModel: "pm" } as never,
    boost: false, aspectRatio: null, resolution: null, seed: null, output: null, generationMs: 1,
    imageUrl: OURS, previewUrl: null, thumbnailUrl: null, ...extra,
  } as never);

const generationsRow = () => inserts.find((i) => i.table === "generations")?.row;

beforeEach(() => {
  inserts = [];
  updates = [];
  genImagesInsertError = null;
  notifyAdminsCalls = [];
  store.mockClear();
});

describe("recordGeneration: the payment link", () => {
  it("writes payment_intent_id, transaction_hash and amount_paid_cents onto the generations row", async () => {
    await recordGeneration(fake as never, baseRec({
      paymentIntentId: "intent-1",
      transactionHash: "5sigBase58...",
      amountPaidCents: 14,
      chainKey: "solana",
    }));
    expect(generationsRow()).toMatchObject({
      payment_intent_id: "intent-1",
      transaction_hash: "5sigBase58...",
      amount_paid_cents: 14,
      chain_key: "solana",
    });
  });

  it("writes nulls for a free generation that carries none of it", async () => {
    await recordGeneration(fake as never, baseRec({}));
    expect(generationsRow()).toMatchObject({
      payment_intent_id: null,
      transaction_hash: null,
      amount_paid_cents: null,
    });
  });
});

describe("recordGeneration: imageId", () => {
  it("returns the generated_images row id as imageId alongside generationId", async () => {
    const result = await recordGeneration(fake as never, baseRec({}));
    expect(result).toEqual({ generationId: "generations-1", imageId: "generated_images-1" });
  });

  it("still returns the generationId (not null) when the generated_images insert fails", async () => {
    genImagesInsertError = { message: "boom" };
    const result = await recordGeneration(fake as never, baseRec({}));
    expect(result).toEqual({ generationId: "generations-1", imageId: null });
  });

  it("does not call storeGeneratedImage again when the caller already brought previewUrl/thumbnailUrl", async () => {
    await recordGeneration(fake as never, baseRec({}));
    expect(store).not.toHaveBeenCalled();
  });
});

describe("recordGeneration: a lost row never loses the image, but a PAID loss is alerted", () => {
  it("alerts admins when a PAID generation's image row fails to write", async () => {
    genImagesInsertError = { message: "boom" };
    await recordGeneration(fake as never, baseRec({ paymentIntentId: "intent-1", amountPaidCents: 14 }));
    expect(notifyAdminsCalls.length).toBeGreaterThan(0);
  });

  it("does not alert admins when a FREE generation's image row fails to write", async () => {
    genImagesInsertError = { message: "boom" };
    await recordGeneration(fake as never, baseRec({}));
    expect(notifyAdminsCalls.length).toBe(0);
  });
});

describe("attachImageDerivatives", () => {
  it("fetches derivatives and updates the generated_images row with them", async () => {
    await attachImageDerivatives(fake as never, "img-1", OURS, "u1");
    expect(store).toHaveBeenCalledWith(OURS);
    const upd = updates.find((u) => u.table === "generated_images");
    expect(upd?.row).toMatchObject({ preview_url: `${OURS}.preview.webp`, thumbnail_url: `${OURS}.thumb.webp` });
  });

  it("never throws when the derivative store rejects", async () => {
    store.mockRejectedValueOnce(new Error("store down"));
    await expect(attachImageDerivatives(fake as never, "img-1", OURS, "u1")).resolves.toBeUndefined();
  });
});
