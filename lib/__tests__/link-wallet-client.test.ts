import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import type { MessageSignerWalletAdapter } from "@solana/wallet-adapter-base";
import { fakePostgrest } from "./_fake-postgrest";
import { readSource } from "./_read-source";
import { linkWalletMessage } from "@/lib/link-wallet-message";

/**
 * The browser half of linking a wallet (Kev, 2026-10-08): the wallet signs
 * the text the server rebuilds, through the adapter alone, and a wallet the
 * flow connected is disconnected again, so the app's own wallet stays the
 * one it reads.
 */

const db = vi.hoisted(() => ({ current: null as ReturnType<typeof import("./_fake-postgrest").fakePostgrest> | null }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => db.current!.client }));
vi.mock("@/lib/session-headers", () => ({ sessionAuthHeaders: () => ({ "X-Session-Token": "me" }) }));

import { linkWallet } from "@/components/settings/link-wallet";
import { POST as nonceRoute } from "../../app/api/auth/nonce/route";
import { POST as linkRoute } from "../../app/api/wallet/linked/route";

const ME = "11111111-1111-4111-8111-111111111111";
const FUTURE = "2999-01-01T00:00:00.000Z";

/** A wallet as the adapter shows it: connecting shares its key, signing may be refused. */
function wallet({ connected = false, refuse = false } = {}) {
  const kp = Keypair.generate();
  const a = {
    connected,
    publicKey: connected ? kp.publicKey : null,
    connect: vi.fn(async () => { a.connected = true; a.publicKey = kp.publicKey; }),
    disconnect: vi.fn(async () => { a.connected = false; a.publicKey = null; }),
    signMessage: vi.fn(async (m: Uint8Array) => {
      if (refuse) throw new Error("User rejected the request.");
      return ed25519.sign(m, kp.secretKey.slice(0, 32));
    }),
  };
  return { kp, a, adapter: a as unknown as MessageSignerWalletAdapter };
}

let ip = 0;
let sent: { url: string; body: Record<string, string>; headers: Record<string, string> }[] = [];
/** The browser's fetch, answered by the real routes; `linkAnswer` stands in for the link route when set. */
const browser = (linkAnswer?: () => Response) => vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
  const headers = init.headers as Record<string, string>;
  sent.push({ url, body: JSON.parse(String(init.body)), headers });
  if (url === "/api/wallet/linked" && linkAnswer) return linkAnswer();
  const handler = url === "/api/auth/nonce" ? nonceRoute : url === "/api/wallet/linked" ? linkRoute : null;
  if (!handler) throw new Error(`unexpected fetch ${url}`);
  return handler(new NextRequest(`http://enki.test${url}`, { method: init.method, body: init.body, headers: { ...headers, "x-forwarded-for": `203.0.113.${++ip % 250}` } }));
}));

beforeEach(() => {
  db.current = fakePostgrest();
  db.current.tables.auth_sessions = [{ token: "me", wallet_address: ME, expires_at: FUTURE }];
  db.current.tables.bans = [];
  db.current.tables.auth_nonces = [];
  db.current.tables.linked_wallets = [];
  sent = [];
});
afterEach(() => vi.unstubAllGlobals());

describe("linking a wallet from the browser", () => {
  it("signs the text the server rebuilds, and the server links it to the account", async () => {
    const { kp, a, adapter } = wallet();
    browser();
    const address = kp.publicKey.toBase58();
    await expect(linkWallet(adapter, "enki.test")).resolves.toBe(address);
    expect(sent[0]).toMatchObject({ url: "/api/auth/nonce", body: { walletAddress: address, walletType: "solana" } });
    const nonce = String(db.current!.tables.auth_nonces[0].nonce);
    expect(new TextDecoder().decode(a.signMessage.mock.calls[0][0])).toBe(linkWalletMessage({ domain: "enki.test", address, nonce }));
    expect(sent[1]).toMatchObject({ url: "/api/wallet/linked", body: { address, nonce }, headers: { "X-Session-Token": "me" } });
    expect(db.current!.tables.linked_wallets).toEqual([expect.objectContaining({ user_id: ME, address })]);
    // Connected for the link alone: the app's own wallet stays the one it reads.
    expect(a.disconnect).toHaveBeenCalledTimes(1);
  });

  it("says the server's reason when it refuses, and lets the wallet go", async () => {
    const { a, adapter } = wallet();
    browser(() => Response.json({ error: "You can link up to 3 wallets. Unlink one first." }, { status: 409 }));
    await expect(linkWallet(adapter, "enki.test")).rejects.toThrow("You can link up to 3 wallets. Unlink one first.");
    expect(a.disconnect).toHaveBeenCalledTimes(1);
  });

  it("sends nothing to link when the user declines to sign, and lets the wallet go", async () => {
    const { a, adapter } = wallet({ refuse: true });
    browser();
    await expect(linkWallet(adapter, "enki.test")).rejects.toThrow("User rejected the request.");
    expect(sent.map((s) => s.url)).toEqual(["/api/auth/nonce"]);
    expect(a.disconnect).toHaveBeenCalledTimes(1);
  });

  it("leaves a wallet that was connected before as it was", async () => {
    const { a, adapter } = wallet({ connected: true });
    browser();
    await linkWallet(adapter, "enki.test");
    expect(a.connect).not.toHaveBeenCalled();
    expect(a.disconnect).not.toHaveBeenCalled();
  });
});

describe("where a wallet is linked", () => {
  const src = (...p: string[]) => readSource(join(__dirname, "..", "..", ...p));

  it("never goes through the provider's select(): the provider's wallet is the account's own", () => {
    const buttons = src("components", "settings", "LinkWalletButtons.tsx");
    expect(buttons).not.toMatch(/\bselect\(/);
    expect(buttons).toContain("await linkWallet(adapter);");
  });

  it("is Settings → Profile, for an email account alone, its sections counting on", () => {
    const settings = src("components", "settings", "SettingsView.tsx");
    expect(settings).toContain("const { isAuthed: emailAuthed } = useEmailAuth();");
    expect(settings).toContain('const no = (n: number) => String(n + (emailAuthed ? 1 : 0)).padStart(2, "0");');
    expect(settings).toMatch(/activeTab === "profile" && \([\s\S]*?\{emailAuthed && <LinkedWallets num="02" \/>\}\n\n\s+<SettingsSection num=\{no\(2\)\} title="Hall of Fame">/);
    for (const [n, title] of [[3, "18+ content"], [4, "Danger Zone"], [5, "Admin"]]) {
      expect(settings).toContain(`<SettingsSection num={no(${n})} title="${title}">`);
    }
  });

  it("an unlink that finds the wallet gone already reads as unlinked, not as a failure", () => {
    const linked = src("components", "settings", "LinkedWallets.tsx");
    expect(linked).toContain("if (res?.ok || res?.status === 404) setWallets((w) => (w ?? []).filter((a) => a !== address));");
  });
});
