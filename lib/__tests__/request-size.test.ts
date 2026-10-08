import { describe, it, expect } from "vitest";
import { tooLargeToSend, REQUEST_MAX_BYTES } from "@/lib/request-size";

/** Vercel turns away a request body over 4.5 MB before any route of ours runs. */
describe("tooLargeToSend", () => {
  it("lets a body of exactly the limit through and refuses one byte more", () => {
    // JSON adds the two quotes around a string.
    expect(tooLargeToSend("a".repeat(REQUEST_MAX_BYTES - 2))).toBe(false);
    expect(tooLargeToSend("a".repeat(REQUEST_MAX_BYTES - 1))).toBe(true);
  });

  it("counts the bytes that travel, not the characters", () => {
    // 2,000,000 characters, 4,000,002 bytes in UTF-8 with the quotes.
    expect(tooLargeToSend("é".repeat(REQUEST_MAX_BYTES / 2))).toBe(true);
  });

  it("stays under Vercel's 4.5 MB, counted either way", () => {
    expect(REQUEST_MAX_BYTES).toBeLessThan(4_500_000);
  });
});
