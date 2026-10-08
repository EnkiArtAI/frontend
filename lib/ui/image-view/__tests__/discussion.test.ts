import { describe, it, expect } from "vitest";
import { countLabel, loadDiscussion, readDiscussion, type CommentRow } from "../discussion";

const c = (id: string, rating: number | null, body: string | null): CommentRow => ({ id, handle: "mara", rating, body, createdAt: "2026-10-09T10:00:00Z" });

describe("readDiscussion", () => {
  const text = c("text", null, "Lovely");
  const star = c("star", 4, null);
  const both = c("both", 5, "Worth it");

  it("splits one table into comments (text only) and reviews (every rating, with its text)", () => {
    const d = readDiscussion({ comments: [text, star, both], stats: { count: 3, avgRating: 4.5 } });
    expect(d.comments).toEqual([text]);
    expect(d.reviews).toEqual([star, both]);
    expect(d.avgRating).toBe(4.5);
  });

  it("gives the phone, which has no Reviews tab, every row with text, rated or not, newest first as read", () => {
    expect(readDiscussion({ comments: [both, star, text] }).written).toEqual([both, text]);
  });

  it("has no rating to show without one, and nothing from a body that is not the route's", () => {
    expect(readDiscussion({ comments: [text], stats: { count: 1, avgRating: null } }).avgRating).toBeNull();
    expect(readDiscussion(null)).toEqual({ comments: [], reviews: [], written: [], avgRating: null, capped: false });
  });

  it("is capped once the read holds the route's 100 rows", () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => c(String(i), 5, null));
    expect(readDiscussion({ comments: rows(100) }).capped).toBe(true);
    expect(readDiscussion({ comments: rows(99) }).capped).toBe(false);
  });

  it("countLabel reads \"n+\" once capped", () => {
    expect(countLabel(100, true)).toBe("100+");
    expect(countLabel(12, false)).toBe("12");
  });
});

describe("loadDiscussion", () => {
  const answer = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });

  it("reads the prompt's comments", async () => {
    const asked: string[] = [];
    const get = async (url: RequestInfo | URL) => {
      asked.push(String(url));
      return new Response(JSON.stringify({ comments: [c("a", null, "Hi")], stats: { avgRating: null } }), { status: 200 });
    };
    expect((await loadDiscussion("p/1", get as typeof fetch)).comments.map((r) => r.id)).toEqual(["a"]);
    expect(asked).toEqual(["/api/prompts/p%2F1/comments"]);
  });

  it("fails with the server's own sentence, never as an empty list", async () => {
    await expect(loadDiscussion("p1", answer(503, { error: "The database is unreachable" }) as typeof fetch)).rejects.toThrow("The database is unreachable");
  });

  it("fails with the status when the server says nothing", async () => {
    await expect(loadDiscussion("p1", answer(500, {}) as typeof fetch)).rejects.toThrow("The feedback could not load (HTTP 500).");
  });

  it("says so when the connection is lost", async () => {
    const lost = async () => { throw new TypeError("Failed to fetch"); };
    await expect(loadDiscussion("p1", lost as typeof fetch)).rejects.toThrow("The feedback could not load. Check your connection and try again.");
  });
});
