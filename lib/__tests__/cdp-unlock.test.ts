import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The client half of the wallet unlock (Kev, 2026-10-07): a wallet action
 * waits for the unlock before its own timeout starts, so the user can answer
 * the dialog; a cancelled unlock sends nothing; without a CDP runtime (wallet
 * logins, guests) nothing waits. The last address per email stands in while
 * the wallet is locked, and logging out forgets it.
 */

const store = new Map<string, string>();
vi.stubGlobal("window", new EventTarget());
// A browser-like localStorage: Object.keys lists what is stored.
const api: Record<string, unknown> = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
vi.stubGlobal("localStorage", new Proxy({}, {
  get: (_, k: string) => api[k] ?? store.get(k),
  ownKeys: () => [...store.keys()],
  getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
}));

import {
  CDP_SIGN_REQUEST, CDP_SIGN_RESULT, ensureCdpWallet, registerCdpEnsure, requestCdpSign,
  rememberCdpAddress, rememberedCdpAddress, forgetCdpAddresses, fetchWalletJwt, isCdpLocked, cdpClosedReason,
} from "../cdp-bridge";

const answerSigns = () => window.addEventListener(CDP_SIGN_REQUEST, (e) => {
  const { id } = (e as CustomEvent).detail as { id: string };
  window.dispatchEvent(new CustomEvent(CDP_SIGN_RESULT, { detail: { id, signedTransaction: "signed" } }));
});

beforeEach(() => {
  registerCdpEnsure(null);
  store.clear();
});

describe("a wallet action", () => {
  it("goes ahead at once without a CDP runtime", async () => {
    await expect(ensureCdpWallet()).resolves.toBeUndefined();
  });

  it("waits for the unlock before its timeout starts", async () => {
    answerSigns();
    let release!: () => void;
    registerCdpEnsure(() => new Promise<void>((r) => { release = r; }));
    const signing = requestCdpSign("tx", 50);
    await new Promise((r) => setTimeout(r, 120)); // longer than the timeout: the user is typing a code
    release();
    await expect(signing).resolves.toBe("signed");
  });

  it("sends nothing when the unlock is cancelled", async () => {
    const asked = vi.fn();
    window.addEventListener(CDP_SIGN_REQUEST, asked);
    registerCdpEnsure(async () => { throw new Error("Not confirmed, nothing was signed."); });
    await expect(requestCdpSign("tx")).rejects.toThrow(/Not confirmed/);
    expect(asked).not.toHaveBeenCalled();
  });
});

describe("the lock", () => {
  const answer = (status: number, body: unknown) =>
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: status < 300, status, json: async () => body })));

  it("is whatever the JWT route said last: 403 { locked } locks, a JWT unlocks", async () => {
    answer(403, { locked: true });
    expect(await fetchWalletJwt()).toBeUndefined();
    expect(isCdpLocked()).toBe(true);
    answer(200, { jwt: "jwt" });
    expect(await fetchWalletJwt()).toBe("jwt");
    expect(isCdpLocked()).toBe(false);
  });

  it("names a refusal the user must answer elsewhere (an email to confirm), and is no lock", async () => {
    answer(403, { confirmEmail: true, error: "Confirm your email to open your wallet." });
    expect(await fetchWalletJwt()).toBeUndefined();
    expect(isCdpLocked()).toBe(false);
    expect(cdpClosedReason()).toBe("Confirm your email to open your wallet.");
    answer(200, { jwt: "jwt" });
    await fetchWalletJwt();
    expect(cdpClosedReason()).toBeNull();
  });

  it("is never an outage or another refusal: no dialog for those", async () => {
    for (const [status, body] of [[503, { error: "down" }], [403, { error: "other" }]] as const) {
      answer(403, { locked: true });
      await fetchWalletJwt();
      answer(status, body);
      expect(await fetchWalletJwt()).toBeUndefined();
      expect(isCdpLocked()).toBe(false);
    }
  });
});

describe("the remembered address", () => {
  it("is kept per email, and logging out forgets it", () => {
    rememberCdpAddress("a@example.com", "AddrA");
    expect(rememberedCdpAddress("a@example.com")).toBe("AddrA");
    expect(rememberedCdpAddress("b@example.com")).toBeNull();
    store.set("theme", "dark");
    forgetCdpAddresses();
    expect(rememberedCdpAddress("a@example.com")).toBeNull();
    expect(store.get("theme")).toBe("dark");
  });
});
