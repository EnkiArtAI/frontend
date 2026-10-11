# REC-8 · Storage privacy: Cloudflare R2, unlisted by unguessable keys

Source: https://app.clickup.com/t/86cbk4ffp
Baseline: main @ 470739a (identical to origin/main, verified 2026-10-11 via compare API)
Stack base: `feat/rec-3-x402-recording` (PR #168) — rule 4.11. PR #168 touches
`lib/generation/record.ts` + `app/api/x402/generate/route.ts` but NOT
`derivative-store.ts`, so the helper below is conflict-free against it.
Status: Draft (written 2026-10-11, coordinator; CI billing-blocked — Phase 3+ cannot start until a human fixes GitHub Actions billing)

## Done / Remaining

| Item | State | Evidence (file:line) |
|---|---|---|
| One storage chokepoint for generations/free/agent/showcase | Done (exists) | `lib/generation/derivative-store.ts` — `storeGeneratedImage` (:235), `putDurably` (:147), `removeStored` (:202), `ownShowcaseImages` (:295); used by `generate-image:31-32`, `generate-free:18`, `x402/generate:70`, `prompt:11` |
| Multi-store durability chain (never lose a paid image) | Done | `derivative-store.ts:99-130` — Blob first, Supabase `generations` bucket fallback (Kev 2026-10-06: "bild upload darf nicht failen", migration 2026-10-06-generations-bucket.sql) |
| Reference image storage | Done, wrong keys | `lib/generation/reference-images.ts:65` — key `references/${userId}/${contentHash}.${ext}` (userId in the key; Blob only) |
| Gallery upload storage | Done, wrong keys | `app/api/gallery/upload/route.ts:69,90` — direct Blob `put`, key `gallery/${userId}/...` |
| **R2 as the store for everything new** | **Remaining** | No R2 code exists (`grep -i r2` → nothing); Kev decided 2026-09-24: "Cloudflare R2 ... Public bucket with unguessable keys and no listing = unlisted ... Vercel Blob stays for nothing new" (`tasks/REC-8.md` comment 3) |
| **Unguessable keys (no user id / prompt id in key)** | **Remaining** | Current keys embed userId: `generations/${userId}/...` (derivative-store.ts:246), `showcase/${userId}/...` (:304), `references/${userId}/...` (reference-images.ts:65), `gallery/${userId}/...` (gallery/upload:66) |
| No listing / crawlers never find private objects | Remaining (verify + key policy) | Public read paths must keep embedding private URLs only behind session/visibility rules; storage side = unguessable keys + no bucket listing |
| Object migration plan for existing objects | **Remaining (plan only)** | Nothing written yet |
| R2 env var names in `.env.example` | **Remaining** | Names only; values never set by an agent |
| db-health cron marker | Out of scope | `app/api/cron/db-health/route.ts:52` — infra marker (text/plain), not user content; stays on Blob |

Upload-site inventory (re-counted against main @ 470739a on 2026-10-11; the
ticket's "six put() calls" predates the helper refactor):
1. `lib/generation/derivative-store.ts:56` (`putBlob`, single-shot path)
2. `lib/generation/derivative-store.ts:105` (`stores()` Blob entry, durable path)
3. `lib/generation/reference-images.ts:65`
4. `app/api/gallery/upload/route.ts:69` (original)
5. `app/api/gallery/upload/route.ts:90` (`putDerivative`)
6. `app/api/cron/db-health/route.ts:52` — NOT user content, stays
(The Supabase fallback bucket at derivative-store.ts:117-121 is a store inside
the chain, not a separate site; it is part of the new chain too.)

## Problem

Every image Enki stores lands on a public store under a key containing the
owner's user id, with a timestamp + 36^9 random suffix. The user id is known
across the app (profile URLs, API responses), so the key space per user is
shrinkable and the storage story contradicts the decided policy: private
images must be unlisted — reachable only by an unguessable link, never
indexed, never enumerable.

## Scope

In scope: R2 as the store for ALL NEW writes (originals + WebP derivatives +
references + gallery uploads + showcases); unguessable key policy at every
site; one helper owning the R2/ fallback chain; `removeStored`/`inOurBlob`
taught to recognize R2 URLs; env var names in `.env.example`; migration plan
documented (NOT executed).
Out of scope: migrating existing objects (plan only), db-health marker,
sitemap/X-Robots-Tag route headers (adjacent SHR-1 territory — noted in
"Found on the way"), deleting Blob usage for OLD objects (Blob keeps serving
what it already holds; `inOurBlob` stays true for it), Supabase fallback
bucket removal (it is the durability net; see Decisions).

## Decisions

Binding:
- Kev 2026-09-24 (`tasks/REC-8.md` comment 3, also §5): Cloudflare R2, public
  bucket, unguessable keys, no listing = unlisted; Blob stays for nothing new.
- Kev 2026-10-06 (derivative-store.ts:81-87,136): an image that was made must
  be delivered — storage failure never costs a paid image. This postdates the
  R2 decision and governs the failure mode.
Engineering synthesis (ours, flagged for review):
- New write chain: R2 FIRST, then the existing Supabase `generations` fallback
  bucket; Blob drops out of the new-write chain (nothing new on Blob) but old
  Blob objects keep working and stay removable. This honors both decisions.
- Key policy:
  - generations/showcase/gallery originals + derivatives:
    `<prefix>/<random 32 hex>.<ext>` (+ `.preview.webp`/`.thumb.webp` derived
    from the same base) — no userId, no timestamp, no prompt id.
  - references: `references/<sha256(bytes)>.<ext>` — the content hash IS the
    dedupe (Kev's stated purpose, reference-images.ts:11-13) and is itself
    unguessable; the `${userId}/` segment is dropped.
- Helper shape: keep `derivative-store.ts` as the module; add a `stores()` R2
  entry (first) + a shared `randomObjectKey(prefix, ext)`; move
  `reference-images.ts` and `gallery/upload`'s two direct `put()`s onto the
  same helpers (gallery keeps its own del-cleanup semantics via
  `removeStored`-equivalent R2 path).
- R2 access via `@aws-sdk/client-s3` (S3 API, public bucket, no presigner).
  New direct dependency — `npm install --package-lock-only` per rule 4A.1.

## Contract

Env var names (values are human steps; document in `.env.example`, never
commit values):
- `R2_ACCOUNT_ID` — endpoint `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
- `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` — S3 API token for the bucket
- `R2_BUCKET` — the public-unlisted bucket name
- `R2_PUBLIC_BASE_URL` — the bucket's public hostname (custom domain or
  r2.dev); stored URLs are `${R2_PUBLIC_BASE_URL}/<key>`
Behaviour contract (unchanged for callers):
- `storeGeneratedImage` / `storeReferenceImages` / gallery upload return the
  same shapes; URLs are R2 when configured, with the same graceful
  passthrough when R2 env is unset (mirrors today's BLOB token behaviour,
  derivative-store.ts:15-18,239).
- `putDurably` semantics unchanged: bounded retries to the deadline, non-
  passing failures take a store out, null when nothing configured.
- `removeStored` removes from R2 + recognizes legacy Blob + Supabase bucket
  URLs (it must never leave a refused image at its URL).
- `inOurBlob` (rename or keep) recognizes R2 public URLs too — `keepableImage`
  and showcase dedupe depend on it.
Human steps (documented in PR body + spec, executed by Kev):
1. Create the R2 bucket (public access ON, listing OFF, CORS for the app
   origin), create the S3 API token, set the 5 env vars in Vercel Production +
   Preview, custom domain or r2.dev public hostname.
2. Read back: PUT a test object via the S3 API, GET it over the public URL,
   confirm LIST is refused.

## Acceptance criteria

- AC-1 With R2 env set, a paid generation's original + both derivatives land
  on R2 under keys matching `<32 hex>` with no userId/promptId/timestamp, and
  the row's URLs are the R2 public URLs.
- AC-2 With R2 unset, behaviour is exactly today's (Blob chain unchanged) —
  no regression for the current deployment.
- AC-3 R2 outage (non-passing 4xx) removes R2 from the chain and the Supabase
  fallback still delivers (no-fail decision holds); a passing failure (5xx/
  429/network) retries within the deadline.
- AC-4 A refused image's URL is taken down from R2 by `removeStored`
  (failures logged, never thrown).
- AC-5 Reference images store under `references/<sha256>.<ext>`; the same
  bytes across two generations produce ONE object (dedupe preserved) and no
  key contains a userId.
- AC-6 Gallery upload writes original + derivatives through the shared helper
  with random keys and keeps orphan cleanup on DB failure.
- AC-7 `inOurBlob`-equivalent recognizes R2 URLs (showcase `keepableImage`
  accepts an R2 URL of ours; foreign hosts still refused).
- AC-8 `.env.example` lists the 5 R2 names with comments; no secret value
  anywhere in the diff.
- AC-9 No existing object is moved or rewritten by this PR; the migration plan
  exists in this spec (below).

## Test plan

| AC | Test file | Test name (gist) | Type | Mocks |
|---|---|---|---|---|
| 1 | `lib/__tests__/r2-store.test.ts` | generation stores 3 objects to R2 with random keys | unit | mock `@aws-sdk/client-s3` (SendCommand capture), assert key shape |
| 2 | same | R2 unset → Blob chain as before (existing durable-store tests keep passing) | existing + unit | existing mocks |
| 3 | same | R2 4xx falls through to fallback bucket; 5xx retries | unit | same |
| 4 | same | removeStored deletes from R2 | unit | same |
| 5 | `lib/__tests__/reference-images-r2.test.ts` | content-hash key, no userId, dedupe | unit | same |
| 6 | `lib/__tests__/gallery-upload-session.test.ts` (extend) | upload uses helper + random keys | unit | existing pattern (gallery-upload-session.test.ts:31) |
| 7 | same | inOurBlob recognizes R2 host | unit | env stub |
| 8 | review | .env.example diff | review | — |
| 9 | review | diff contains no migration/backfill code | review | — |

## Rollout and rollback

Merge order: after PR #168 (REC-3) merges, rebase on origin/main, retarget
`--base main`. Deploy-time ordering: set the R2 env vars in Vercel BEFORE the
merge deploys (writes arm themselves only when env is present; unset = today's
behaviour, so a wrong order degrades gracefully).
Migration plan for existing objects (documented, NOT in this PR, separate
human-approved script later): enumerate Blob objects (age > 0), copy to R2
under a fresh random key, update the owning rows (generated_images
storage_url/preview_url/thumbnail_url, prompts.showcase_images /
showcase_before_images, prompt_showcase_images) in one transaction per batch,
then delete the Blob original only after the row read-back verifies; keep the
legacy `inOurBlob` recognition for any object deliberately left behind.
Rollback: revert PR; R2 env vars can stay set (no code reads them).
