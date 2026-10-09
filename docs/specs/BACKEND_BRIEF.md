# Backend brief (coordinator, for subagents)

**Stack:** Next.js App Router, TypeScript strict, Supabase/PostgREST, Solana USDC via x402, Vercel, Vitest.

**Routes:** `app/api/<domain>/route.ts` per feature (`auth`, `account`, `ban`, `billing`, `payments`, `generate-image`, `generate-free`, `x402`, `gallery`, `library`, `prompt(s)`, `admin`, `cron`, `recovery`, `wallet`, `onramp`, `reports`, `notifications`, `messages`, `models`, `search`, `og`). One route file per concern; don't add a second path for an existing concern (e.g. generation has one core).

**Auth/session:** `lib/auth.ts` (core auth), `lib/session-user.ts` — `resolveSessionUserWithBan`, `activeBanFor`, `resolveSessionUserId`, `resolveOwnerIds` (ban-aware session resolution, used everywhere a route must refuse marketplace access to banned/deleted users but keep the funds door open). Step-up/MFA in `lib/mfa.ts` + `/api/auth/stepup`. Beta allowlist in `lib/allowlist.ts` + `proxy.ts` (`PUBLIC_PATHS`). WebAuthn in `lib/webauthn.ts`.

**Supabase access:** PostgREST via Supabase client, service-role key server-side only. Never derive column/table names from app code — probe the live schema read-only first (CONTRIBUTING.md rule).

**Payment flow:** `lib/payments/*` (`generation-quote.ts`, `generation-pricing.ts`, `authorize-flow.ts`, `authorize-tx.ts`, `settle.ts`, `x402-settle.ts`, `nonce.ts`, `withdraw.ts`, `solana.ts`). Routes: `app/api/payments/generation/{quote,intent,authorize,submit}` then `app/api/generate-image`. Agent rail: `app/api/x402/generate`. Order: durable nonce → authorize → generate → capture; void on provider failure, never settle before the provider call.

**Tests/mocking:** Vitest. `vitest.setup.ts` makes any unmocked `fetch` throw — mock with `vi.stubGlobal("fetch", ...)`. Suites live in `lib/__tests__/`. Live-provider tests are named `*.live.test.ts`/`__live-*`/`__bench-*`, gitignored, excluded from `npm test`.

**Shared files (coordinator-owned or single named agent only, never two writers):** `lib/auth.ts`, `proxy.ts`, `components/BetaGate.tsx`, `lib/webauthn.ts`, `lib/mfa.ts`, `app/api/generate-image/route.ts`, `app/api/x402/generate/route.ts`.
