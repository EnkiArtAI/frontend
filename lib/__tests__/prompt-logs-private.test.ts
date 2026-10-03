import { describe, it, expect, vi, afterEach } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";
import { generateImageWithPollinations } from "@/backend/services/pollinations-image-generation";

/**
 * The agent rail decrypts a paid prompt and hands it to an image adapter.
 * Two adapters logged its first 100 characters, and Pollinations, which
 * carries the prompt in its URL, published every render to its public feed.
 */

const SECRET = "the artist's secret words, long enough to be worth stealing from a deployment log";

afterEach(() => vi.unstubAllGlobals());

describe("Pollinations keeps a prompt private", () => {
  async function render() {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await generateImageWithPollinations(SECRET, "1:1", "1K", "flux");
    const logged = log.mock.calls.flat().join("\n");
    log.mockRestore();
    return { url: String((fetchMock.mock.calls[0] as unknown[])[0]), logged };
  }

  it("keeps the render out of the public feed", async () => {
    expect(new URL((await render()).url).searchParams.get("private")).toBe("true");
  });

  it("never logs the prompt's text", async () => {
    expect((await render()).logged).not.toContain(SECRET.slice(0, 20));
  });
});

describe("no image adapter logs prompt text", () => {
  const dir = join(__dirname, "..", "..", "backend", "services");
  const adapters = readdirSync(dir).filter((f) => /-image-generation\.ts$/.test(f));

  it.each(adapters)("%s", (f) => {
    expect(readSource(join(dir, f))).not.toMatch(/console\.\w+\([^)]*prompt\.(substring|slice)\(/i);
  });
});
