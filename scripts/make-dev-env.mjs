#!/usr/bin/env node
// Builds a DEV .env.local for one developer. Generates fresh dev-only secrets
// locally, writes fixed dev values, and leaves PASTE_FROM_DASHBOARD markers for
// everything that only the dev project dashboards can hand out. Nothing here
// is ever a production value, and the script never prints a secret.
//
//   node scripts/make-dev-env.mjs --tier core        # frontend and most tasks
//   node scripts/make-dev-env.mjs --tier generation  # core + image providers
//   node scripts/make-dev-env.mjs --tier payments    # core + wallet, payments, login
//   node scripts/make-dev-env.mjs --tier all
//   options: --out <path> (default .env.local)  --force (overwrite)
//            --new-environment  generate the ENVIRONMENT secrets (pepper, encryption
//                               key, content token secret) instead of pasting them.
//                               Run once per environment (Kev), then share the three
//                               values through the vault: every developer on the same
//                               database must use the same ones, or encrypted rows
//                               written by one developer are unreadable for the others.
//
// Tiers are described in docs/DEV-ENV.md and mirrored in .env.example.
import { randomBytes, generateKeyPairSync } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback; };
const tier = opt("--tier", "core");
const out = opt("--out", ".env.local");
const force = args.includes("--force");
const newEnvironment = args.includes("--new-environment");
const TIERS = ["core", "generation", "payments", "all"];
if (!TIERS.includes(tier)) { console.error(`--tier must be one of ${TIERS.join(", ")}`); process.exit(2); }
if (existsSync(out) && !force) { console.error(`${out} exists. Pass --force to overwrite it.`); process.exit(2); }

const b64 = (n) => randomBytes(n).toString("base64");
const PASTE = "PASTE_FROM_DASHBOARD";
const lines = [];
const report = { generated: [], fixed: [], paste: [] };
const section = (title) => lines.push("", `# ---- ${title} ----`);
const gen = (k, v) => { lines.push(`${k}=${v}`); report.generated.push(k); };
const fixed = (k, v) => { lines.push(`${k}=${v}`); report.fixed.push(k); };
const paste = (k, hint) => { lines.push(`# ${hint}`, `${k}=${PASTE}`); report.paste.push(k); };

lines.push(`# Enki Art DEV environment, tier "${tier}", generated ${new Date().toISOString().slice(0, 10)}.`,
  "# Dev only. Never paste production values into this file, never commit it.");

section("core: app");
fixed("NEXT_PUBLIC_APP_NAME", "Enki Art (dev)");
fixed("NEXT_PUBLIC_APP_URL", "http://localhost:3008");
fixed("NEXT_PUBLIC_SITE_ORIGIN", "http://localhost:3008");
fixed("WEBAUTHN_ORIGIN", "http://localhost:3008");
gen("TEAM_ACCESS_CODE", randomBytes(9).toString("base64url"));

section("core: database (the enki-dev Supabase project, never production)");
paste("SUPABASE_URL", "Supabase dashboard > enki-dev > Settings > API > Project URL");
paste("SUPABASE_SERVICE_ROLE_KEY", "Supabase dashboard > enki-dev > Settings > API > service_role");
paste("SUPABASE_ANON_KEY", "Supabase dashboard > enki-dev > Settings > API > anon");

section("core: ENVIRONMENT secrets, identical for everyone on the same database");
if (newEnvironment) {
  gen("AUTH_PEPPER", b64(32));
  gen("FIELD_ENCRYPTION_KEY_B64", b64(32));
  gen("CONTENT_ACCESS_TOKEN_SECRET", b64(32));
} else {
  paste("AUTH_PEPPER", "team vault > enki-dev > AUTH_PEPPER (generated once with --new-environment)");
  paste("FIELD_ENCRYPTION_KEY_B64", "team vault > enki-dev > FIELD_ENCRYPTION_KEY_B64 (same for every dev, or prompts written by one dev are unreadable for the next)");
  paste("CONTENT_ACCESS_TOKEN_SECRET", "team vault > enki-dev > CONTENT_ACCESS_TOKEN_SECRET");
}

section("core: chain (devnet only)");
fixed("SOLANA_PAYMENT_CHAIN", "solana-devnet");
fixed("SOLANA_RPC_URL", "https://api.devnet.solana.com");
const platform = Keypair.generate(); // only the public key is kept: the dev platform wallet just receives devnet fees
fixed("SOLANA_PLATFORM_WALLET", platform.publicKey.toBase58());
fixed("NEXT_PUBLIC_SOLANA_PLATFORM_WALLET", platform.publicKey.toBase58());

section("core: optional services (leave empty, the app degrades honestly)");
paste("BLOB_READ_WRITE_TOKEN", "Vercel > Storage > dev blob store, optional; without it images stay data URLs in dev");
paste("RESEND_API_KEY", "Resend dashboard, optional; without it no mail is sent");
fixed("EMAIL_FROM", "onboarding@resend.dev");

if (tier === "generation" || tier === "all") {
  section("generation: one key PER DEVELOPER with a hard spend cap in the provider console");
  paste("GEMINI_API_KEY", "Google AI Studio, dev project, budget alert set");
  paste("OPENAI_API_KEY", "OpenAI platform, dev project with a monthly budget");
  paste("WAVESPEED_API_KEY", "WaveSpeed console, small prepaid balance only");
  paste("XAI_API_KEY", "xAI console (dice suggestions), optional");
  fixed("METERED_MAX_IMAGES", "1");
}

if (tier === "payments" || tier === "all") {
  section("payments and login: devnet keys and dev projects");
  const feePayer = Keypair.generate();
  gen("SOLANA_FEE_PAYER_SECRET_KEY", JSON.stringify(Array.from(feePayer.secretKey)));
  report.feePayerPublicKey = feePayer.publicKey.toBase58();
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  gen("WALLET_JWT_PRIVATE_KEY", Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64"));
  paste("NEXT_PUBLIC_CDP_PROJECT_ID", "Coinbase CDP portal > the enki-dev project");
  paste("CDP_API_KEY_ID", "Coinbase CDP portal > enki-dev > API keys");
  paste("CDP_SECRET_KEY", "Coinbase CDP portal > enki-dev > API keys");
  paste("GOOGLE_OAUTH_CLIENT_ID", "Google Cloud > dev OAuth client with redirect http://localhost:3008/api/auth/oauth/google/callback");
  paste("GOOGLE_OAUTH_CLIENT_SECRET", "same client");
  paste("X_OAUTH_CLIENT_ID", "X developer console > dev app, redirect http://localhost:3008/api/auth/oauth/x/callback");
  paste("X_OAUTH_CLIENT_SECRET", "same app");
}

writeFileSync(out, lines.join("\n") + "\n", { mode: 0o600 });

console.log(`wrote ${out} (tier ${tier})`);
console.log(`  generated locally : ${report.generated.join(", ")}`);
console.log(`  fixed dev values  : ${report.fixed.join(", ")}`);
console.log(`  paste from dashboards (${report.paste.length}): ${report.paste.join(", ")}`);
if (report.feePayerPublicKey) console.log(`  fund the devnet fee payer (public key, not a secret): ${report.feePayerPublicKey}\n  faucet: https://faucet.solana.com`);
