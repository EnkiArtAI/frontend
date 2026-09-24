# Enki Art

Prompt marketplace with paid image generation. Artists list prompts, buyers
generate images from them, and every generation is paid per image in USDC on
Solana. Agents pay the same way over x402 without holding an account.

## What it does

- **Prompts with variables.** A prompt is a template with `[bracket]` slots
  the buyer fills before generating (`lib/enkiPromptAdapter.ts`).
- **Pay per image.** The customer price is the real API cost of the model plus
  exactly 10 percent, plus the artist's listed price when the prompt is not
  free. The split is computed on the server only, in integer micro USDC
  (`lib/payments/generation-pricing.ts`, `PRICING_POLICY.enkiFeeBps = 1000`).
- **Two payment rails, both Solana USDC.**
  - Signed in users: `POST /api/payments/generation/intent`, `/authorize`,
    `/submit`, then `POST /api/generate-image`. The server builds a durable
    nonce transaction from the stored intent, the buyer signs it in their own
    wallet, and the server broadcasts it only after the image is stored
    (`lib/payments/authorization.ts`, `lib/payments/settle.ts`).
  - Agents: `GET` or `POST /api/x402/generate` answers HTTP 402 with exact
    requirements; the agent resends with an `X-PAYMENT` header carrying a
    partially signed USDC transfer, the server verifies it offline, co-signs
    as fee payer, submits, generates and answers 200
    (`app/api/x402/generate/route.ts`, `lib/payments/x402-settle.ts`).
- **Models.** `nano-banana-pro` (Gemini direct) and `gpt-image-2` (OpenAI
  direct), priced per resolution tier in `lib/pricing.ts`. Routes and
  fallbacks come from the `models` and `model_providers` tables
  (`lib/generation/models.ts`, `lib/generation/routing.ts`).

## Stack

- Next.js 16 (App Router, Turbopack in dev, webpack for `next build`),
  React 19, TypeScript, Tailwind CSS 4, Radix UI
- Supabase (Postgres over PostgREST) for data, Vercel Blob for images
- Vercel for hosting; `maxDuration = 300` on the generate routes
- Solana: `@solana/web3.js`, `@solana/spl-token`, USDC transfers only
- Coinbase CDP embedded wallets for signed in users
  (`@coinbase/cdp-hooks`, `hooks/useCdpSolanaSigner.ts`). The server never
  holds a key that can move user funds; `SOLANA_FEE_PAYER_SECRET_KEY` pays
  transaction fees and account rent only (`lib/payments/solana.ts`)
- Provider adapters under `backend/services/`: Gemini, OpenAI, WaveSpeed,
  Pollinations
- Auth: email and password or wallet signature sessions (`app/api/auth/**`),
  opt in passkey step up 2FA with `@simplewebauthn` (`lib/webauthn.ts`,
  `hooks/usePasskey.ts`), private beta allowlist (`proxy.ts`,
  `lib/allowlist.ts`)

## Local setup

```bash
git clone https://github.com/EnkiArtAI/frontend.git
cd frontend
npm ci
cp .env.example .env.local   # ask Kev for the values, never paste them into chat or tickets
npm run dev -- -p 3008       # http://localhost:3008
npm run check                # tsc
npm test                     # vitest, lib/** suites
npm run lint
```

The `dev` script has no port flag. The app's own defaults (`WEBAUTHN_ORIGIN`
in `lib/webauthn.ts`, `NEXT_PUBLIC_APP_URL` in `lib/wallet-jwt.ts`) assume
`http://localhost:3008`, so pass `-p 3008` or set those two variables.

Environment variable names the code reads (values come from Kev, never from
a commit or a chat message):

| Purpose | Names |
| --- | --- |
| Supabase | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` |
| Image storage | `BLOB_READ_WRITE_TOKEN` |
| Providers | `GEMINI_API_KEY` or `GOOGLE_GEMINI_API_KEY`, `OPENAI_API_KEY`, `WAVESPEED_API_KEY`, `XAI_API_KEY` |
| Solana payments | `SOLANA_PAYMENT_CHAIN`, `SOLANA_RPC_URL`, `SOLANA_PLATFORM_WALLET`, `NEXT_PUBLIC_SOLANA_PLATFORM_WALLET`, `SOLANA_FEE_PAYER_SECRET_KEY` |
| Wallets | `NEXT_PUBLIC_CDP_PROJECT_ID`, `CDP_API_KEY_ID`, `CDP_SECRET_KEY`, `WALLET_JWT_PRIVATE_KEY`, `NEXT_PUBLIC_THIRDWEB_CLIENT_ID` |
| Auth and encryption | `AUTH_PEPPER`, `WEBAUTHN_ORIGIN`, `WEBAUTHN_RP_ID`, `FIELD_ENCRYPTION_KEY_B64`, `PROMPT_ENCRYPTION_KEY` |
| Beta gate | `TEAM_ACCESS_CODE` (unset disables the gate) |

`.env.example` still lists Privy and MongoDB variables and
`NEXT_PUBLIC_SUPABASE_ANON_KEY` (also a dummy in `.github/workflows/ci.yml`);
nothing in `app/` or `lib/` reads them. The server reads `SUPABASE_ANON_KEY`
(`lib/supabaseServer.ts`).

## Where things are

- `app/api/**` route handlers, `app/**/page.tsx` pages
- `lib/payments/**` pricing, quotes, intents, durable nonce authorisation,
  x402 settlement
- `lib/generation/**` model resolution, routing, concurrency, recording
- `lib/webauthn.ts`, `lib/auth.ts`, `lib/allowlist.ts`, `proxy.ts` auth and
  the beta gate
- `hooks/useGenerationCore.ts` the single source of generation settings
  (option lists, prices, visibility) for every surface; it sends no request.
  The generate requests go out from `components/enki-shell/generation.ts`
  and `components/PromptGeneratorView.tsx`
- `components/**`, `hooks/**`, `providers/**` client code
- `migrations/**` SQL, applied by hand against the live database
- `shared/**` payment chain config imported by both sides
- `scripts/metered-guard.mjs` the guard every paid probe must import

## Rules and evidence

- Contribution rules, review territories, secrets and money rules:
  [CONTRIBUTING.md](CONTRIBUTING.md). Reviewers per path:
  `.github/CODEOWNERS`.
- Money path requirements: [docs/PAYMENT-SECURITY-PATTERNS.md](docs/PAYMENT-SECURITY-PATTERNS.md).
- Sprint 1 verified state and evidence: [docs/SPRINT-1-FINDINGS.md](docs/SPRINT-1-FINDINGS.md).
- CI (`.github/workflows/ci.yml`): eslint, tsc, vitest, `next build`.

## Do not build on

These exist in the tree, are not deployed, and are being deleted:

- the Express server under `backend/` (`backend/app.ts`, `backend/index-*.ts`,
  `backend/routes/**`, `backend/middleware/**`)
- `backend/workers/generation-worker.ts` and
  `backend/services/generation-processor.ts`
- `backend/oracles/**`, `backend/price-oracle*.ts`
- the multi token path: `backend/multi-token-engine.ts`,
  `backend/token-registry.ts`, `backend/token-risk-engine.ts`,
  `backend/payment-system.ts`

The live parts of `backend/` are the four image adapters, their types and
`variable-substitution.ts` under `backend/services/`, `backend/encryption.ts`,
`backend/facilitator.ts`, `backend/solana-x402-verifier.ts` and
`backend/x402-engine.ts`; each is imported from `app/` or `lib/`.

## License

MIT (`package.json`). No LICENSE file is checked in yet.
