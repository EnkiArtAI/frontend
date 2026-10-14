import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";
import { setPillActive } from "@/lib/session-headers";
import type { GenerationRow } from "../history";
import { pollWhile, readOwnPage, waitingFor } from "@/components/image-view/useOwnRenders";

/* The viewer's own renders (components/image-view/useOwnRenders): read with
   the viewer's headers, or the owner's private rows and the 18+ pill are
   lost (adult-reads); asked again every 3 s for at most 60 s while a fresh
   render is not recorded yet (prompt-public-images). */

const row = (id: string, url: string): GenerationRow => ({
  id, image_url: url, image_urls: [url.replace(".png", ".webp")], thumbnail_url: null,
  isUploaded: false, visibility: "private", prompt_id: "p-1", created_at: "2026-10-09T10:00:00Z",
});
const job = (id: string, status: "rendering" | "ready" | "failed", imageUrl?: string) =>
  ({ id, createdAt: 0, status, setup: {}, imageUrl, seen: false });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setPillActive(false);
});

describe("one page of the viewer's renders", () => {
  it("is read with the viewer's headers: the session and the 18+ pill", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("localStorage", { getItem: (k: string) => (k === "enki_session_token" ? "tok-1" : null) });
    setPillActive(true);
    const fetch = vi.fn(async () => new Response(JSON.stringify({ generations: [row("g1", "https://s/a.png")], total: 1 })));
    vi.stubGlobal("fetch", fetch);
    const page = await readOwnPage("wallet 1", 100);
    expect(fetch).toHaveBeenCalledWith("/api/generations?userId=wallet%201&limit=100&offset=100", {
      headers: { "X-Session-Token": "tok-1", "X-Show-Adult": "1" },
    });
    expect(page).toEqual({ generations: [row("g1", "https://s/a.png")], total: 1 });
  });

  it("fails loudly on a refused read, so the rail says so instead of showing nothing", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 503 }));
    await expect(readOwnPage("w", 0)).rejects.toThrow("Your renders could not load (HTTP 503).");
  });
});

describe("asking again for a fresh render", () => {
  it("asks every 3 s and gives up after 60 s", () => {
    vi.useFakeTimers();
    const refetch = vi.fn();
    pollWhile(refetch);
    vi.advanceTimersByTime(2999);
    expect(refetch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refetch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(57_000);
    expect(refetch).toHaveBeenCalledTimes(20);
    vi.advanceTimersByTime(60_000);
    expect(refetch).toHaveBeenCalledTimes(20);
  });

  it("stops at once when the render is found", () => {
    vi.useFakeTimers();
    const refetch = vi.fn();
    const stop = pollWhile(refetch);
    vi.advanceTimersByTime(3000);
    stop();
    vi.advanceTimersByTime(60_000);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("waits only for finished renders the rows do not hold yet, by original or preview", () => {
    const rows = [row("g1", "https://s/a.png")];
    expect(waitingFor([job("j1", "ready", "https://s/a.png")], rows)).toBe("");
    expect(waitingFor([job("j1", "ready", "https://s/a.webp")], rows)).toBe("");
    expect(waitingFor([job("j2", "ready", "https://s/b.png"), job("j3", "rendering"), job("j4", "failed")], rows)).toBe("j2");
    expect(waitingFor([job("j2", "ready", "https://s/b.png"), job("j5", "ready", "https://s/c.png")], rows)).toBe("j2 j5");
  });

  it("is what the hook does while one waits, on the shared history key", () => {
    const hook = readSource(join(__dirname, "..", "..", "..", "..", "components", "image-view", "useOwnRenders.ts"));
    expect(hook).toContain('queryKey: ["user-generations", userKey],');
    expect(hook).toContain("queryFn: ({ pageParam }) => readOwnPage(userKey as string, pageParam),");
    expect(hook).toContain("const waiting = enabled ? waitingFor(jobs, rows) : \"\";");
    expect(hook).toContain("useEffect(() => (waiting ? pollWhile(() => void refetch()) : undefined), [waiting, refetch]);");
  });
});
