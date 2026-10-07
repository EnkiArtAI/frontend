import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

/**
 * A passkey challenge cookie is signed for one user, one purpose and five
 * minutes (review 2026-10-07). Unsigned, the server verified whatever
 * challenge the client sent: a stolen session could register a self-made
 * passkey, and a captured assertion could be replayed for any scope.
 */

vi.hoisted(() => { process.env.AUTH_PEPPER = Buffer.alloc(32, 9).toString("base64"); });
import { setChallengeCookie, readChallengeCookie, clearChallengeCookie } from "../webauthn";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

function issued(name: string, challenge: string, userId: string): string {
  const res = NextResponse.json({});
  setChallengeCookie(res, name, challenge, userId);
  return res.cookies.get(name)!.value;
}
const request = (name: string, value: string) => new NextRequest("http://enki.test/x", { headers: { cookie: `${name}=${value}` } });

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-07T12:00:00Z")); });
afterEach(() => vi.useRealTimers());

describe("a challenge cookie", () => {
  it("gives back the challenge to the user and purpose it was issued for", () => {
    expect(readChallengeCookie(request("pk_auth_challenge", issued("pk_auth_challenge", "abc", A)), "pk_auth_challenge", A)).toBe("abc");
  });

  it("is worthless when written by the client, for another user, another purpose or after five minutes", () => {
    expect(readChallengeCookie(request("pk_auth_challenge", "abc"), "pk_auth_challenge", A)).toBeUndefined();
    const real = issued("pk_auth_challenge", "abc", A);
    expect(readChallengeCookie(request("pk_auth_challenge", real), "pk_auth_challenge", B)).toBeUndefined();
    expect(readChallengeCookie(request("pk_reg_challenge", real), "pk_reg_challenge", A)).toBeUndefined();
    const [, expiry, mac] = real.split(".");
    expect(readChallengeCookie(request("pk_auth_challenge", `xyz.${expiry}.${mac}`), "pk_auth_challenge", A)).toBeUndefined();
    vi.setSystemTime(new Date("2026-10-07T12:05:01Z"));
    expect(readChallengeCookie(request("pk_auth_challenge", real), "pk_auth_challenge", A)).toBeUndefined();
  });

  it("is cleared on the response it is given, which comes back", () => {
    const res = NextResponse.json({ error: "x" }, { status: 400 });
    expect(clearChallengeCookie(res, "pk_auth_challenge")).toBe(res);
  });
});
