import { describe, it, expect, beforeEach, vi } from "vitest";
import { join } from "node:path";
import { readSource } from "./_read-source";

/**
 * The CDP bridge, run for real (review of the email login, 2026-10-07):
 * - CDP keeps its user in memory across our unmounts, so a mount trusts only
 *   its own sign-in: another account's wallet never reaches this session.
 * - Before every wallet action the JWT route decides; the unlock dialog shows
 *   only while it still says locked, and before the action, not inside it.
 * - A ban never stops the wallet: only a paid generation needs the attach.
 *
 * No DOM: the bridge renders nothing, so a minimal hooks runtime (state, refs,
 * callbacks, effects) runs it as React would.
 */

const rt = vi.hoisted(() => {
  type Slot = { v?: unknown; current?: unknown; fn?: unknown; deps?: unknown[]; cleanup?: unknown };
  let slots: Slot[] = [];
  let cursor = 0;
  let effects: (() => void)[] = [];
  let component: (() => unknown) | null = null;
  let rendering = false;
  let dirty = false;
  let pending = false;
  const same = (a?: unknown[], b?: unknown[]) => !!a && !!b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  const render = () => {
    if (!component) return;
    rendering = true;
    try {
      do {
        dirty = false;
        cursor = 0;
        effects = [];
        component();
        const run = effects;
        run.forEach((f) => f());
      } while (dirty && component);
    } finally {
      rendering = false;
    }
  };
  const update = () => {
    if (rendering) { dirty = true; return; }
    if (pending) return;
    pending = true;
    // Like React's scheduler: an update from a promise renders in a later task.
    setTimeout(() => { pending = false; render(); }, 0);
  };
  const react = {
    useState(init: unknown) {
      const s = (slots[cursor++] ??= { v: init });
      return [s.v, (next: unknown) => { if (!Object.is(next, s.v)) { s.v = next; update(); } }];
    },
    useRef(init: unknown) {
      return (slots[cursor++] ??= { current: init });
    },
    useCallback(fn: unknown, deps: unknown[]) {
      const i = cursor++;
      if (slots[i] && same(slots[i].deps, deps)) return slots[i].fn;
      slots[i] = { fn, deps };
      return fn;
    },
    useEffect(fn: () => unknown, deps?: unknown[]) {
      const i = cursor++;
      const prev = slots[i];
      if (prev && same(prev.deps, deps)) return;
      slots[i] = { deps: prev?.deps, cleanup: prev?.cleanup };
      effects.push(() => {
        if (typeof prev?.cleanup === "function") prev.cleanup();
        slots[i] = { deps, cleanup: fn() };
      });
    },
  };
  return {
    react,
    mount(c: () => unknown) { slots = []; component = c; render(); },
    unmount() {
      component = null;
      for (const s of slots) if (s && "cleanup" in s && typeof s.cleanup === "function") s.cleanup();
      slots = [];
    },
    update,
  };
});
vi.mock("react", () => rt.react);

type User = { solanaAccountObjects: { address: string }[]; evmAccountObjects: { address: string }[] };
const wallet = (sol: string): User => ({ solanaAccountObjects: [{ address: sol }], evmAccountObjects: [{ address: `0x${"0".repeat(39)}1` }] });

// CDP: one user in memory for the page; authenticateWithJWT asks our JWT route
// (customAuth.getJwt) and replaces it; a refused JWT leaves it as it was.
const cdp = vi.hoisted(() => ({ user: null as null | User, walletOf: {} as Record<string, User>, signIns: 0 }));
vi.mock("@coinbase/cdp-hooks", () => ({
  useIsInitialized: () => ({ isInitialized: true }),
  useSolanaAddress: () => ({ solanaAddress: cdp.user?.solanaAccountObjects[0]?.address ?? null }),
}));
vi.mock("@coinbase/cdp-core", async () => {
  const { fetchWalletJwt } = await import("../cdp-bridge");
  const own = (account: string) => {
    if (cdp.user?.solanaAccountObjects[0]?.address !== account) throw new Error("not this user's account");
  };
  return {
    authenticateWithJWT: async () => {
      cdp.signIns++;
      const jwt = await fetchWalletJwt();
      if (!jwt) throw new Error("customAuth.getJwt returned null or undefined");
      cdp.user = cdp.walletOf[jwt];
      rt.update(); // CDP's auth state callback re-renders its hooks
      return { user: cdp.user, message: "ok", isNewUser: false };
    },
    isSignedIn: async () => cdp.user !== null,
    getCurrentUser: async () => cdp.user,
    signSolanaTransaction: async ({ solanaAccount, transaction }: { solanaAccount: string; transaction: string }) => {
      own(solanaAccount);
      events.push("sign");
      return { signedTransaction: `${transaction} signed by ${solanaAccount}` };
    },
    exportSolanaAccount: async ({ solanaAccount }: { solanaAccount: string }) => {
      own(solanaAccount);
      return { privateKey: `key of ${solanaAccount}` };
    },
  };
});

// The step-up dialog: the user confirms (the server then unlocks) or cancels.
const dialog = vi.hoisted(() => ({ answer: "confirm" as "confirm" | "cancel" }));
vi.mock("@/components/StepUpProvider", () => ({
  useStepUp: () => ({ tokenFor }),
}));
const tokenFor = vi.fn(async (scope: string) => {
  events.push(`dialog:${scope}`);
  if (dialog.answer === "cancel") return null;
  server.jwt = "open";
  return "step-up-token";
});

// Our server: the JWT route and attach-wallet.
const server = {
  jwt: "open" as "open" | "locked" | "down",
  banned: false,
  attached: [] as string[],
};
const events: string[] = [];
vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: string }) => {
  const json = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body });
  if (url === "/api/auth/wallet/jwt") {
    if (server.jwt === "locked") return json(403, { error: "Confirm it's you to use the wallet", locked: true, scope: "wallet", factors: ["totp"] });
    if (server.jwt === "down") return json(503, { error: "Could not read the session" });
    return json(200, { jwt: "jwt-B" });
  }
  if (url === "/api/auth/session/attach-wallet") {
    if (server.banned) return json(403, { error: "This account is suspended.", banned: true });
    server.attached.push(JSON.parse(init!.body!).solanaAddress);
    return json(200, {});
  }
  throw new Error(`unexpected fetch ${url}`);
}));

const local = new Map<string, string>();
const storage = (m: Map<string, string>) => new Proxy({}, {
  get: (_, k: string) => ({
    getItem: (key: string) => m.get(key) ?? null,
    setItem: (key: string, v: string) => void m.set(key, v),
    removeItem: (key: string) => void m.delete(key),
  } as Record<string, unknown>)[k] ?? m.get(k),
  ownKeys: () => [...m.keys()],
  getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
});
vi.stubGlobal("window", new EventTarget());
vi.stubGlobal("localStorage", storage(local));
const session = new Map<string, string>();
vi.stubGlobal("sessionStorage", storage(session));

import { CdpWalletBridge } from "@/components/CdpWalletBridge";
import {
  CDP_ADDRESS_EVENT, CDP_SIGN_REQUEST, ensureCdpWallet, getCdpSolanaAddress, rememberedCdpAddress,
  requestCdpKeyExport, requestCdpSign,
} from "../cdp-bridge";

const A = "AccountA1111111111111111111111111111111111";
const B = "AccountB1111111111111111111111111111111111";
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); };
const published: (string | null)[] = [];
window.addEventListener(CDP_ADDRESS_EVENT, () => published.push(getCdpSolanaAddress()));
window.addEventListener(CDP_SIGN_REQUEST, () => events.push("sign-request"));

beforeEach(async () => {
  rt.unmount();
  await settle();
  cdp.user = null;
  cdp.walletOf = { "jwt-B": wallet(B) };
  cdp.signIns = 0;
  Object.assign(server, { jwt: "open", banned: false, attached: [] });
  dialog.answer = "confirm";
  tokenFor.mockClear();
  events.length = 0;
  published.length = 0;
  local.clear();
  session.clear();
  local.set("enki_session_token", "session-of-b");
});

const mountFor = async (email: string) => {
  rt.mount(() => CdpWalletBridge({ email }));
  await settle();
};

describe("a second tab, after another account's login", () => {
  it("never publishes, remembers or attaches the account CDP still holds", async () => {
    cdp.user = wallet(A); // left in memory by the first account's runtime
    await mountFor("b@example.com");
    expect(published).not.toContain(A);
    expect(server.attached).toEqual([B]);
    expect(rememberedCdpAddress("b@example.com")).toBe(B);
    expect(getCdpSolanaAddress()).toBe(B);
    expect(cdp.signIns).toBe(1);
  });

  it("shows nothing of it either while the new account's wallet is locked", async () => {
    cdp.user = wallet(A);
    server.jwt = "locked";
    await mountFor("b@example.com");
    expect(published).not.toContain(A);
    expect(server.attached).toEqual([]);
    expect(rememberedCdpAddress("b@example.com")).toBeNull();
    // Unlocked later, it signs as the new account, never as the one in memory.
    await expect(requestCdpSign("tx")).resolves.toBe(`tx signed by ${B}`);
    expect(published).not.toContain(A);
  });

  it("is one runtime per account: another account's login remounts it", () => {
    const providers = readSource(join(__dirname, "..", "..", "providers", "index.tsx"));
    expect(providers).toMatch(/<CdpRuntime key=\{email\} email=\{email\} \/>/);
  });
});

describe("before a wallet action, the server decides", () => {
  it("asks nothing once the session is open again: an export step-up, another tab, or no factor left", async () => {
    server.jwt = "locked";
    await mountFor("b@example.com"); // the silent sign-in met the lock
    server.jwt = "open";
    await expect(requestCdpKeyExport()).resolves.toBe(`key of ${B}`);
    expect(tokenFor).not.toHaveBeenCalled();
  });

  it("asks once while it is locked, then signs in", async () => {
    server.jwt = "locked";
    await mountFor("b@example.com");
    await expect(requestCdpSign("tx")).resolves.toBe(`tx signed by ${B}`);
    expect(tokenFor).toHaveBeenCalledTimes(1);
    expect(tokenFor).toHaveBeenCalledWith("wallet");
  });

  it("asks before the action, not inside its timer, when the server locked a wallet CDP still holds", async () => {
    await mountFor("b@example.com");
    server.jwt = "locked"; // 15 min idle
    await expect(requestCdpSign("tx")).resolves.toBe(`tx signed by ${B}`);
    expect(events).toEqual(["dialog:wallet", "sign-request", "sign"]);
  });

  it("signs nothing when the dialog is cancelled", async () => {
    server.jwt = "locked";
    dialog.answer = "cancel";
    await mountFor("b@example.com");
    await expect(requestCdpSign("tx")).rejects.toThrow(/Not confirmed/);
    expect(events).toEqual(["dialog:wallet"]);
  });

  it("never shows the dialog when the server is only unreachable", async () => {
    server.jwt = "down";
    await mountFor("b@example.com");
    await expect(requestCdpSign("tx")).rejects.toThrow(/isn't available/);
    expect(tokenFor).not.toHaveBeenCalled();
  });
});

describe("a banned account", () => {
  it("still signs and exports; only a paid generation needs the attach, and says why", async () => {
    server.banned = true;
    await mountFor("b@example.com");
    await expect(requestCdpSign("tx")).resolves.toBe(`tx signed by ${B}`);
    await expect(requestCdpKeyExport()).resolves.toBe(`key of ${B}`);
    await expect(ensureCdpWallet({ attached: true })).rejects.toThrow("This account is suspended.");
  });
});

describe("right after an email login", () => {
  it("asks for the unlock at once, once", async () => {
    session.set("enki:wallet-ask", "1");
    server.jwt = "locked";
    await mountFor("b@example.com");
    expect(tokenFor).toHaveBeenCalledTimes(1);
    expect(getCdpSolanaAddress()).toBe(B);
    expect(session.has("enki:wallet-ask")).toBe(false);
  });
});
