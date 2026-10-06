import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { putDurably } from "@/lib/generation/derivative-store";

/**
 * REC-2 against the REAL @vercel/blob SDK, pointed at a local store that
 * misbehaves on purpose. The SDK retries outages itself for ~17 minutes and
 * keeps retrying after a TimeoutError; a mocked put cannot show whether the
 * deadline holds against that, so nothing here is mocked but the store.
 */

type Mode = "down" | "rate-then-ok" | "forbidden";
let mode: Mode = "down";
let hits = 0;
const json = { "content-type": "application/json" };
const server = http.createServer((req, res) => {
  hits++;
  req.resume();
  req.on("end", () => {
    if (mode === "forbidden") return res.writeHead(403, json).end(JSON.stringify({ error: { code: "forbidden", message: "no" } }));
    if (mode === "down" || hits === 1) {
      const [status, code] = mode === "down" ? [503, "service_unavailable"] : [429, "rate_limited"];
      return res.writeHead(status, json).end(JSON.stringify({ error: { code, message: code } }));
    }
    res.writeHead(200, json).end(JSON.stringify({
      url: "https://s.public.blob.vercel-storage.com/generations/a.png",
      downloadUrl: "https://s.public.blob.vercel-storage.com/generations/a.png?download=1",
      pathname: "generations/a.png", contentType: "image/png", contentDisposition: "inline",
    }));
  });
});

beforeAll(() => new Promise<void>((r) => server.listen(0, "127.0.0.1", r)));
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  hits = 0;
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_teststore_secret");
  vi.stubEnv("VERCEL_BLOB_API_URL", `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const BYTES = Buffer.from([137, 80, 78, 71]);

describe("putDurably on the real SDK", () => {
  it("returns at the deadline while the store is down, though the SDK would retry for minutes", async () => {
    mode = "down";
    const started = Date.now();
    // The SDK's second retry cannot start before 3 s (1 s, then 2 s of backoff),
    // so an answer before 3 s proves the deadline cut into its sleep.
    expect(await putDurably("generations/a.png", BYTES, "image/png", started + 2_500)).toBeNull();
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(hits).toBeGreaterThan(0);
  }, 10_000);

  it("leaves no abandoned put calling the store after the deadline", async () => {
    mode = "down";
    expect(await putDurably("generations/a.png", BYTES, "image/png", Date.now() + 1_200)).toBeNull();
    const atDeadline = hits;
    await new Promise((r) => setTimeout(r, 4_000)); // past the SDK's next two backoffs
    expect(hits).toBe(atDeadline);
  }, 10_000);

  it("waits out a rate limit, which the SDK gives up on at once, and lands", async () => {
    mode = "rate-then-ok";
    const url = await putDurably("generations/a.png", BYTES, "image/png", Date.now() + 8_000);
    expect(url).toBe("https://s.public.blob.vercel-storage.com/generations/a.png");
    expect(hits).toBe(2);
  }, 10_000);

  it("gives up at once on what no retry can fix", async () => {
    mode = "forbidden";
    const started = Date.now();
    expect(await putDurably("generations/a.png", BYTES, "image/png", started + 8_000)).toBeNull();
    expect(hits).toBe(1);
    expect(Date.now() - started).toBeLessThan(1_000);
  }, 10_000);

  it("does not even start once the deadline has passed", async () => {
    mode = "down";
    const started = Date.now();
    expect(await putDurably("generations/a.png", BYTES, "image/png", started - 1)).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
  });
});
