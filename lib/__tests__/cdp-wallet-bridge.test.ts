import { describe, it, expect, beforeEach, vi } from "vitest";
import { join } from "node:path";
import { readSource } from "./_read-source";

/**
 * The CDP bridge, run for real (review of the email login, 2026-10-07):
 * - CDP keeps its user and wallet secret in memory across our unmounts, so a
 *   mount signs that out and trusts only its own sign-in, and a call that
 *   outlives its mount stops: another account's wallet never reaches this
 *   session.
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

// CDP: one user and one wallet secret in memory for the page.
// authenticateWithJWT asks our JWT route (customAuth.getJwt) and replaces the
// user, but keeps the secret; a refused JWT leaves both as they were. Only
// signOut clears both. A secret signs for the user who registered it, only.
// initialized: false is a runtime whose SDK has not started yet; gate holds
// getCurrentUser until released (a slow read across an account switch);
// signGate holds a signing halfway, after it started.
const cdp = vi.hoisted(() => ({
  user: null as null | User, secret: null as null | string, walletOf: {} as Record<string, User>, signIns: 0,
  initialized: true, gate: null as null | Promise<void>, signGate: null as null | Promise<void>,
}));
vi.mock("@coinbase/cdp-hooks", () => ({
  useIsInitialized: () => ({ isInitialized: cdp.initialized }),
}));
vi.mock("@coinbase/cdp-core", async () => {
  const { fetchWalletJwt } = await import("../cdp-bridge");
  const own = (account: string) => {
    if (cdp.user?.solanaAccountObjects[0]?.address !== account) throw new Error("not this user's account");
    cdp.secret ??= account;
    if (cdp.secret !== account) throw new Error("wallet secret of another user");
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
    signOut: async () => {
      if (!cdp.user) throw new Error("User not signed in");
      cdp.user = null;
      cdp.secret = null;
      rt.update();
    },
    isSignedIn: async () => cdp.user !== null,
    getCurrentUser: async () => {
      if (cdp.gate) await cdp.gate;
      return cdp.user;
    },
    getCurrentUserSync: () => cdp.user,
    signSolanaTransaction: async ({ solanaAccount, transaction }: { solanaAccount: string; transaction: string }) => {
      own(solanaAccount);
      const secret = cdp.secret; // a signing holds the secret it started with
      if (cdp.signGate) await cdp.signGate;
      if (cdp.secret !== secret) throw new Error("wallet secret cleared while signing");
      events.push("sign");
      return { signedTransaction: `${transaction} signed by ${solanaAccount}` };
    },
    exportSolanaAccount: async ({ solanaAccount }: { solanaAccount: string }) => {
      own(solanaAccount);
      return { privateKey: `key of ${solanaAccount}` };
    },
  };
});

// The step-up dialog: the user confirms (the server then unlocks), cancels,
// or leaves it open until release().
const dialog = vi.hoisted(() => ({ answer: "confirm" as "confirm" | "cancel" | "hold", release: () => {} }));
vi.mock("@/components/StepUpProvider", () => ({
  useStepUp: () => ({ tokenFor }),
}));
const tokenFor = vi.fn(async (scope: string) => {
  events.push(`dialog:${scope}`);
  if (dialog.answer === "cancel") return null;
  if (dialog.answer === "hold") await new Promise<void>((r) => { dialog.release = r; });
  server.jwt = "open";
  return "step-up-token";
});

// Our server: the JWT route and attach-wallet.
const server = {
  jwt: "open" as "open" | "locked" | "down",
  banned: false,
  attached: [] as { address: string; session: string }[],
};
const events: string[] = [];
vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: string; headers?: Record<string, string> }) => {
  const session = init?.headers?.["X-Session-Token"] ?? "";
  const json = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body });
  if (url === "/api/auth/wallet/jwt") {
    if (server.jwt === "locked") return json(403, { error: "Confirm it's you to use the wallet", locked: true, scope: "wallet", factors: ["totp"] });
    if (server.jwt === "down") return json(503, { error: "Could not read the session" });
    return json(200, { jwt: `jwt-${session}` });
  }
  if (url === "/api/auth/session/attach-wallet") {
    if (server.banned) return json(403, { error: "This account is suspended.", banned: true });
    server.attached.push({ address: JSON.parse(init!.body!).solanaAddress, session });
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
  cdp.walletOf = { "jwt-session-of-a": wallet(A), "jwt-session-of-b": wallet(B) };
  cdp.secret = null;
  cdp.signIns = 0;
  cdp.initialized = true;
  cdp.gate = null;
  cdp.signGate = null;
  Object.assign(server, { jwt: "open", banned: false, attached: [] });
  dialog.answer = "confirm";
  dialog.release = () => {};
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
  it("never publishes, remembers or attaches the account CDP still holds, nor signs with its secret", async () => {
    cdp.user = wallet(A); // left in memory by the first account's runtime,
    cdp.secret = A;       // with the wallet secret it signed with
    await mountFor("b@example.com");
    expect(published).not.toContain(A);
    expect(server.attached).toEqual([{ address: B, session: "session-of-b" }]);
    await expect(requestCdpSign("tx")).resolves.toBe(`tx signed by ${B}`);
    expect(rememberedCdpAddress("b@example.com")).toBe(B);
    expect(getCdpSolanaAddress()).toBe(B);
    expect(cdp.signIns).toBe(1);
  });

  it("shows nothing of it either while the new account's wallet is locked", async () => {
    cdp.user = wallet(A);
    cdp.secret = A;
    server.jwt = "locked";
    await mountFor("b@example.com");
    expect(published).not.toContain(A);
    expect(server.attached).toEqual([]);
    expect(rememberedCdpAddress("b@example.com")).toBeNull();
    // Unlocked later, it signs as the new account, never as the one in memory.
    await expect(requestCdpSign("tx")).resolves.toBe(`tx signed by ${B}`);
    expect(published).not.toContain(A);
  });

  it("stops a wallet action the previous account left waiting, so its wallet never reaches the new session", async () => {
    local.set("enki_session_token", "session-of-a");
    await mountFor("a@example.com");
    server.jwt = "locked"; // A's wallet relocked; a payment waits on A's dialog
    dialog.answer = "hold";
    const paying = ensureCdpWallet({ attached: true });
    await settle();
    rt.unmount(); // another tab logs out and in as B: this tab remounts for B
    local.set("enki_session_token", "session-of-b");
    await mountFor("b@example.com");
    dialog.release(); // confirmed, now with B's factor
    await expect(paying).rejects.toThrow(/account changed/);
    await settle();
    expect(server.attached.filter((a) => a.session === "session-of-b").map((a) => a.address)).not.toContain(A);
    expect(rememberedCdpAddress("a@example.com")).toBe(A);
    expect(rememberedCdpAddress("b@example.com")).not.toBe(A);
  });

  it("fails a payment the previous account left waiting, even before the new runtime is up", async () => {
    local.set("enki_session_token", "session-of-a");
    await mountFor("a@example.com");
    server.jwt = "locked";
    dialog.answer = "hold";
    const paying = requestCdpSign("tx");
    await settle();
    rt.unmount();
    local.set("enki_session_token", "session-of-b");
    cdp.initialized = false; // B's runtime has not signed anyone out yet: CDP still holds A
    await mountFor("b@example.com");
    dialog.release();
    await expect(paying).rejects.toThrow(/account changed/);
    expect(events).not.toContain("sign");
  });

  it("remembers nothing for the previous email from a sign-in that outlived its mount", async () => {
    local.set("enki_session_token", "session-of-a");
    let release!: () => void;
    cdp.gate = new Promise<void>((r) => { release = r; }); // A's sign-in is slow to start
    await mountFor("a@example.com");
    rt.unmount();
    local.set("enki_session_token", "session-of-b"); // so it signs in with B's session
    cdp.gate = null;
    release();
    await settle();
    expect(rememberedCdpAddress("a@example.com")).toBeNull();
  });

  it("signs with the new account's own wallet even before its runtime finished starting", async () => {
    cdp.user = wallet(A);
    cdp.secret = A;
    cdp.initialized = false;
    await mountFor("b@example.com");
    await expect(requestCdpSign("tx")).resolves.toBe(`tx signed by ${B}`);
  });

  it("keeps its own sign-in when its runtime finishes starting in the middle of a payment", async () => {
    cdp.initialized = false;
    await mountFor("b@example.com");
    let release!: () => void;
    cdp.signGate = new Promise<void>((r) => { release = r; });
    const paying = requestCdpSign("tx"); // signs B in and starts signing
    await settle();
    cdp.initialized = true; // the SDK is up: the silent sign-in runs now
    rt.update();
    await settle();
    release();
    await expect(paying).resolves.toBe(`tx signed by ${B}`);
  });

  it("never takes a late answer for the previous account as its own", async () => {
    await mountFor("b@example.com");
    cdp.user = wallet(A); // the old mount's sign-in, still on the wire, lands in CDP now
    rt.update();
    await settle();
    expect(published).not.toContain(A);
    expect(getCdpSolanaAddress()).toBe(B);
    expect(server.attached.map((a) => a.address)).not.toContain(A);
    await expect(requestCdpSign("tx")).resolves.toBe(`tx signed by ${B}`);
    expect(server.attached.map((a) => a.address)).not.toContain(A);
    cdp.user = wallet(A); // and once more, right before an export
    await expect(requestCdpKeyExport()).resolves.toBe(`key of ${B}`);
    await expect(ensureCdpWallet({ attached: true })).resolves.toBeUndefined();
    expect(server.attached.map((a) => a.address)).not.toContain(A);
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

describe("while the wallet is locked", () => {
  it("offers the address this email had last, so the screens can offer the unlock", async () => {
    local.set("enki-cdp-address:b@example.com", B);
    server.jwt = "locked";
    await mountFor("b@example.com");
    expect(cdp.user).toBeNull();
    expect(getCdpSolanaAddress()).toBe(B);
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
