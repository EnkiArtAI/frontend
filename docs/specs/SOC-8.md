# SOC-8 · After the whitelist stage every self registered user is walled out (BetaGate roles)
Source: https://app.clickup.com/t/86cbk4fge
Status: Implemented (code change); the `/auth/complete` PUBLIC_PATHS sub-item is explicitly skipped

## Problem

Re-verified against `main`/`ci/setup` (2026-10-09), independent of the coordinator's evidence,
which it confirms:

- `components/BetaGate.tsx:21` (pre-change): `const BETA_ROLES = new Set(["beta", "mod", "admin"]);`
  Line ~175's check `if (BETA_ROLES.has(data.role ?? "user")) setAccess("ok"); else void
  teamFallback();` admits a session only by role — a plain `role: "user"` account (what
  `app/api/auth/password/register/route.ts:78`'s `.insert({ account_status: "active" })` produces,
  no `role` column set, so it reads back as `null` → `"user"` via the `?? "user"` fallback) never
  passes, whitelist stage or not.
- `lib/allowlist.ts:16-18`'s `whitelistStageActive()` is exactly `!!process.env.TEAM_ACCESS_CODE` —
  the flag the rest of the auth stack (`password-login.ts`, `session/route.ts`,
  `password/register/route.ts`) already branches on to decide whether the allowlist gate applies at
  all. `BetaGate.tsx` has no access to this flag today: it is a server-env check, and the component
  is `"use client"`.
- `app/api/users/handle/route.ts` (the identity check `BetaGate` calls) already separates "banned"
  from everything else: a session with an active ban gets `403 { banned: true }` **before** role is
  ever read (`revokeGateCookie` + redirect to `/banned`, line ~30) — this path is untouched by this
  change and still runs first.
- "Deleted" is handled one level up, not in `BetaGate.tsx` at all:
  `app/api/account/delete/route.ts`'s `softDelete()` (lines 25-38) stamps `deleted_at` +
  `account_status: 'deleted'` **and deletes every `auth_sessions` row for that user** (its own
  wallet addresses). So a deleted account's session token stops resolving at all —
  `resolveSessionUserWithBan` (`lib/session-user.ts`) returns `{ userId: null }`, and
  `/api/users/handle` answers `401 "Not signed in"`, which `BetaGate.tsx` already routes to
  `teamFallback()` with no account-admit path (before this change or after). Confirmed by reading
  `lib/hidden-owners.ts`/`lib/session-user.ts` read-only, as instructed — neither file is touched.
  The one gap this doesn't cover (a session token issued in the narrow window before a delete
  propagates) is pre-existing and outside this ticket's scope.
- `/api/gate` (`app/api/gate/route.ts`) is the endpoint `BetaGate.tsx`'s `teamFallback()` already
  calls for the team-cookie check. It has no field today saying whether the whitelist stage is
  active or ended — `GET` returns `{ team: false }` identically whether `TEAM_ACCESS_CODE` is unset
  **or** set-but-no-valid-cookie, so the client cannot currently tell "stage over" from "stage
  active, no cookie" from this response alone. This is the one piece of new server-exposed state
  this change needs.
- `proxy.ts`'s `PUBLIC_PATHS`-equivalent (`isPublic()`) does not currently special-case
  `/auth/complete` — but per the coordinator's explicit instruction, adding it is **skipped**: it
  only matters if social login (SOC's OAuth work, branch `be/SOC-oauth`, unmerged, per the parent
  `SOC.md` comments) ships, which is a separate, currently-parked decision (KEV-SOC) that does not
  block this ticket. `proxy.ts` is also not a file I'm allowed to touch this wave regardless (owned
  by the SOC wave). Flagged for whichever agent picks up SOC-7/the OAuth merge.

## Scope

**In scope (this PR, stacked on CDP-1's branch):**
- `components/BetaGate.tsx`: once the whitelist stage has ended (`TEAM_ACCESS_CODE` unset), admit
  every signed-in, non-banned account regardless of `role`. During the stage, behavior is
  byte-for-byte unchanged (role check first, team-cookie fallback second).
- `app/api/gate/route.ts`: add a `whitelistActive: boolean` field to the existing `GET` response,
  computed via `lib/allowlist.ts`'s already-exported `whitelistStageActive()` (no new logic,
  reusing the one flag the rest of the auth stack already treats as the source of truth). This is
  the one way to get the server-only env check in front of the client wall's decision. Touched
  outside my named-file ownership (only `components/BetaGate.tsx` was explicitly granted this
  wave) because the ticket's behavior is server-env-dependent and the client literally cannot
  decide it without *some* server round trip telling it the stage has ended; `/api/gate` is the
  existing, already-called, zero-auth endpoint whose whole purpose is exactly this kind of gate
  status, making it the lowest-collision-risk place for a one-field, additive, backward-compatible
  change. Flagged here for the coordinator in case another agent is also mid-edit on this file.

**Out of scope (explicitly, per the coordinator's brief):**
- `proxy.ts` — not touched (owned by the SOC/OAuth wave); the `/auth/complete` PUBLIC_PATHS
  addition is skipped entirely and left as a note for whichever agent resumes SOC once KEV-SOC
  (keep-or-park social login) is decided.
- `lib/hidden-owners.ts`, `lib/session-user.ts` — read-only, to understand how "active" is
  determined; not modified.
- The rest of SOC (SOC-1 through SOC-7, the OAuth backend on `be/SOC-oauth`) — a separate wave,
  blocked on KEV-SOC, unrelated to this specific role-gate fix.

## Decisions

None open for this ticket — Kev's 2026-09-24 ruling ("admit every active account once the stage is
over... during the stage the allowlist rules stay") is binding and implemented as given. The only
design choice made here (not a decision gate, just an implementation detail worth recording): where
to surface `whitelistStageActive()` to the client. Chose `/api/gate`'s existing `GET` over adding
the field to `/api/users/handle`'s response, because:
- `/api/gate` is already the single-purpose "is the team gate open for me" endpoint `BetaGate.tsx`
  calls specifically for this kind of decision (today just the team-cookie half of it); it is
  unauthenticated (no session needed), matching the fact that "has the stage ended" is a pure
  server-config fact, not a per-user one.
- `/api/users/handle` is a general identity/profile endpoint reused by several unrelated features
  (the recovery-file id lookup, admin-section visibility, profile header); growing its response
  for a config flag that has nothing to do with a specific user felt like the wrong file to widen.

## Contract

- `GET /api/gate` response gains one field: `{ team: boolean, whitelistActive: boolean }` (was
  `{ team: boolean }`). Additive — any existing caller destructuring only `team` is unaffected.
- `components/BetaGate.tsx` exports a new pure function:
  `admitsOnceWhitelistEnded(activeAccount: boolean, whitelistActive: boolean): boolean` — returns
  `activeAccount && !whitelistActive`. Used internally by `teamFallback`, exported for direct unit
  testing (this repo's tests don't render client components, so a pure decision function is the
  only way to get a real behavioral assertion rather than a source-regex one).
- `teamFallback`'s signature changes from `() => Promise<void>` to
  `(activeAccount?: boolean) => Promise<void>` (default `false` — unchanged behavior at the two
  existing call sites that don't pass it). Internal only, not exported.

## Acceptance criteria

1. **Given** `TEAM_ACCESS_CODE` is unset (whitelist stage ended) **and** a signed-in, non-banned
   account whose `role` is `"user"`, **when** `BetaGate` resolves the identity check, **then**
   access is `"ok"`. — **Pass.** (`admitsOnceWhitelistEnded(true, false) === true`, and the wiring
   test confirms `teamFallback(true)` is the call made from the role-mismatch branch.)
2. **Given** a banned or deleted account, **when** the same flow runs, regardless of
   `TEAM_ACCESS_CODE`, **then** access is never granted via this change. — **Pass.** A banned
   account never reaches the role check at all (the existing 403 branch fires first, unchanged); a
   deleted account's session no longer resolves (`401`), which calls `teamFallback()` with
   `activeAccount` defaulted to `false` — `admitsOnceWhitelistEnded(false, anything) === false`
   always. Both are pre-existing branches this PR does not touch, re-confirmed by the mutation
   check below.
3. **Given** `TEAM_ACCESS_CODE` is set (whitelist stage active), **when** a `role: "user"` account
   without the team cookie resolves, **then** access is `"denied"`, unchanged from before this PR.
   — **Pass.** (`admitsOnceWhitelistEnded(true, true) === false`; `GET /api/gate` returns
   `whitelistActive: true` while the code is set, verified behaviorally.)
4. **Given** `TEAM_ACCESS_CODE` is set and a valid team cookie is presented, **when** `GET
   /api/gate` is called, **then** the response is `{ team: true, whitelistActive: true }` —
   unchanged `team` semantics, `whitelistActive` additive. — **Pass.**
5. `/auth/complete` added to `PUBLIC_PATHS` — **Pending human / explicitly skipped**, see Scope.

## Test plan

- `lib/__tests__/gate-whitelist-status.test.ts` (new): behavioral tests against the real `GET
  /api/gate` handler for all three states (`TEAM_ACCESS_CODE` unset; set, no cookie; set, valid
  cookie), proving AC 3 and 4 directly against the route, not a mock of it.
- `lib/__tests__/beta-gate-whitelist-admit.test.ts` (new): real unit tests of the exported pure
  `admitsOnceWhitelistEnded` (AC 1, 2, 3 as pure boolean-table assertions — no DOM, no mocking),
  plus source-regex wiring checks (this repo's established pattern for client-component logic the
  test suite can't render) proving: the role-mismatch branch calls `teamFallback(true)`, the two
  pre-existing call sites (signed-out, non-ok fetch) still call `teamFallback()` with no argument,
  and the banned-account 403 branch (AC 2's first half) is textually unchanged.
- Existing `lib/__tests__/banned-door.test.ts` and `lib/__tests__/beta-gate-recheck.test.ts` are
  not modified and must stay green — they guard the ban-redirect and re-check-on-storage-event
  behavior this PR must not regress.

## Rollout and rollback

- No migration, no env var changes required to ship; behavior only changes in production once
  `TEAM_ACCESS_CODE` is actually unset there (the human step of ending the whitelist stage),
  unrelated to this PR's deploy.
- Rollback: revert the commit. `GET /api/gate` dropping the `whitelistActive` field is backward
  compatible in the other direction too (an older `BetaGate.tsx` build simply never reads it).
