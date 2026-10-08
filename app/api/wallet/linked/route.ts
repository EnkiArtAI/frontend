/**
 * /api/wallet/linked: Solana wallets an account links so the NFT picker shows
 * their NFTs too (Kev, 2026-10-08: email accounts link Phantom or Solflare).
 *
 *   GET                                  → { wallets: string[] }
 *   POST   { address, signature, nonce } → { linked, already? }
 *   DELETE { address }                   → { unlinked }
 *
 * Only the wallet itself can link it: it signs linkWalletMessage over a nonce
 * from /api/auth/nonce (single use, five minutes), and the server rebuilds
 * that text with its own host, so a login signature links nothing and nobody
 * links an address they do not hold.
 *
 * A linked wallet lives in linked_wallets, which the NFT list alone reads
 * (lib/wallet-nfts): it never signs in, pays, gets paid or shows publicly.
 * One wallet may be linked to several accounts, since all it opens is NFTs
 * anyone can look up.
 */
import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserWithBan } from "@/lib/session-user";
import { verifySolanaWalletSignature } from "@/lib/auth";
import { linkWalletMessage } from "@/lib/link-wallet-message";
import { MAX_LINKED } from "@/lib/wallet-nfts";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { dbUnavailableResponse, isDbUnreachable } from "@/lib/db-error";

const solanaAddress = z.string().max(44).refine((a) => { try { new PublicKey(a); return true; } catch { return false; } });
const linkBody = z.object({
  address: solanaAddress,
  signature: z.string().max(200),
  // /api/auth/nonce issues 32 random bytes as hex; nothing else reaches the signed text.
  nonce: z.string().regex(/^[0-9a-f]{64}$/),
});
const unlinkBody = z.object({ address: solanaAddress });

type Supabase = ReturnType<typeof getSupabaseServerClient>;

const failed = (error: unknown, message: string) =>
  isDbUnreachable(error) ? dbUnavailableResponse() : NextResponse.json({ error: message }, { status: 500 });

/** The signed-in, unsuspended account behind the request, or the answer that turns it away. */
async function account(supabase: Supabase, req: NextRequest): Promise<string | NextResponse> {
  try {
    const { userId, ban } = await resolveSessionUserWithBan(supabase, req.headers.get("X-Session-Token"));
    if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    if (ban) return NextResponse.json({ error: "This account is suspended.", banned: true }, { status: 403 });
    return userId;
  } catch (e) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    throw e;
  }
}

export async function GET(req: NextRequest) {
  const supabase = getSupabaseServerClient();
  const userId = await account(supabase, req);
  if (typeof userId !== "string") return userId;
  const { data, error } = await supabase.from("linked_wallets").select("address").eq("user_id", userId).order("linked_at", { ascending: true });
  if (error) return failed(error, "Your linked wallets could not be read");
  return NextResponse.json({ wallets: (data ?? []).map((w) => String(w.address)) });
}

export async function POST(req: NextRequest) {
  const limit = checkRequestRateLimit(rateLimitKey(req, "wallet:link"), 10, 60_000);
  if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

  const supabase = getSupabaseServerClient();
  const userId = await account(supabase, req);
  if (typeof userId !== "string") return userId;

  const parsed = linkBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const { address, signature, nonce } = parsed.data;

  // Checked before the nonce is spent, so a forged request cannot burn it.
  const message = linkWalletMessage({ domain: req.nextUrl.host, address, nonce });
  if (!(await verifySolanaWalletSignature(address, signature, message))) {
    return NextResponse.json({ error: "Invalid wallet signature" }, { status: 401 });
  }
  // The nonce route stores the address lowercased, as for the login.
  const { data: consumed, error: nonceError } = await supabase.rpc("consume_auth_nonce", {
    p_wallet_address: address.toLowerCase(),
    p_nonce: nonce,
  });
  if (isDbUnreachable(nonceError)) return dbUnavailableResponse();
  if (nonceError || !consumed) {
    return NextResponse.json({ error: "This signature expired or was already used. Link the wallet again." }, { status: 401 });
  }

  const { data: mine, error } = await supabase.from("linked_wallets").select("address").eq("user_id", userId);
  if (error) return failed(error, "Could not check the wallet");
  if ((mine ?? []).some((w) => w.address === address)) return NextResponse.json({ linked: address, already: true });
  // Each linked wallet is one more paid NFT-index call every time the picker opens.
  if ((mine ?? []).length >= MAX_LINKED) {
    return NextResponse.json({ error: `You can link up to ${MAX_LINKED} wallets. Unlink one first.` }, { status: 409 });
  }
  const { error: writeError } = await supabase.from("linked_wallets").insert({ user_id: userId, address });
  // 23505: the same link landed a moment ago (a double click).
  if (writeError?.code === "23505") return NextResponse.json({ linked: address, already: true });
  if (writeError) return failed(writeError, "Could not save the wallet");
  return NextResponse.json({ linked: address });
}

export async function DELETE(req: NextRequest) {
  const supabase = getSupabaseServerClient();
  const userId = await account(supabase, req);
  if (typeof userId !== "string") return userId;
  const parsed = unlinkBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const { data, error } = await supabase.from("linked_wallets").delete()
    .eq("user_id", userId).eq("address", parsed.data.address).select("address");
  if (error) return failed(error, "Could not unlink the wallet");
  if (!data?.length) return NextResponse.json({ error: "No linked wallet with that address" }, { status: 404 });
  return NextResponse.json({ unlinked: parsed.data.address });
}
