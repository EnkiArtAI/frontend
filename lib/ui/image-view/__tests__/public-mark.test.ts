import { describe, expect, it } from "vitest";
import { publicAsk, publicLabel } from "../public-mark";

/** The globe on the viewer's own image in the History (Kev, 2026-10-13). */
describe("publicAsk", () => {
  it("asks before sharing a private image, and says what sharing does", () => {
    const ask = publicAsk(false);
    expect(ask.title).toBe("Share this creation?");
    expect(ask.text).toContain("inspiration");
    expect(ask).toMatchObject({ ok: "Make public", cancel: "Keep private" });
  });

  it("asks before taking a public image back, and says where it leaves", () => {
    const ask = publicAsk(true);
    expect(ask.title).toBe("Make it private again?");
    expect(ask.text).toContain("Only you see it");
    expect(ask).toMatchObject({ ok: "Make private", cancel: "Keep public" });
  });

  it("names the mark by its state", () => {
    expect(publicLabel(false)).toBe("Private · share it");
    expect(publicLabel(true)).toBe("Public · make it private");
  });
});
