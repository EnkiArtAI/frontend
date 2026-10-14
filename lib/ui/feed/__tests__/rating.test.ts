import { describe, expect, it } from "vitest";
import { ratingSummary } from "../rating";

const rows = (ratings: Array<number | null>) => ratings.map((rating, i) => ({ id: `c${i}`, rating, body: null }));

describe("ratingSummary", () => {
  it("shows nothing without a rating", () => {
    expect(ratingSummary({ comments: rows([null, null]), stats: { count: 2, avgRating: null } })).toBeNull();
    expect(ratingSummary({ comments: [], stats: { count: 0, avgRating: null } })).toBeNull();
  });

  it("takes the server's average and counts the ratings, not the comments", () => {
    expect(ratingSummary({ comments: rows([4, null, 5]), stats: { count: 3, avgRating: 4.2 } })).toEqual({
      avg: "4.2",
      count: "2",
      title: "4.2 from 2 ratings",
    });
  });

  it("falls back to the mean when the server sends no average", () => {
    expect(ratingSummary({ comments: rows([3, 4]), stats: { avgRating: null } })?.avg).toBe("3.5");
    expect(ratingSummary({ comments: rows([5]) })).toEqual({ avg: "5.0", count: "1", title: "5.0 from 1 rating" });
  });

  it("marks a full page of 100 rows as the latest ratings only", () => {
    const comments = rows([...Array(87).fill(4), ...Array(13).fill(null)]);
    expect(ratingSummary({ comments, stats: { avgRating: 4 } })).toEqual({
      avg: "4.0",
      count: "87+",
      title: "4.0 from the latest 87 ratings",
    });
    expect(ratingSummary({ comments: comments.slice(1), stats: { avgRating: 4 } })?.count).toBe("86");
  });

  it("survives a body that is not the contract", () => {
    expect(ratingSummary(undefined)).toBeNull();
    expect(ratingSummary({ comments: "x" })).toBeNull();
    expect(ratingSummary({ comments: [null, { rating: "5" }, { rating: Number.NaN }] })).toBeNull();
  });
});
