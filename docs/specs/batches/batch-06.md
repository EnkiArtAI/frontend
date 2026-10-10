# Batch 06: CDP-1 + SOC-8

Baseline: main @ 470739a   PRs: #167 (CDP-1), #169 (SOC-8, stacked on #167)

## Done / Remaining
- #167 (CDP-1): SDK upgrade `^0.0.113`→`^0.0.127`, `@coinbase/cdp-sdk` promoted to a direct
  dependency (pinned exact `1.52.0`, not `^1.58.0` — see below), key export migrated fully
  to the secure iframe flow (deprecated `useExportSolanaAccount`/`exportSolanaAccount`
  removed), EVM address shown read-only. ESLint import ban kept enforced. CI green
  (coordinator-verified: build/lint/tests/typecheck all pass on both pushes).
- #169 (SOC-8): fully implemented, all 4 code ACs pass, CI green (coordinator-verified).
  `/auth/complete` correctly left out of `PUBLIC_PATHS` pending the separate KEV-SOC gate.

## Coordinator spot-check (not a required independent review — CDP-1/SOC-8 isn't a
money/funds path per 4B.4 — but verified directly given the version-pin claim's
complexity)
Confirmed via `gh pr diff 167`: the first attempt pinned `cdp-sdk@1.58.0`, which broke the
`next build --webpack` job with an unresolvable transitive import
(`@x402/evm/upto/client` etc., pulled in via `thirdweb` → `@base-org/account` →
`toEvmSmartAccount.js` → `signX402Payment.js` — nothing this app calls). The agent
diffed every cdp-sdk release 1.48.0→1.58.0 off the npm registry, found `signX402Payment`
first appears at 1.53.0, and pinned the exact last-clean version (`1.52.0`) rather than a
caret range (a caret would still resolve to 1.58.0 given `thirdweb`'s own `^1.0.0`).
Confirmed in the lockfile diff and CI run logs — this is a real regression caught and
fixed, not a shortcut.

## Decisions needed from the human
1. **CDP-1 Decision 1 — attach-wallet pre-claim verification.** Option a: verify the
   claimed address against CDP server-side (end-user lookup by `sub`) before writing —
   closes the gap before #150's collision check fires, at the cost of a CDP API round
   trip on every attach. Option b: keep the existing collision-only check, add a
   detection/alert cron instead. **Agent's recommendation: option a** — the credential
   plumbing already exists (`@coinbase/cdp-sdk` is now a direct dependency, already used
   for `generateJwt`). Full writeup: `docs/specs/CDP-1.md` on branch `feat/cdp-1-upgrade-wallet`.
2. **CDP-1 Decision 2 — recovery-file feature.** Option a: rewrite around the iframe
   (user copies via CDP's button, pastes into Enki's passphrase field, format-checked).
   Option b: drop the custom file, point users at the iframe export as the sole backup
   story. **Agent's recommendation: option a**, because the existing shipped copy already
   promises "even if Enki disappears entirely" — a stronger claim than option b supports.
   Also flagged, not investigated: CDP 0.0.127 added a distinct "eject" action on the same
   iframe hook (full custody exit, not just copy) that may be closer to what "recovery"
   actually means than a clipboard copy — docs.cdp.coinbase.com was unreachable this
   session to check further.
3. Both decisions are written up in full in `docs/specs/CDP-1.md`; neither was implemented
   (correctly — these are product/security calls, not engineering ones).

## Found on the way (not fixed)
- `docs/specs/CDP-1.md` / the ticket references a `DEC-01` doc that doesn't exist
  anywhere in the repo under that name — flagged, not actionable without more context.

## Human steps needed
- Register every Vercel preview domain in the CDP dashboard allowlist (pre-existing,
  unrelated to this change, just restated as a reminder).
