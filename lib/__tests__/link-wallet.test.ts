import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import { fakePostgrest } from "./_fake-postgrest";
import { linkWalletMessage } from "@/lib/link-wallet-message";

/**
 * An email account links a Phantom or Solflare wallet by its signature, for
 * the wallet's NFTs alone (Kev, 2026-10-08). The signature is checked against
 * the text the server rebuilds, over a nonce used once; the link lands in
 * linked_wallets, which only the NFT list reads.
 */

const db = vi.hoisted(() => ({ current: null as ReturnType<typeof import("./_fake-postgrest").fakePostgrest> | null }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => db.current!.client }));

import { GET, POST, DELETE } from "../../app/api/wallet/linked/route";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const FUTURE = "2999-01-01T00:00:00.000Z";
const PHANTOM = Keypair.generate();
const ADDR = PHANTOM.publicKey.toBase58();

let ip = 0;
/** A nonce as /api/auth/nonce issues it: for the lowercased address, five minutes. */
const issue = (address: string) => {
  const nonce = randomBytes(32).toString("hex");
  db.current!.tables.auth_nonces.push({ wallet_address: address.toLowerCase(), nonce, consumed: false, expires_at: FUTURE });
  return nonce;
};
const sign = (kp: Keypair, text: string) =>
  Buffer.from(ed25519.sign(new TextEncoder().encode(text), kp.secretKey.slice(0, 32))).toString("base64");
/** A link request body as the client builds it, signed by `kp` unless a test changes a part. */
const signed = ({ kp = PHANTOM, nonce, domain = "enki.test", text }: { kp?: Keypair; nonce?: string; domain?: string; text?: string } = {}) => {
  const address = kp.publicKey.toBase58();
  const n = nonce ?? issue(address);
  return { address, nonce: n, signature: sign(kp, text ?? linkWalletMessage({ domain, address, nonce: n })) };
};
const call = async (handler: (r: NextRequest) => Promise<Response>, method: string, body?: unknown, { token = "me", from = `192.0.2.${++ip % 250}` } = {}) => {
  const res = await handler(new NextRequest("http://enki.test/api/wallet/linked", {
    method,
    headers: { "X-Session-Token": token, "Content-Type": "application/json", "x-forwarded-for": from },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
};
const link = (body: unknown, opts?: { token?: string; from?: string }) => call(POST, "POST", body, opts);
const rows = () => db.current!.tables.linked_wallets;

beforeEach(() => {
  db.current = fakePostgrest();
  db.current.tables.auth_sessions = [{ token: "me", wallet_address: ME, expires_at: FUTURE }, { token: "other", wallet_address: OTHER, expires_at: FUTURE }];
  db.current.tables.bans = [];
  db.current.tables.auth_nonces = [];
  db.current.tables.linked_wallets = [];
});

describe("linking a wallet", () => {
  it("links a wallet its own signature proves, to this account alone", async () => {
    expect(await link(signed())).toEqual({ status: 200, body: { linked: ADDR } });
    expect(rows()).toEqual([expect.objectContaining({ user_id: ME, address: ADDR })]);
    expect(db.current!.tables.auth_nonces[0].consumed).toBe(true);
  });

  it("asks for a session first, and spends no nonce without one", async () => {
    for (const token of ["", "nobody"]) expect((await link(signed(), { token })).status).toBe(401);
    expect(rows()).toEqual([]);
    expect(db.current!.tables.auth_nonces.every((n) => n.consumed === false)).toBe(true);
  });

  it("refuses a suspended account", async () => {
    db.current!.tables.bans = [{ id: "b1", user_id: ME, lifted_at: null, expires_at: null, created_at: "2026-10-01T00:00:00Z" }];
    expect((await link(signed())).status).toBe(403);
    expect(rows()).toEqual([]);
  });

  it("refuses another key's signature without spending the nonce: the real one still links", async () => {
    const nonce = issue(ADDR);
    const forged = { ...signed({ nonce }), signature: sign(Keypair.generate(), linkWalletMessage({ domain: "enki.test", address: ADDR, nonce })) };
    expect((await link(forged)).status).toBe(401);
    expect(rows()).toEqual([]);
    expect((await link(signed({ nonce }))).status).toBe(200);
  });

  it("refuses a text for another site, and a login signature", async () => {
    expect((await link(signed({ domain: "evil.example" }))).status).toBe(401);
    const nonce = issue(ADDR);
    expect((await link(signed({ nonce, text: `Sign in to Enki\n\nWallet: ${ADDR}\nNonce: ${nonce}` }))).status).toBe(401);
    expect(rows()).toEqual([]);
  });

  it("uses each nonce once, and only for the address it was issued to", async () => {
    const body = signed();
    expect((await link(body)).status).toBe(200);
    db.current!.tables.linked_wallets = [];
    expect((await link(body)).status).toBe(401);
    // The signature is for its own nonce: a fresh nonce does not make it new.
    expect((await link({ ...body, nonce: issue(ADDR) })).status).toBe(401);
    const other = Keypair.generate();
    expect((await link(signed({ kp: other, nonce: issue(ADDR) }))).status).toBe(401);
    expect(rows()).toEqual([]);
  });

  it("a wallet already linked here is said to be, not doubled, even with every slot taken", async () => {
    await link(signed());
    expect(await link(signed())).toEqual({ status: 200, body: { linked: ADDR, already: true } });
    expect(rows()).toHaveLength(1);
    for (let i = 0; i < 2; i++) await link(signed({ kp: Keypair.generate() }));
    expect(await link(signed())).toEqual({ status: 200, body: { linked: ADDR, already: true } });
  });

  it("a double click that lands twice reads as already linked", async () => {
    db.current!.state.failNext = { table: "linked_wallets", op: "insert", code: "23505" };
    expect(await link(signed())).toEqual({ status: 200, body: { linked: ADDR, already: true } });
  });

  it("the same wallet may be linked to another account too: it opens only public NFTs", async () => {
    db.current!.tables.linked_wallets = [{ user_id: OTHER, address: ADDR }];
    expect((await link(signed())).status).toBe(200);
    expect(rows()).toHaveLength(2);
  });

  it("links three wallets at most: each is a paid call whenever the picker opens", async () => {
    for (let i = 0; i < 3; i++) expect((await link(signed({ kp: Keypair.generate() }))).status).toBe(200);
    expect((await link(signed())).status).toBe(409);
    expect(rows().map((r) => r.address)).not.toContain(ADDR);
  });

  it("holds one address to ten tries a minute", async () => {
    for (let i = 0; i < 10; i++) expect((await link({}, { from: "198.51.100.7" })).status).toBe(400);
    expect((await link(signed(), { from: "198.51.100.7" })).status).toBe(429);
  });
});

describe("the linked wallets", () => {
  it("are listed for their account alone", async () => {
    db.current!.tables.linked_wallets = [{ user_id: ME, address: ADDR }, { user_id: OTHER, address: "QtherBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" }];
    expect(await call(GET, "GET")).toEqual({ status: 200, body: { wallets: [ADDR] } });
    expect((await call(GET, "GET", undefined, { token: "" })).status).toBe(401);
  });

  it("are unlinked by their account alone", async () => {
    db.current!.tables.linked_wallets = [{ user_id: ME, address: ADDR }, { user_id: OTHER, address: ADDR }];
    expect((await call(DELETE, "DELETE", { address: ADDR }, { token: "" })).status).toBe(401);
    expect(await call(DELETE, "DELETE", { address: ADDR })).toEqual({ status: 200, body: { unlinked: ADDR } });
    expect(rows()).toEqual([{ user_id: OTHER, address: ADDR }]);
    expect((await call(DELETE, "DELETE", { address: ADDR })).status).toBe(404);
    expect(rows()).toHaveLength(1);
  });
});
