import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { encryptString, resetKeyringCache } from "@/lib/crypto";
import { readEvidence, sealEvidence, withheldEvidence, type StoredEvidence } from "@/lib/moderation/evidence";

/**
 * Nobody may read an artist's prompt text, mods and admins included, except
 * the moderation owner in a hard case (Kev, 2026-10-03). Every moderation
 * record went to the admin panel decrypted whole, a refused save's body and
 * a blocked buyer's filled artist text with it.
 */

const stored = (p: ReturnType<typeof encryptString> | null, surface = "generate-image"): StoredEvidence => ({
  evidence_ct: p?.encrypted, evidence_iv: p?.iv, evidence_tag: p?.authTag, evidence_kid: p?.kid, surface,
});
const ARTIST = "the artist's secret words around [subject]";

beforeEach(() => {
  process.env.FIELD_ENCRYPTION_KEY_B64 = randomBytes(32).toString("base64");
  resetKeyringCache();
});
afterEach(() => resetKeyringCache());

describe("what a moderator reads", () => {
  it("is the shown part, never the withheld one", () => {
    const view = readEvidence(stored(sealEvidence({ shown: '{"title":"Moody"}', withheld: ARTIST }), "upload"));
    expect(view).toEqual({ text: '{"title":"Moody"}', withheld: true, draft: false });
    expect(JSON.stringify(view)).not.toContain("secret words");
  });

  it("says when a record names a marketplace prompt instead of quoting it", () => {
    expect(readEvidence(stored(sealEvidence({ shown: '{"subject":"fox"}', promptId: "p1" })))).toEqual({ text: '{"subject":"fox"}', withheld: true, draft: false });
  });

  it("says when what is withheld is a draft by the requester's own word", () => {
    expect(readEvidence(stored(sealEvidence({ shown: "", withheld: "my draft", draft: true }), "generate-free"))).toEqual({ text: null, withheld: true, draft: true });
    // A mark without anything withheld claims nothing.
    expect(readEvidence(stored(sealEvidence({ shown: "a red fox", draft: true })))).toEqual({ text: "a red fox", withheld: false, draft: false });
  });

  it("is a user's own text as written", () => {
    expect(readEvidence(stored(sealEvidence({ shown: "a red fox" })))).toEqual({ text: "a red fox", withheld: false, draft: false });
  });

  it("cannot be steered by text that looks like a record", () => {
    // Typed by a user to hide part of their own prompt from moderators.
    const forged = JSON.stringify({ shown: "a red fox", withheld: "the part they want hidden" });
    expect(readEvidence(stored(sealEvidence({ shown: forged })))).toEqual({ text: forged, withheld: false, draft: false });
    expect(readEvidence(stored(encryptString(forged), "x402-generate"))).toEqual({ text: forged, withheld: false, draft: false });
  });

  it("withholds a save's or a generation's record from before the rule whole, since it may hold an artist's words", () => {
    // A body, an editor's draft, a paid prompt's filled text.
    for (const surface of ["upload", "generate-image", "generate-free"]) {
      expect(readEvidence(stored(encryptString(`Moody\n${ARTIST}`), surface))).toEqual({ text: null, withheld: true, draft: false });
    }
  });

  it("shows a record from before the rule as written where no artist's words could be", () => {
    expect(readEvidence(stored(encryptString('{"subject":"fox"}'), "x402-generate"))).toEqual({ text: '{"subject":"fox"}', withheld: false, draft: false });
  });

  it("shows nothing it cannot read, and claims nothing withheld", () => {
    expect(readEvidence(stored(null))).toEqual({ text: null, withheld: false, draft: false });
  });
});

describe("what the owner's reveal reads", () => {
  it("is the withheld part, or the prompt it names", () => {
    expect(withheldEvidence(stored(sealEvidence({ shown: "", withheld: ARTIST }), "upload"))).toEqual({ text: ARTIST, promptId: null });
    expect(withheldEvidence(stored(sealEvidence({ shown: "{}", promptId: "p1" })))).toEqual({ text: null, promptId: "p1" });
  });

  it("is a save's or a generation's whole record from before the rule", () => {
    for (const surface of ["upload", "generate-image", "generate-free"]) {
      expect(withheldEvidence(stored(encryptString(ARTIST), surface))).toEqual({ text: ARTIST, promptId: null });
    }
  });

  it("is nothing for a record that withholds nothing", () => {
    expect(withheldEvidence(stored(sealEvidence({ shown: "a red fox" })))).toEqual({ text: null, promptId: null });
    expect(withheldEvidence(stored(encryptString("a red fox"), "x402-generate"))).toEqual({ text: null, promptId: null });
  });
});
