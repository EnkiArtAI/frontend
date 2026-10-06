/**
 * Authentication & Authorization System
 * Wallet-based authentication with signature verification
 */

import { NextRequest } from 'next/server';
import { isAddress, verifyMessage } from 'viem';
import { PublicKey } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';
import { getSupabaseServerClient } from '@/lib/supabaseServer';
import { resolveSessionUserWithBan } from '@/lib/session-user';
import { getPromptById } from '@/lib/prompts-db';
import { APP_NAME } from '@/shared/app-config';

export interface AuthenticatedUser {
  walletAddress: string;
  userId: string; // Normalized wallet address as user ID
}

/**
 * @deprecated REPLAYABLE — do not use for authentication. The per-request
 * X-Wallet-Signature/X-Auth-Message path accepts any signature over a
 * client-chosen message (no server nonce, optional timestamp), so a captured
 * signature can impersonate its wallet. No longer called by requireAuth /
 * getAuthenticatedUser; authenticate via the nonce-bound /api/auth/session
 * flow (X-Session-Token) instead. Kept only until callers are confirmed gone.
 */
export async function authenticateUser(request: NextRequest): Promise<AuthenticatedUser> {
  // Extract authentication headers
  const walletAddress = request.headers.get('X-Wallet-Address');
  const signature = request.headers.get('X-Wallet-Signature');
  const message = request.headers.get('X-Auth-Message');
  const timestamp = request.headers.get('X-Timestamp');
  const walletType = request.headers.get('X-Wallet-Type') || 'evm';

  // Validate required headers
  if (!walletAddress || !signature || !message) {
    throw new Error('Missing authentication headers. Required: X-Wallet-Address, X-Wallet-Signature, X-Auth-Message');
  }

  // Validate wallet address format
  if (walletType === 'solana') {
    try {
      new PublicKey(walletAddress);
    } catch {
      throw new Error('Invalid Solana wallet address format');
    }
  } else if (!isAddress(walletAddress)) {
    throw new Error('Invalid wallet address format');
  }

  // Verify timestamp (prevent replay attacks)
  if (timestamp) {
    const requestTime = parseInt(timestamp);
    const currentTime = Date.now();
    const timeWindow = 5 * 60 * 1000; // 5 minutes

    if (Math.abs(currentTime - requestTime) > timeWindow) {
      throw new Error('Authentication timestamp expired');
    }
  }

  // Verify signature
  const isValidSignature = walletType === 'solana'
    ? await verifySolanaWalletSignature(walletAddress, signature, message)
    : await verifyWalletSignature(walletAddress, signature, message);

  if (!isValidSignature) {
    throw new Error('Invalid wallet signature');
  }

  // Return authenticated user. Solana base58 addresses are case-sensitive —
  // only EVM (0x…) addresses are lowercase-normalized.
  const normalized = walletAddress.startsWith('0x')
    ? walletAddress.toLowerCase()
    : walletAddress;

  return {
    walletAddress: normalized,
    userId: normalized
  };
}

/**
 * Verify Solana wallet signature (ed25519)
 * Signature is base64-encoded, message is plain text
 */
export async function verifySolanaWalletSignature(
  publicKeyBase58: string,
  signatureBase64: string,
  message: string
): Promise<boolean> {
  try {
    const pubKeyBytes = new PublicKey(publicKeyBase58).toBytes();
    const sigBytes = Buffer.from(signatureBase64, 'base64');
    const msgBytes = new TextEncoder().encode(message);
    return ed25519.verify(sigBytes, msgBytes, pubKeyBytes);
  } catch (error) {
    console.error('Solana signature verification error:', error);
    return false;
  }
}

/**
 * Verify wallet signature against message
 */
export async function verifyWalletSignature(
  walletAddress: string,
  signature: string,
  message: string
): Promise<boolean> {
  try {
    // Verify message signature using viem
    // viem's verifyMessage returns true if signature is valid for the given address
    return await verifyMessage({
      address: walletAddress as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    });
  } catch (error) {
    console.error('Signature verification error:', error);
    return false;
  }
}

/**
 * Generate authentication message for client to sign
 */
export function generateAuthMessage(walletAddress: string): {
  message: string;
  timestamp: number;
};
export function generateAuthMessage(walletAddress: string, nonce: string): {
  message: string;
  timestamp: number;
};
export function generateAuthMessage(walletAddress: string, nonce?: string): {
  message: string;
  timestamp: number;
} {
  const timestamp = Date.now();
  const message = nonce
    ? `Sign this message to authenticate with ${APP_NAME} Marketplace.

Wallet: ${walletAddress}
Timestamp: ${timestamp}
Nonce: ${nonce}

This signature proves ownership of this wallet and will be used to authenticate your marketplace actions.`
    : `Sign this message to authenticate with Symphora Marketplace.

Wallet: ${walletAddress}
Timestamp: ${timestamp}

This signature proves ownership of this wallet and will be used to authenticate your marketplace actions.`;

  return { message, timestamp };
}

/**
 * Create authentication headers for API requests
 */
export function createAuthHeaders(
  walletAddress: string,
  signature: string,
  message: string,
  timestamp?: number
): Record<string, string> {
  return {
    'X-Wallet-Address': walletAddress,
    'X-Wallet-Signature': signature,
    'X-Auth-Message': message,
    ...(timestamp && { 'X-Timestamp': timestamp.toString() })
  };
}

async function resolveSessionToken(token: string): Promise<AuthenticatedUser | null> {
  // Ban-aware like every other resolver: a suspended account is nobody on the
  // paid rail too. Reading the session row alone let a ban stop the feed but
  // not a purchase or a generation (Kev, 2026-10-06).
  const session = await resolveSessionUserWithBan(getSupabaseServerClient(), token).catch(() => null);
  if (!session?.wallet || session.ban) return null;

  return {
    walletAddress: session.wallet,
    userId: session.wallet,
  };
}

/**
 * Middleware helper to require authentication
 */
export async function requireAuth(request: NextRequest): Promise<AuthenticatedUser> {
  // Session-token only. The legacy per-request X-Wallet-Signature path
  // (authenticateUser) was replayable — the signed message carried no
  // server-issued nonce and the timestamp was optional, so any signature a
  // wallet ever produced could be replayed to impersonate it. All wallet
  // types (EVM, Solana, Turnkey) now authenticate through the nonce-bound,
  // single-use /api/auth/session flow and carry an X-Session-Token.
  const sessionToken = request.headers.get('X-Session-Token');
  const user = sessionToken ? await resolveSessionToken(sessionToken) : null;
  if (!user) {
    throw new Error('Authentication failed: a valid session token is required');
  }
  return user;
}

/**
 * Optional authentication (doesn't throw if not authenticated)
 */
export async function getAuthenticatedUser(request: NextRequest): Promise<AuthenticatedUser | null> {
  // Session-token only (see requireAuth — the signature fallback was replayable).
  const sessionToken = request.headers.get('X-Session-Token');
  return sessionToken ? await resolveSessionToken(sessionToken) : null;
}

/**
 * Check if user owns a prompt (for listing/unlisting operations).
 * Post-consolidation, ownership is `user_id` only.
 */
export async function verifyPromptOwnership(
  promptId: string,
  userId: string
): Promise<boolean> {
  const supabase = getSupabaseServerClient();
  const prompt = await getPromptById(supabase, promptId);
  return !!prompt && prompt.userId === userId;
}

/**
 * Rate limiting helper (basic implementation)
 */
const requestCounts = new Map<string, { count: number; resetTime: number }>();

export function checkRateLimit(
  userId: string,
  action: string,
  maxRequests: number = 10,
  windowMs: number = 60000 // 1 minute
): boolean {
  const key = `${userId}:${action}`;
  const now = Date.now();
  const userLimit = requestCounts.get(key);

  if (!userLimit || now > userLimit.resetTime) {
    // Reset or initialize limit
    requestCounts.set(key, { count: 1, resetTime: now + windowMs });
    return true;
  }

  if (userLimit.count >= maxRequests) {
    return false; // Rate limit exceeded
  }

  userLimit.count++;
  return true;
}
