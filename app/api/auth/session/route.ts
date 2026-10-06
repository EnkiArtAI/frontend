import { isDbUnreachable, dbUnavailableResponse } from "@/lib/db-error";
/**
 * POST /api/auth/session
 *
 * One-time wallet signature + nonce verification.
 * On success, issues a 24-hour session token that clients send as
 * X-Session-Token on subsequent authenticated requests.
 */
import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { isAddress, verifyMessage } from "viem";
import { PublicKey } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { whitelistStageActive, isWalletAllowed, grantGateCookie } from "@/lib/allowlist";
import { getClientIp, hashIp, isIpBanned } from "@/lib/ip-hash";
import { activeBanFor } from "@/lib/session-user";
import { APP_NAME } from "@/shared/app-config";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const NONCE_WINDOW_MS = 10 * 60 * 1000;      // nonce must be <= 10 min old

async function verifySolana(publicKeyBase58: string, signatureBase64: string, message: string): Promise<boolean> {
  try {
    const pubKeyBytes = new PublicKey(publicKeyBase58).toBytes();
    const sigBytes = Buffer.from(signatureBase64, "base64");
    const msgBytes = new TextEncoder().encode(message);
    return ed25519.verify(sigBytes, msgBytes, pubKeyBytes);
  } catch {
    return false;
  }
}

async function verifyEvm(walletAddress: string, signature: string, message: string): Promise<boolean> {
  try {
    return await verifyMessage({
      address: walletAddress as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    });
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  const ipLimit = checkRequestRateLimit(rateLimitKey(req, "auth:session:ip"), 20, 60_000);
  if (!ipLimit.allowed) return rateLimitResponse(ipLimit.retryAfterSeconds);

  let body: {
    walletAddress?: unknown;
    walletType?: unknown;
    signature?: unknown;
    message?: unknown;
    timestamp?: unknown;
    nonce?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const walletAddress = typeof body.walletAddress === "string" ? body.walletAddress.trim() : "";
  const walletType = body.walletType === "solana" ? "solana" : "evm";
  const signature = typeof body.signature === "string" ? body.signature.trim() : "";
  const message = typeof body.message === "string" ? body.message : "";
  const timestamp = typeof body.timestamp === "number" ? body.timestamp : Number(body.timestamp);
  const nonce = typeof body.nonce === "string" ? body.nonce.trim() : "";

  if (!walletAddress || !signature || !message || !nonce || isNaN(timestamp)) {
    return NextResponse.json(
      { error: "walletAddress, signature, message, timestamp, and nonce are required" },
      { status: 400 }
    );
  }

  // Validate wallet address format
  if (walletType === "solana") {
    try { new PublicKey(walletAddress); } catch {
      return NextResponse.json({ error: "Invalid Solana address" }, { status: 400 });
    }
  } else if (!isAddress(walletAddress)) {
    return NextResponse.json({ error: "Invalid EVM address" }, { status: 400 });
  }

  // Timestamp freshness (10-minute window to allow clock skew on first sign)
  if (Math.abs(Date.now() - timestamp) > NONCE_WINDOW_MS) {
    return NextResponse.json({ error: "Signature timestamp expired. Please re-authenticate." }, { status: 401 });
  }

  // Message must reference the wallet and nonce
  if (!message.toLowerCase().includes(walletAddress.toLowerCase())) {
    return NextResponse.json({ error: "Message does not reference the claimed wallet" }, { status: 401 });
  }
  if (!message.includes(nonce)) {
    return NextResponse.json({ error: "Message does not reference the issued nonce" }, { status: 401 });
  }
  // Message must reference the app name
  if (!message.includes(APP_NAME)) {
    return NextResponse.json({ error: "Message references an unknown application" }, { status: 401 });
  }

  // Verify cryptographic signature
  // Two forms, deliberately.
  //
  // normalizedWallet is for CASE-INSENSITIVE matching only: the allowlist
  // lookup, and consume_auth_nonce (the nonce route stores the lowercased
  // form, so the RPC must be given the same).
  //
  // storedWallet is what gets PERSISTED. Base58 is case-sensitive, so a
  // lowercased Solana address is a different, valid-looking key nobody holds
  // — stored, it made exactWallet() hand the payment builder a buyer whose
  // signature could never match, and made every artist unsellable behind
  // computeQuote's "must be re-linked" guard. EVM addresses are hex and
  // unaffected either way. PR #69 fixed the settings route, lib/auth.ts and
  // the quote guard, but never this file — the primary login path.
  const normalizedWallet = walletAddress.toLowerCase();
  const storedWallet = walletType === "solana" ? walletAddress : normalizedWallet;
  const valid =
    walletType === "solana"
      ? await verifySolana(walletAddress, signature, message)
      : await verifyEvm(walletAddress, signature, message);

  if (!valid) {
    return NextResponse.json({ error: "Invalid wallet signature" }, { status: 401 });
  }

  const supabase = getSupabaseServerClient();

  // Private-beta whitelist: only allow-listed wallets get in. Checked before
  // the nonce is consumed so a turned-away wallet keeps its nonce.
  let walletAllowed = true;
  try {
    walletAllowed = !whitelistStageActive() || (await isWalletAllowed(supabase, normalizedWallet));
  } catch (e) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    throw e;
  }
  if (!walletAllowed) {
    return NextResponse.json(
      { error: "This wallet isn't on the access list yet. Request access to join.", notWhitelisted: true },
      { status: 403 },
    );
  }

  // Council-banned network → no new sessions (checked before the nonce burns).
  const ipHash = hashIp(getClientIp(req));
  if (await isIpBanned(supabase, ipHash)) {
    return NextResponse.json({ error: "Access from this network is blocked." }, { status: 403 });
  }

  // Consume the nonce (atomic — rejects replays)
  const { data: consumed, error: nonceError } = await supabase.rpc("consume_auth_nonce", {
    p_wallet_address: normalizedWallet,
    p_nonce: nonce,
  });
  if (nonceError || !consumed) {
    if (isDbUnreachable(nonceError)) return dbUnavailableResponse();
    return NextResponse.json(
      { error: "Nonce is invalid, expired, or already used. Request a new nonce." },
      { status: 401 }
    );
  }

  // Create session
  const sessionToken = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

  let { error: sessionError } = await supabase.from("auth_sessions").insert({
    token: sessionToken,
    wallet_address: storedWallet,
    wallet_type: walletType,
    expires_at: expiresAt,
    ip_hash: ipHash,
  });
  if (sessionError && /ip_hash/.test(sessionError.message)) {
    // moderation-council migration not run yet — insert without the column
    ({ error: sessionError } = await supabase.from("auth_sessions").insert({
      token: sessionToken,
      wallet_address: storedWallet,
      wallet_type: walletType,
      expires_at: expiresAt,
    }));
  }
  if (sessionError) {
    if (isDbUnreachable(sessionError)) return dbUnavailableResponse();
    console.error("Failed to create auth session:", sessionError);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }

  // Ensure user + wallet row exist.
  //
  // Looked up case-INSENSITIVELY so a row written by the old lowercasing code
  // is still found rather than duplicated, then REPAIRED in place. Every
  // Solana wallet that ever logged in carries a mangled address; this heals
  // them on their next login, so no migration has to guess which rows to
  // touch.
  const { data: walletRow } = await supabase
    .from("user_wallets")
    .select("user_id, address")
    .ilike("address", normalizedWallet)
    .is("removed_at", null)
    .maybeSingle();

  if (!walletRow?.user_id) {
    const userInsert = await supabase.from("users").insert({}).select("id").single();
    if (!userInsert.error && userInsert.data?.id) {
      await supabase.from("user_wallets").insert({
        user_id: userInsert.data.id,
        address: storedWallet,
        chain_family: walletType === "solana" ? "solana" : "evm",
        wallet_type: "external_eoa",
        is_primary: true,
      }).select();
    }
  } else if (walletRow.address !== storedWallet) {
    await supabase
      .from("user_wallets")
      .update({ address: storedWallet })
      .eq("user_id", walletRow.user_id)
      .ilike("address", normalizedWallet);
  }

  // Banned users still get a session — it only opens /api/ban/* (status,
  // appeal, funds). The banned flag routes the client to /banned.
  const banned = walletRow?.user_id ? !!(await activeBanFor(supabase, String(walletRow.user_id))) : false;

  // Whitelisted login → grant app access (sets the gate cookie the proxy checks).
  const res = NextResponse.json({ sessionToken, expiresAt, walletAddress: storedWallet, walletType, ...(banned ? { banned: true } : {}) });
  return grantGateCookie(res);
}

export async function DELETE(req: NextRequest) {
  const token = req.headers.get("X-Session-Token");
  if (!token) return NextResponse.json({ error: "No session token" }, { status: 400 });

  const supabase = getSupabaseServerClient();
  await supabase.from("auth_sessions").delete().eq("token", token);
  return NextResponse.json({ ok: true });
}
