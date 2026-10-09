# CDP-1 · Bring the CDP integration up to date: SDK, export iframe, direct dependency, EVM address
Source: https://app.clickup.com/t/86cbk4fwj
Status: Partially implemented — two items decision-gated on Kev (not picked here)

## Done / Remaining

| Item (from the ticket's "Done when") | Status |
|---|---|
| #150 — refuse an address another account already owns | Done before this change (verified in `app/api/auth/session/attach-wallet/route.ts:96-109`); **not touched** |
| SDK upgraded, typecheck clean, eslint import ban still enforced | Done this change (`^0.0.113` → `^0.0.127` for both packages) |
| `@coinbase/cdp-sdk` is a direct dependency | Done this change (`^1.58.0`, was transitive via `thirdweb` at resolved `1.48.0`) |
| Export goes through the iframe flow | Done this change (`useSolanaKeyExportIframe`, portal-based) |
| Deprecated `useExportSolanaAccount`/`exportSolanaAccount` removed entirely | Done this change |
| EVM address exposed in the wallet UI (read only) | Done this change (`BillingPanel.tsx`) |
| attach-wallet verifies addresses server side (pre-claim TODO, attach-wallet:16-18) | **Not implemented — decision gate, see below.** Out of my file ownership this wave (backend route, not wallet UI) regardless. |
| Recovery file rewritten around the iframe, or replaced by CDP's own export | **Not implemented — decision gate, see below.** |
| Backend engineer reviewed the seed/key-manager note in DEC-01 | No `DEC-01` doc found in the repo (`find -iname "DEC-01*"` empty) — flagged below, not actionable here. |
| Every Vercel preview domain in the CDP allowlist | Human step, see Rollout. |

## Problem

Re-verified against `main`/`ci/setup` on this machine (2026-10-09), independent of the coordinator's
2026-10-08 evidence, which it confirms:

- `package.json` pinned `@coinbase/cdp-core`/`@coinbase/cdp-hooks` at `^0.0.113`; npm registry's
  `dist-tags.latest` is `0.0.127` (14 releases behind, not 13 — one shipped since the 2026-09-23
  note).
- `@coinbase/cdp-sdk` had no direct `package.json` line. `package-lock.json:518-520` resolves it
  transitively through `thirdweb` (`^1.0.0`) at `1.48.0`; npm's latest is `1.58.0`.
- `components/CdpWalletBridge.tsx:5` imported `exportSolanaAccount` from `@coinbase/cdp-core` and
  `:153` destructured `privateKey` straight out of it inside the `CDP_EXPORT_REQUEST` window-event
  handler — the deprecated direct-export path, confirmed deprecated **even at the pinned 0.0.113**
  (its own shipped `.d.ts` already carries `@deprecated Use useSolanaKeyExportIframe instead`; this
  is not a 0.0.127-only change). Two callers relied on the raw string it produced:
  `components/settings/KeyExport.tsx` (shows it once in a dialog) and
  `components/settings/RecoveryPanel.tsx`'s "recovery file" feature (encrypts it into a downloadable
  file via `lib/recovery-file.ts`).
- Diffed the shipped type definitions for `@coinbase/cdp-core` and `@coinbase/cdp-hooks` between
  `0.0.113` and `0.0.127` (downloaded both tarballs from the npm registry, no changelog file is
  bundled in either package) to find real breaking changes rather than guessing from the version
  gap:
  - `Config` (`ethereum.createOnLogin`, `solana.createOnLogin`, `customAuth.getJwt`) — unchanged.
  - `authenticateWithJWT`, `getCurrentUser` (gained an optional `GetCurrentUserOptions` — additive),
    `getCurrentUserSync`, `isSignedIn`, `signOut`, `signSolanaTransaction` — unchanged signatures.
  - `User.evmAccountObjects` / `User.solanaAccountObjects` (what `CdpWalletBridge.tsx` reads
    everywhere) — unchanged shape, still present alongside the already-deprecated flat
    `evmAccounts`/`solanaAccounts` arrays.
  - `useSolanaKeyExportIframe` / `useEvmKeyExportIframe` — **already present at 0.0.113**, not new
    in 0.0.127. `0.0.127` adds optional `action: "copy" | "eject"` plus `ejectLabel`/`ejectingLabel`/
    `ejectedLabel`/`ejectIcon`/`fullWidth`/`revealEject` to `UseKeyExportIframeOptions`/Result — a
    genuinely new "eject the wallet out of CDP custody" capability, additive, not used here (see
    Decisions).
  - Net: **no breaking changes found** for anything this codebase calls. The version bump is safe
    as a pure upgrade; the export-iframe migration would have been possible even on `0.0.113` and is
    bundled into this same change only because the ticket groups them.
- `lib/cdp-bridge.ts` is a plain module-store + window-event bridge (no CDP import) that lets
  code outside the lazily-mounted `CDPHooksProvider` tree reach the wallet (`useCdpAddress`,
  `useCdpSolanaSigner`, `KeyExport`, `RecoveryPanel`) without importing `@coinbase/cdp-hooks`
  directly — `eslint.config.mjs`'s `no-restricted-imports` rule bans that import outside
  `providers/CdpProvider.tsx`/`components/CdpWalletBridge.tsx` specifically so a hook call outside
  the provider can't throw and take a page down. This boundary is why the export-iframe hook call
  has to live inside `CdpWalletBridge.tsx` and reach the Settings dialog via a React portal, not by
  calling the hook from `KeyExport.tsx` directly.

## Scope

**In scope (this PR):**
- `package.json` / `package-lock.json`: `@coinbase/cdp-core`/`@coinbase/cdp-hooks` `^0.0.113` →
  `^0.0.127`; add `@coinbase/cdp-sdk: ^1.58.0` as a direct dependency (was transitive-only).
  Lockfile regenerated with `npm install --package-lock-only` (no `node_modules` install, no build).
- `lib/cdp-bridge.ts`: remove `CDP_EXPORT_REQUEST`/`CDP_EXPORT_RESULT`/`requestCdpKeyExport` (the
  raw-private-key-over-a-promise path). Add a small container-registration + status-relay pair
  (`setExportIframeContainer`/`getExportIframeContainer`, `setExportIframeStatus`/
  `getExportIframeStatus`, `CDP_EXPORT_IFRAME_EVENT`) so a caller outside the provider can hand the
  bridge a DOM node to portal CDP's own export button into, and read back its status without ever
  seeing a key. Add `setCdpEvmAddress`/`getCdpEvmAddress` (same pattern as the existing Solana
  address store) for the EVM-address UI item.
- `components/CdpWalletBridge.tsx`: remove the `exportSolanaAccount` import and its window-event
  handler entirely. Add: (a) an effect publishing the signed-in account's EVM address to the bridge
  whenever `mine` changes; (b) a portal (`react-dom`'s `createPortal`) that, once both an export
  container is registered and this mount has signed in, renders a small internal
  `ExportIframeHost` component calling `useSolanaKeyExportIframe({ address, containerRef })` and
  relaying `status`/`message` back through the bridge. The hook call stays inside this file (inside
  `CDPHooksProvider`, satisfying the eslint boundary); the portal makes the actual button appear
  wherever the caller's container lives in the DOM, regardless of React-tree position.
- `hooks/useCdpAddress.ts`: also return `evmAddress` (same event, same store pattern as `address`).
  Additive — every existing destructuring `{ address }` call site is unaffected.
- `components/settings/KeyExport.tsx`: replace the "fetch the key, show it in our own `<code>`
  block with a Copy button" dialog with a container `<div>` that registers itself with the bridge
  while the dialog is open; CDP's own iframe button renders into it and copies the key to the
  clipboard **without the key ever reaching this component's JS**. Second-factor gating via
  `useStepUp().confirm("export")` and the `ensureCdpWallet()` lock check both stay, run before the
  dialog opens (previously the lock check ran inside `requestCdpKeyExport`; it moves to the caller
  since that function is gone).
- `components/settings/BillingPanel.tsx`: show the EVM address, read-only, directly under the
  Solana "Your wallet address" row, labelled informational — no copy/QR actions, since CDP wallets
  here are Solana-primary and this is purely the multichain starting point the ticket asks for.
- `components/settings/RecoveryPanel.tsx`: the "Recovery file" section (`## 03`) no longer has a
  way to get the raw key into the browser's JS at all (that was `requestCdpKeyExport`, now
  removed), so `buildRecoveryFile`'s only caller is gone. Rather than leave dead code calling a
  function that no longer exists, or quietly pick one of the two rebuild options for Kev, this PR
  **pauses** that one section: the UI explains the file is temporarily unavailable pending the
  decision below, and links nowhere (no dead button). Passkeys and Guardians (the rest of the
  panel) are untouched. `lib/recovery-file.ts` itself (the pure encrypt/decrypt/download functions)
  is untouched and still covered by its own tests — only its UI caller is paused.
- Tests for all of the above (see Test plan).

**Out of scope (this PR):**
- `app/api/auth/session/attach-wallet/route.ts` — not a wallet-UI file (my ownership this wave is
  `CdpWalletBridge.tsx` and related wallet **components**, not this API route), and the one change
  it would need (the pre-claim verification TODO) is an explicit decision gate below. Read, not
  edited.
- Deciding the recovery-file rebuild, or the pre-claim verification option — both written up below,
  neither picked.
- Registering Vercel preview domains in the CDP dashboard allowlist — human/console step, not code.
- `DEC-01` — no such document exists in this repo under any name I could find; flagged, not acted
  on (the ticket's "Done when" item asking for a backend-engineer review of it can't be satisfied
  from here).

## Decisions

### Decision 1 — attach-wallet pre-claim verification (option a vs b)
`app/api/auth/session/attach-wallet/route.ts:16-18` (HARDENING TODO, unchanged by this PR):
> verify the address against CDP server-side (`@coinbase/cdp-sdk` end-user lookup by `sub`) so
> nobody can pre-claim an address that no account owns yet.

The route already refuses an address **another existing account** owns (`#150`, the `ilike` +
owner check at lines 99-109). What it cannot yet catch: someone submitting a syntactically valid
Solana address that is nobody's CDP wallet yet (or is a different CDP user's wallet that has never
logged in here, so no `user_wallets` row exists for it), pre-claiming it into `user_wallets` for
their own `users.id` before the real owner ever attaches. Since CDP wallets are deterministic per
JWT `sub`, the real owner's own attach would later collide with `#150`'s existing-owner check
(caught), but the pre-claimer has, in the meantime, pointed their *own* session at an address they
don't control the key for — `/api/auth/wallet/jwt` mints a CDP login keyed to the caller's own
`sub`, not the pre-claimed address's `sub`, so no wallet action actually succeeds for the attacker.
The real exposure is narrower: can a second account's `attach-wallet` call cause ours to display an
address that isn't really "ours" for long enough to mislead a depositor (wrong-address payment)
before `#150`'s collision check fires. Two ways to close the gap, as the TODO itself names:

- **Option a — verify via `@coinbase/cdp-sdk`'s end-user lookup by `sub` before writing.** Given the
  session's own `sub` (= `users.id`), call CDP server-side to fetch *that* `sub`'s actual
  provisioned Solana/EVM addresses and refuse the write unless the client-submitted address matches
  what CDP itself says this `sub` owns. Strongest guarantee — the address is proven, not merely
  "nobody else has claimed it yet" — but adds a CDP API round trip (with its own latency/outage
  mode) to every attach, and needs the CDP server SDK wired up with its own API key pair
  server-side (`@coinbase/cdp-sdk`, now a direct dependency after this PR, already used for
  `generateJwt` in `app/api/onramp/session/route.ts`, so the credential plumbing exists).
- **Option b — keep the existing owner-collision check as the only guard, tightened.** Accept that
  a pre-claimed-but-unverified address is a narrow, self-correcting race (the real owner's own
  first attach fails loudly with "This wallet belongs to another account" instead of silently
  losing the slot), and spend the effort instead on detecting/alerting on the race (e.g. a cron or
  admin report of `user_wallets` rows whose `address` has never matched any `auth_sessions` wallet
  JWT for that same user — i.e., an attached address this account has never actually signed with).
  Cheaper, ships now, weaker guarantee.

**Recommendation: option a**, gated behind the same "is CDP configured" check `onramp/session`
already uses (`CDP_API_KEY_ID`/`CDP_SECRET_KEY`), falling back to option b's collision-only
behavior (today's behavior, unchanged) when CDP server credentials aren't configured — so local dev
and any environment without CDP server keys doesn't newly break. The deposit-UI risk (wrong address
shown to a depositor) is worse than an extra ~100-300ms round trip on a rare call (attach runs once
per login, not per request). Not implemented here: it's a backend-route change, outside this PR's
file ownership, and Kev should pick before whoever owns `attach-wallet/route.ts` builds it.

### Decision 2 — recovery file: rewrite around the iframe, or replace with CDP's own export
The "recovery file" (`RecoveryPanel.tsx` `## 03`, `lib/recovery-file.ts`) is a passphrase-encrypted,
downloadable file holding the raw Solana private key, built and verified entirely client-side, with
its own round-trip self-check before the download starts. It existed because
`requestCdpKeyExport()` could hand JS the raw key string. The iframe export hooks are built
specifically so **JS never sees that string again** — CDP's own button copies straight to the
clipboard inside its iframe. That is a hard constraint, not a style choice: there is no supported
way to get the raw key back into our own encryption code post-migration.

- **Option a — rewrite around the iframe (user pastes).** Keep the feature's shape: the user clicks
  CDP's "Copy private key" button (rendered in our container), then pastes the clipboard contents
  into a password-type field in our own UI; we never read the clipboard programmatically (that
  needs its own permission prompt and is one more thing that can silently fail), the user's own
  paste action is the only way the key crosses into our JS. From there `buildRecoveryFile`/
  `openRecoveryFile` work unchanged. Keeps the offline, Enki-independent backup story Kev evidently
  wanted (RecoveryPanel's own copy: "even if Enki disappears entirely"). Costs: one extra manual
  step (copy, then paste) the user can get wrong (paste something else, or paste the EVM key by
  mistake once that iframe exists too), and we'd want a format check (does it look like a base58
  32-byte Solana secret key) before accepting the paste so a bad paste fails loudly instead of
  producing a file that silently can't be restored.
- **Option b — replace with CDP's own export, drop the custom file.** Point users at the Settings
  "Export" button (this PR's new iframe-based `KeyExport.tsx`) as the one backup story, and remove
  the recovery-file feature (and `lib/recovery-file.ts`) outright. Simpler, nothing to maintain, no
  paste-the-wrong-thing failure mode. Costs: loses the specific thing the recovery file added over
  plain export — a *passphrase-encrypted offline file* rather than a bare key the user must secure
  themselves (e.g. in a password manager), and loses the self-verifying round-trip check. Note for
  Kev: CDP's `0.0.127` also shipped an "eject" action on the same iframe hook (`action: "eject"`,
  `UseKeyExportIframeOptions`) — a second, distinct capability from copy-to-clipboard that appears
  to move the wallet fully out of CDP's TEE custody. Not investigated further here (no docs page
  loaded cleanly during this session — `docs.cdp.coinbase.com` reset the connection on every fetch
  attempt; the type definitions alone don't say what "ejected" changes server-side). If it means
  what the name implies, it may be a *third* option worth a look before deciding between a/b:
  "eject" could be the vendor's own answer to "get my key out for good," which is closer to a
  recovery story than plain copy-to-clipboard is.

**Recommendation: option a**, specifically because of the "even if Enki disappears entirely" framing
already in the shipped copy — that's a stronger promise than "copy your key once and store it
yourself," and the paste-validation safeguard (format check before accepting) closes most of the
added failure mode cheaply. But this is explicitly Kev's call per the coordinator's brief, not
picked here. **Not implemented in this PR**: `RecoveryPanel.tsx`'s file section is paused (see
Scope) rather than built either way, so nothing here forecloses either option.

## Contract

- `lib/cdp-bridge.ts` new exports: `CDP_EXPORT_IFRAME_EVENT: string`;
  `setExportIframeContainer(container: HTMLElement | null): void`;
  `getExportIframeContainer(): HTMLElement | null`;
  `setExportIframeStatus(status: string | null, message?: string): void`;
  `getExportIframeStatus(): { status: string | null; message?: string }`;
  `setCdpEvmAddress(addr: string | null): void`; `getCdpEvmAddress(): string | null`.
  Removed: `CDP_EXPORT_REQUEST`, `CDP_EXPORT_RESULT`, `requestCdpKeyExport`.
- `hooks/useCdpAddress.ts`: return type becomes `{ address: string | null; evmAddress: string | null }`
  (was `{ address: string | null }`) — additive.
- No API route contracts change in this PR.

## Acceptance criteria

1. **Given** the pinned versions, **when** `package.json` is read, **then** `@coinbase/cdp-core`
   and `@coinbase/cdp-hooks` are `^0.0.127` and `@coinbase/cdp-sdk` is a direct dependency at
   `^1.58.0`. — Pass (static read of `package.json`).
2. **Given** a signed-in CDP session, **when** `CdpWalletBridge` mounts and `mine` is set, **then**
   `getCdpEvmAddress()` reflects that account's EVM address, and clears on sign-out/unmount. — Pass
   (unit test with the existing fake-hooks runtime).
3. **Given** a caller registers a DOM node via `setExportIframeContainer`, **when** the bridge has a
   signed-in address, **then** it portals the export-iframe host there (address passed through
   correctly); **given** no address yet, **then** nothing is portaled. — Pass (unit test).
4. **Given** the whole repo, **when** grepped for `exportSolanaAccount` or `useExportSolanaAccount`
   outside `node_modules`, **then** there are zero matches. — Pass (static regression test).
5. **Given** a banned account, **when** it registers an export container, **then** the bridge still
   portals it (a ban never closes the wallet, including export) — unchanged from the prior
   behavior, re-asserted against the new mechanism. — Pass (unit test).
6. **Given** `eslint.config.mjs`, **when** read, **then** the `no-restricted-imports` ban on
   `@coinbase/cdp-hooks` outside `providers/CdpProvider.tsx` / `components/CdpWalletBridge.tsx` is
   unchanged. — Pass (static read; this PR does not touch the file).
7. attach-wallet pre-claim verification — **Pending human** (Decision 1, not implemented).
8. Recovery-file rebuild — **Pending human** (Decision 2, not implemented; paused in the meantime).
9. Vercel preview CDP allowlist — **Pending human** (console step, see Rollout).

## Test plan

- `lib/__tests__/cdp-wallet-bridge.test.ts` (existing, extended): replace the export-related cases
  that drove `requestCdpKeyExport()`/mocked `exportSolanaAccount` with equivalent-strength cases for
  the new container/portal mechanism and the EVM-address publish, including the banned-account case
  (AC 2, 3, 5). Everything else in that file (sign-in/sign-out races, lock/step-up gating, signing)
  is unchanged and must stay green — it is not part of this ticket.
- New `lib/__tests__/cdp-export-iframe-migration.test.ts`: repo-wide static grep for
  `exportSolanaAccount`/`useExportSolanaAccount` (AC 4) plus source-regex checks that
  `CdpWalletBridge.tsx` imports `useSolanaKeyExportIframe` from `@coinbase/cdp-hooks` and no longer
  imports `exportSolanaAccount` from `@coinbase/cdp-core`, and that `package.json` lists
  `@coinbase/cdp-sdk` directly (AC 1, 6).
- No test touches a real CDP endpoint, Vercel, or the live database — `useSolanaKeyExportIframe`
  itself is never invoked in tests (it would need a real iframe/browser); only the plumbing that
  decides *whether* to mount it is tested, same boundary the existing bridge tests already draw
  around `@coinbase/cdp-core`/`@coinbase/cdp-hooks`.

## Rollout and rollback

- Lockfile-only change for the version bumps (`npm install --package-lock-only`); no `node_modules`
  install or build run from this session per the task's hard rules — CI installs for real and is
  the first real build/typecheck this change gets.
- **Human step (required before this reaches a preview a human will actually click through):**
  every Vercel preview domain needs registering in the CDP dashboard's authorized-domain allowlist
  (max 50 entries) or the wallet stays silent on that preview — unchanged limitation from before
  this PR, just restated since the SDK bump doesn't touch it.
- Rollback: revert the version bump commit (no data migration, no server-side state) and the export
  UI reverts to the old dialog — except `requestCdpKeyExport`/`exportSolanaAccount` are gone, so a
  rollback of the UI commits without also reverting `lib/cdp-bridge.ts`/`CdpWalletBridge.tsx` would
  leave `KeyExport.tsx` calling a function that no longer exists. Revert the whole PR as one unit.
