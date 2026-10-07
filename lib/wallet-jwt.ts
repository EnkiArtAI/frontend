import { SignJWT, importPKCS8, exportJWK, calculateJwkThumbprint, type JWK } from "jose";
import { createPrivateKey, createPublicKey } from "crypto";

/**
 * External-JWT bridge to our embedded-wallet vendor (Privy): after our
 * email+password login we mint a short-lived JWT; the vendor validates it
 * against our public JWKS (GET /api/auth/wallet/jwks) or a pasted static key
 * and provisions the user's embedded wallets. Vendor-neutral by design — the
 * same JWT works for Privy today and any BYO-JWT vendor later.
 *
 * Key: WALLET_JWT_PRIVATE_KEY (base64 of a PKCS8 RSA PEM), generate with
 * scripts/gen-wallet-jwt-key.mjs. (DYNAMIC_JWT_PRIVATE_KEY still read as a
 * fallback so existing .env.local keeps working.)
 */
const ALG = "RS256";
const TTL_S = 10 * 60; // only bridges our session → the vendor, so keep it short

function pem(): string {
  const b64 = process.env.WALLET_JWT_PRIVATE_KEY || process.env.DYNAMIC_JWT_PRIVATE_KEY;
  if (!b64) throw new Error("WALLET_JWT_PRIVATE_KEY not configured");
  return Buffer.from(b64, "base64").toString("utf8");
}

async function publicJwk(): Promise<JWK> {
  const jwk = (await exportJWK(createPublicKey(createPrivateKey(pem())))) as JWK;
  jwk.kid = await calculateJwkThumbprint(jwk);
  jwk.alg = ALG;
  jwk.use = "sig";
  return jwk;
}

export async function publicJwks() {
  return { keys: [await publicJwk()] };
}

/** Short-lived JWT telling the vendor who our logged-in user is (sub = users.id). */
export async function mintWalletJwt(user: { id: string; email: string; username?: string | null }) {
  const key = await importPKCS8(pem(), ALG);
  const { kid } = await publicJwk();
  return new SignJWT({
    email: user.email,
    ...(user.username ? { username: user.username } : {}),
  })
    .setProtectedHeader({ alg: ALG, kid })
    .setSubject(user.id)
    // iss + aud must match what's configured in the CDP dashboard's custom-auth
    // settings. aud is optional there; default to the project id when set.
    .setIssuer(process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3008")
    .setAudience(process.env.WALLET_JWT_AUDIENCE || process.env.NEXT_PUBLIC_CDP_PROJECT_ID || "enki-art")
    .setIssuedAt()
    .setExpirationTime(`${TTL_S}s`)
    .sign(key);
}
