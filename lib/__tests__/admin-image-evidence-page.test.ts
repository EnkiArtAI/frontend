import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "./_read-source";

/**
 * A child-safety image case in the admin panel (2026-10-08): the image is held
 * as evidence and shown only by the moderation owner's logged reveal, and
 * only as an image the server sent back as one.
 */

const PAGE = readSource(join(__dirname, "..", "..", "app", "admin", "page.tsx"));

describe("the admin panel's image evidence", () => {
  it("offers the reveal on an image case, to the moderation owner alone", () => {
    expect(PAGE).toContain('{e.rules.includes("image-check") && imageBlock(e.id)}');
    expect(PAGE).toMatch(/\{data\?\.council\.isOwner && !revealed\[id\]\?\.image && \(\n\s+<Pill kind="plain" label="Reveal image \(logged\)"[^\n]*onClick=\{\(\) => void reveal\(id, "image"\)\} \/>/);
  });

  it("asks for one thing per reveal and keeps what an earlier reveal showed", () => {
    expect(PAGE).toContain('body: JSON.stringify({ resource: "automod", action: "reveal", id, reason, what }),');
    expect(PAGE).toContain('if (!res.ok || (what === "image" ? image : text) === null) { say(d.error || "That didn\'t work."); return; }');
    expect(PAGE).toContain('[id]: { ...(cur[id] ?? { text: null, source: "record", image: null }), ...(what === "image" ? { image } : { text, source: String(d.source) }) }');
  });

  it("shows only an image the server sent as an image", () => {
    expect(PAGE).toContain('const image = typeof d.image === "string" && d.image.startsWith("data:image/") ? d.image : null;');
    expect(PAGE).toContain("{revealed[id]?.image && <img src={revealed[id].image!}");
  });
});
