# Sprint 1 findings (verified 2026-09-23)

Evidence behind the ClickUp tasks for Sprint 1 (2026-09-23 to 2026-10-12). Every
claim below was checked against the code on disk (branch `trial-merge-110`,
which contains `feat/generation-core` plus the merged mobile PR #110) and, where
it says "live", against the production Supabase over PostgREST with read only
probes. Nothing here is derived from code alone. Line numbers drift; grep the
quoted identifier when they do.

Live baseline: `users` 27, `user_wallets` 16 (all external Solana),
`auth_sessions` 111 historical (102 solana, 9 turnkey, 0 password),
`password_credentials` 0, `webauthn_credentials` 0, `bans` 0, `prompts` 12
(2 listed), `generations` 9 (all 2026-08-12, free pollinations),
`generated_images` 0, `generation_reference_images` 0, `payment_verifications` 29,
`generation_payment_intents` 1 (stuck since 2026-08-12).

## 1. Prompt encryption (ClickUp ENC)

Works at rest. All 12 prompts carry AES-256-GCM ciphertext with a 12 byte IV, a
16 byte tag and kid `field-v1`; every row decrypts with the configured key
through `lib/crypto.ts` (round trip test run today). The keyring design is sound
(kid labelled ciphertext, retired keys, refuses unknown kids and tampered data).
`automod_events` stores only a hash and an encrypted excerpt. The agent route
`app/api/x402/generate` decrypts server side and never returns the text.

The product around it leaks:

- `app/api/prompt/route.ts` line 308 writes `public_prompt_text = content.slice(0, 220)`
  for every prompt, paid included. Both live paid prompts carry a plaintext
  excerpt; for one it is the whole body. `app/api/marketplace/prompts` serves it
  as `description` and `promptTemplate` for all rows; `app/api/prompts/[id]`
  serves it for paid rows.
- `GET /api/prompt?id=` (lines 505 to 607) decrypts and returns any prompt's body
  with no session and no ownership check. Only the beta cookie stands in front.
- Paying humans never generate from the encrypted body: `components/PromptGeneratorView.tsx`
  847 to 894 sends title plus variable values and `app/api/generate-image/route.ts`
  line 268 uses that text. Buyers pay to generate from the title. The intent row
  carries `prompt_id`, so the route can load and decrypt server side like x402 does.
- The `prompts` and `prompt_variables` tables are readable with the anon key over
  PostgREST (200, the two listed rows, ciphertext and excerpt included). RLS gap.
- Link preview bots reach `/generator/[id]` without the cookie and its
  `generateMetadata` puts the excerpt into og:description, for drafts too.
- Every prompt body is sent in plaintext to OpenAI moderation on save and on
  generation (`lib/moderation/tier2-openai.ts` line 63). By design; must be in
  the privacy policy.
- Dead: `lib/prompts-db.ts` getPromptDecrypted reads columns `iv` and `auth_tag`
  that do not exist; `content/secure` always 500s and no token issuer has a
  caller; `content` returns the literal string "Unlocked prompt content"; four
  legacy sites decrypt with an empty IV (`ERR_CRYPTO_INVALID_IV`).
- Live columns `prompts.encrypted_content_*` and `generations.final_prompt_*`
  have no migration in the repo. `derived_from_prompt_id` is written by the
  route but absent live (the 2026-08-24 provenance migration is unapplied), so
  any save with `derivedFrom` fails.
- `.env.example` calls the key optional; `lib/crypto.ts` throws without it.
- Backend vitest only loads from inside `backend/` and its `@` alias points at
  `backend/`, so 9 of 29 encryption tests fail and CI never runs them.

## 2. Images and recording (ClickUp ENG-07, REC, PAY-1)

Every route returns the image to the caller. Persistence is broken:

- `generate-free` returns a base64 data URL, never uploads, and calls
  `recordGeneration` without `imageUrl`; `lib/generation/record.ts` writes
  `generated_images` only when `imageUrl` is set. Hence 0 rows.
- `x402/generate` uploads under the pseudo user `x402-agent`, writes no row,
  hard codes `image/png`, settles the payment before the provider call and has
  no refund path (502 "contact support").
- `generate-image` uploads every paid image twice (route plus
  `storeGeneratedImage`), the first copy has no user in its path; records
  `promptId: null` so every paid render creates a new draft prompt instead of
  crediting the marketplace prompt (live: 9 generations point at 9 draft
  prompts); never writes `amount_paid_cents`, so paid generations consume the
  three free ones; records `chain_key` base-sepolia and no transaction hash;
  captures the payment after a failed blob upload was swallowed into a data URL.
- Vercel functions cap responses at 4.5 MB. A 2K PNG is 7 MB, 4K up to 21 MB.
  The data URL fallback therefore charges the buyer and answers HTTP 413.
- The legacy `X-PAYMENT` branch of `generate-image` is the only paid path of the
  browser editor (`components/EnkiPromptEditor.tsx` 485, 2566) and of `/generate`.
  It bills before the provider call, sends no session, records nothing and
  stores a redacted signature.
- The node editor sends no session header (`components/enki-shell/generation.ts`
  62 to 64): free generation answers 401, paid 501. `persistCreation` posts JSON
  to a FormData endpoint and always fails silently. `generateNanoBanana` has no
  caller.
- Five dead client calls to the legacy `POST /api/generations` (columns absent
  live, PGRST204 swallowed).
- `sweepAndFlush` for abandoned authorizations runs only inside `generate-image`;
  no cron exists; one authorization from 2026-08-12 is still open.
- All six blob uploads are `access: 'public'` at guessable paths, cached at the
  edge for a month, while rows say `visibility: 'private'`.
- Marketplace paid flow (`PromptGeneratorView` → `lib/generation-checkout.ts`
  line 130) hard codes the CDP signer. Wallet only users never mount the CDP
  runtime, so the request times out after 60 seconds: 102 of 111 sessions
  cannot buy a generation from a prompt page.

Provider adapters return Buffers (no expiring provider URLs). `BLOB_READ_WRITE_TOKEN`
is present locally and the two live showcase URLs are on our blob host; the code
comment saying the token is empty is stale. Presence on Vercel is unverified.

## 3. Banned users and funds (ClickUp BAN)

No ban locks funds cryptographically. External wallet users hold their keys.
Artist payouts happen inside the buyer's transaction (`lib/payments/generation-pay.ts`),
there is no platform balance (`user_earnings` and `marketplace_prompts` do not
exist live). `/api/auth/wallet/jwt` is ban blind, so an embedded wallet can still
sign.

In practice a banned embedded user is stuck:

- No send, transfer or withdraw UI exists anywhere. "Pay out" is the Coinbase
  or MoonPay offramp (needs a send that does not exist). Key export lives only
  in `/settings`; the recovery file flow calls the ban aware `/api/users/handle`
  and fails while banned.
- `/banned`, `/api/ban/me`, `/api/ban/appeal`, `/api/billing/balance` are not in
  `proxy.ts` isPublic nor in `BetaGate` PUBLIC_PATHS. It works today only because
  login grants banned users the team cookie, which also lets them browse the
  entire UI.
- `requireAuth` never checks bans: generation, payments, prompt creation,
  passkey registration, offramp all accept banned sessions. Eight more routes
  read `auth_sessions` directly.
- Three hard funds locks: allowlist removal (login refused before a session
  exists), IP ban (no new session for 24 hours, shared NAT hits innocents),
  account deletion (not enforced at login today, by accident).
- `/api/ban/me` classifies CDP wallets as external because `attach-wallet`
  stores them as `external_eoa`.
- The CDP export hook `useExportSolanaAccount` is deprecated; its replacement
  keeps the key in a Coinbase iframe, so the recovery file feature breaks on
  the next forced SDK change.

Design: the funds door stays open by design (login → `/banned` → balance, send
USDC, export), the marketplace doors close, withdraw is server built like the
payment flow (fee payer Enki, offline verification as in `x402-settle`), step up
before money moves with a single use scope.

## 4. Step up 2FA (ClickUp MFA)

`lib/webauthn.ts` `requireStepUp` is correct: HS256 token bound to user and
scope, 5 minute TTL, fails closed on DB error (7 case suite run today). But:

- Opt in: users without a passkey are never challenged. Wired into one route
  only, `DELETE /api/generations/[id]`, which then fails with a uuid ilike
  error (Postgres 42883). The gate is skipped when the wallet has no users row.
- Inert in production: 0 passkeys live; `WEBAUTHN_ORIGIN` is set nowhere
  visible, so enrollment on prod would be rejected. simplewebauthn 13 accepts
  arrays, so one deployment can accept prod plus a fixed preview alias.
- Tokens carry no jti: replayable for 300 seconds. A withdraw scope needs a
  single use request id.
- Passkey removal is session only (a stolen session strips the factor first).
  Guardian recovery never clears `webauthn_credentials`: a lost passkey device
  means permanent lockout from gated actions.
- No withdraw route exists. No prompt delete route exists. Library delete
  targets a table that is missing live (`saved_workflows` migration unapplied).
- `POST /api/gallery/upload` has no real authentication (header equals form
  field). `components/enki-shell/generation.ts` 157 is a dead upload call.
- TOTP exists (`lib/totp.ts`, guardian type, never exercised live). Email codes
  cannot ship: no user has a stored email (0 of 27), no verification flow.
- The scope cap is 64 characters (`stepup/verify` line 19).

Tiers (recommendation): withdraw and export mandatory; deletes and factor
removal mandatory when enrolled, interstitial otherwise; add actions opt in.

## 5. Social login (ClickUp SOC)

- Google: feasible, free. Scopes openid email profile need no verification;
  publishing requires a public home page with privacy policy and terms links.
  Refuses iframes (X-Frame-Options DENY) and embedded WebViews
  (`disallowed_useragent`). Exact HTTPS redirect URI per environment, so no
  social login on preview URLs; localhost is exempt.
- X: feasible with caveats. No free tier since 2026-02-06; "User: Read
  $0.010 per resource", so about $0.01 per login, and our sessions last 24
  hours. Email only with `users.email` scope and a confirmed address. Refuses
  iframes (SAMEORIGIN).
- Instagram: Meta shut down consumer Instagram APIs on 2024-12-04; remaining
  APIs are Business and Creator only. Facebook Login is the only Meta path and
  logs in Facebook accounts. Offer a profile handle instead.
- Our auth: custom `auth_sessions`, password users bridge with
  `wallet_address = users.id` and `wallet_type 'password'`; this bridge has
  never run live. No identities table exists (`auth_identities` is free).
  `jose` 6 is installed; `arctic` is deprecated; Auth.js and Supabase Auth
  bring their own session model.
- Blockers: `/api/auth/wallet/jwt` refuses accounts without a
  `password_credentials` email; `attach-wallet` accepts only password
  sessions; the CDP runtime mounts only when a localStorage email exists;
  `resolveCreatorId` in `app/api/prompt/route.ts` has no UUID branch and
  inserts a duplicate users row on the first prompt save of any bridge session;
  the landing modal's password login is a stub and ships a client side
  `WHITELIST` constant used in the signup branch; `BetaGate` admits only roles
  beta, mod, admin, so after the whitelist stage every self registered user is
  walled out (13 live users already have role `user`); guardian recovery is
  password only; key export re checks the password.

## 6. Share previews and the before and after curtain (ClickUp SHR, CUR)

- A share card exists per prompt (`app/generator/[id]/page.tsx` generateMetadata,
  `app/api/og/[id]/route.tsx`, bots allowlisted in `proxy.ts`). It renders
  drafts and soft deleted prompts (no `is_listed`, no `deleted_at` filter) and
  leaks title, price and description.
- Per image is impossible until recording works: 0 `generated_images`, the
  generate responses carry no image id (recording runs in `after()`), no per
  image URL or page. `visibility` allowed values are unverified; the only value
  in the repo is `private`.
- No "before" exists anywhere: 0 reference image rows, 0 reference image
  variables, `/api/prompt` silently drops the `referenceImages` array the editor
  already sends (`EnkiPromptEditor.tsx` 2924), gallery upload has no before
  field, `prompt_showcase_images` (has `source_generation_id`) has 0 rows and no
  writer. All 12 prompts are text to image. The free route refuses reference
  images (422).
- Two "startpages": the public landing `public/landing.html` (static, already
  holds 5 base photos with 6 variations each in `kvSets`, lines 4686 to 4745,
  files in `public/previews`) and the gated `/home` feed (`components/enki/EnkiCard.tsx`
  48 to 54). Landing first is a pure HTML and CSS change.
- Vercel Blob: $5 per 1M advanced operations; Hobby caps 1 GB, 10 GB transfer,
  2,000 ops per month and switches Blob off for 30 days when exceeded. Each paid
  image costs two originals and four operations today.

## 7. Coinbase CDP embedded wallets (ClickUp DEC-01, WAL)

Permissioned three ways:

- Contract: CDP terms let Coinbase terminate or suspend "at its sole
  discretion, at any time, for any reason without prior notice", set API limits
  without notice, and name restricted jurisdictions (Iran, Cuba, North Korea,
  Syria, Crimea, Donetsk, Luhansk plus sanctions law). The portal requires an
  authorized domain allowlist (max 50), so every preview URL needs registration.
- Architecture: CDP generates the key (`providers/CdpProvider.tsx` 29 to 30,
  `createOnLogin`), it lives in Coinbase run AWS Nitro enclaves, every
  signature is an API call to Coinbase, export only user side inside a Coinbase
  iframe, no bulk export, the hook we use is deprecated. 5,000 operations per
  month free, then $0.005 each; a Solana signature is one operation.
- Our code: the 2026-07-23 plan (generate the key client side, encrypt under
  the password, import into CDP as signer only) was never built. Installed SDK
  0.0.113 is 13 releases behind 0.0.126. `@coinbase/cdp-sdk` used by the onramp
  is only a transitive dependency of thirdweb.

Live: 0 password accounts, so 0 CDP wallets exist. Switching costs no user.

Recommendation: our own client side Solana key wrapped under the account
password (Argon2id plus AES-256-GCM, primitives already in the repo), signing
locally, external wallets first in the signer chain, Coinbase only as fiat
onramp. Costs: a forgotten password without a recovery file is wallet loss
(today the CDP wallet survives a password reset because it is keyed to
users.id); the seed sits in page memory during a session (needs CSP and an
isolated unlock context); unlock takes about 2 seconds of Argon2id on desktop,
more on phones; Enki's database becomes the only holder of the ciphertext, so
the banned page must hand it out. Alternatives rejected: LazorKit passkey
wallets (vendor portal and paymaster, PDA not importable, contradictory audit
status), Lit and Web3Auth (operator networks or dashboards with a client id),
Turnkey, Privy, Dynamic, Magic (all permissioned, evaluated in July).

Tension for Kev: 2026-07-10 said no self rolled wallet crypto; 2026-07-23 said
generate and encrypt the key client side with the vendor only signing. The
recommendation is the 07-23 design without the vendor copy.

## 8. Repository map (for CONTRIBUTING and CODEOWNERS)

- Server: `app/api` (82 routes), server side `lib/**`, `migrations/` (45 SQL),
  10 live files under `backend/` (four image adapters and types, Solana verifier,
  encryption shim, x402 engine and facilitator, logger). 26 `backend/` files are
  dead; the Express server is not deployed.
- Client: `components/` (43k lines), `hooks/`, `providers/`, `app/**/page.tsx`,
  `public/landing.html` (5.4k lines, own login UI).
- Shared (imported by both sides): `lib/session-headers.ts`, `lib/pricing.ts`,
  `lib/generation/{model-family,resolution,variable-dice}.ts`, `lib/auth.ts`,
  `lib/cdp-bridge.ts`, `shared/*`.
- Money and security (strictest review): `proxy.ts`, `lib/allowlist.ts`,
  `app/api/auth/**`, `lib/{auth,session-user,user-session,password-auth,wallet-jwt,webauthn,totp,rate-limit,crypto}.ts`,
  `app/api/payments/**`, `app/api/x402/**`, `lib/payments/**`, `lib/moderation*`,
  `app/api/admin`, `app/api/ban/*`, `app/api/recovery/**`, `app/api/account/**`.
- CI (`.github/workflows/ci.yml`): eslint, tsc, vitest over `lib/**` only, next
  build. Backend tests are not included. No CODEOWNERS existed before this sprint.
- Dead and stray: `app/middleware.ts` (wrong location, protects zero routes),
  30 components and hooks with zero importers (including `GeneratorInterface`,
  `PromptEditor`, `ImageLightbox`, `SearchInterface`), 7 lib modules,
  `COMPLETE_DATABASE_MIGRATION.sql`, `recover_css.py`, `scratch.tsx`,
  `pnpm-lock.yaml`, 36 MB untracked `bench-output/`. Legacy pages `/dashboard`,
  `/generate`, `/api-test`, `/test`, `/recovery/status` have no inbound links.
- Search is a client side filter over the loaded feed; `app/api/marketplace/search`
  has no live caller.
