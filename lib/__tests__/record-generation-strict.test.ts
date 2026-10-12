import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerationRecord } from "@/lib/generation/record";

const state = vi.hoisted(() => ({
  rows: [] as { table: string; row: Record<string, unknown> }[], failTable: "", throwTable: "", store: vi.fn(),
  updates: [] as Record<string, unknown>[], filters: [] as unknown[][],
}));
vi.mock("@/lib/crypto", () => ({ encryptString: () => ({ encrypted: "fixture-ciphertext", iv: "fixture-iv", authTag: "fixture-tag" }) }));
vi.mock("@/lib/generation/derivative-store", () => ({ storeGeneratedImage: (...args: unknown[]) => state.store(...args) }));
import { recordGeneration, GenerationRecordError, recordGenerationReferences, recordGenerationRenditions } from "@/lib/generation/record";

const GENERATION = "33333333-3333-4333-8333-333333333333";
const db = {
  from: (table: string) => {
    const result = () => {
      if (state.throwTable === table) throw new Error("fixture raw database failure");
      return { data: { id: table === "prompts" ? "prompt-id" : GENERATION }, error: state.failTable === table ? { message: "fixture raw database failure" } : null };
    };
    const q = {
      insert: (row: Record<string, unknown>) => { state.rows.push({ table, row }); return q; },
      update: (row: Record<string, unknown>) => { state.updates.push(row); return q; },
      eq: (key: string, value: unknown) => { state.filters.push([key, value]); return q; },
      select: () => q, single: async () => result(),
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve().then(result).then(resolve, reject),
    };
    return q;
  },
};
const rec = (overrides: Partial<GenerationRecord> = {}): GenerationRecord => ({
  userId: "11111111-1111-4111-8111-111111111111", promptId: "prompt-id",
  finalPrompt: "a blue bird", effectivePrompt: "a blue bird", variableValues: {},
  model: { id: "model-id", name: "Model" } as GenerationRecord["model"],
  route: { provider: "openai", providerModel: "configured-model" } as GenerationRecord["route"],
  boost: false, aspectRatio: "1:1", resolution: "2K", seed: null,
  output: null, generationMs: 1, workflow: null,
  imageUrl: "https://enki.public.blob.vercel-storage.com/generated.png", previewUrl: null,
  ...overrides,
});
beforeEach(() => {
  vi.clearAllMocks(); state.rows = []; state.updates = []; state.filters = []; state.failTable = ""; state.throwTable = "";
  state.store.mockImplementation(async (url: string) => ({ imageUrl: url, previewUrl: null, thumbnailUrl: null }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("Strict recording is the prerequisite for escrow delivery", () => {
  it("returns only after both generation and accepted generated-image inserts finish", async () => {
    expect(await recordGeneration(db as never, rec(), { requireAcceptedImage: true })).toBe(GENERATION);
    expect(state.rows.map((row) => row.table)).toEqual(["generations", "generated_images"]);
    expect(state.rows[1].row).toMatchObject({ generation_id: GENERATION, accepted: true, is_uploaded: false, storage_url: rec().imageUrl });
    expect(state.store).not.toHaveBeenCalled();
  });
  it.each(["prompts", "generations", "generated_images"])("rejects a failed %s insert instead of returning a billable generation", async (table) => {
    state.failTable = table;
    await expect(recordGeneration(db as never, rec({ promptId: null }), { requireAcceptedImage: true }))
      .rejects.toThrow(GenerationRecordError);
  });
  it("does not expose the raw database exception in strict failures", async () => {
    state.throwTable = "generated_images";
    await expect(recordGeneration(db as never, rec(), { requireAcceptedImage: true }))
      .rejects.toThrow("The generated image could not be saved");
  });
  it("names the refusing step for the server, apart from the user's sentence (devnet 2026-10-13)", async () => {
    const strict = async (r: GenerationRecord): Promise<GenerationRecordError> => {
      try { await recordGeneration(db as never, r, { requireAcceptedImage: true }); } catch (e) { return e as GenerationRecordError; }
      throw new Error("expected a strict refusal");
    };
    expect((await strict(rec({ imageUrl: null }))).reason).toBe("image url is not https");
    state.failTable = "generations";
    const refused = await strict(rec());
    expect(refused.reason).toMatch(/^generations insert: /);
    expect(refused.message).toBe("The generated image could not be saved. Please check your image history before trying again.");
  });
  it.each([null, "", "data:image/png;base64,Zm9v", "http://fixture.test/image.png", "bad-url"])(
    "refuses non-durable strict image URL %s before writing any rows", async (imageUrl) => {
      await expect(recordGeneration(db as never, rec({ imageUrl }), { requireAcceptedImage: true })).rejects.toThrow(GenerationRecordError);
      expect(state.rows).toHaveLength(0);
    },
  );
  it("keeps existing best-effort behavior for other generation callers", async () => {
    state.failTable = "generated_images";
    expect(await recordGeneration(db as never, rec())).toBe(GENERATION);
  });
  it("stores optional references in their original positions", async () => {
    await recordGenerationReferences(db as never, GENERATION, [null, {
      url: "https://fixture.test/reference.png", mimeType: "image/png", bytes: 1, contentHash: "fixture-hash",
    }]);
    expect(state.rows[0]).toMatchObject({ table: "generation_reference_images", row: [expect.objectContaining({ generation_id: GENERATION, sequence_index: 1 })] });
  });
  it("updates optional previews only for the saved generation and owner, without changing billing truth", async () => {
    state.store.mockResolvedValue({ imageUrl: rec().imageUrl, previewUrl: "https://fixture.test/preview.webp", thumbnailUrl: "https://fixture.test/thumb.webp" });
    await recordGenerationRenditions(db as never, GENERATION, rec().userId, rec().imageUrl!, 1234);
    expect(state.store).toHaveBeenCalledWith(rec().imageUrl, rec().userId, 1234);
    expect(state.updates).toEqual([{ preview_url: "https://fixture.test/preview.webp", thumbnail_url: "https://fixture.test/thumb.webp" }]);
    expect(state.filters).toEqual([["generation_id", GENERATION], ["user_id", rec().userId]]);
  });
  it("does not change a saved image when optional previews are unavailable", async () => {
    await recordGenerationRenditions(db as never, GENERATION, rec().userId, rec().imageUrl!, 1234);
    expect(state.updates).toHaveLength(0);
  });
});
