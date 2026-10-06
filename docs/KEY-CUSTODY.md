# Key custody

Which server secrets Enki cannot lose or leak, what each protects, and how to
replace one. **Names only.** No value, no prefix and no length belongs in
this file, in a ticket or in a chat. To check that a key is set, test it:
`[ -n "$FIELD_ENCRYPTION_KEY_B64" ] && echo set`.

## Where they live (Kev fills in)

| | |
|---|---|
| Production values | Vercel project env, Production scope |
| Preview values | _which keys Preview has, and whether they differ from Production_ |
| Who can read them | _people with access to the Vercel project's env_ |
| Backup | _where the offline copy lives (password manager entry name, second location)_ |
| Last checked | _date_ |

A key that exists only in Vercel is one lost project away from being gone.
Keep an offline copy of every key marked **irreplaceable** below.

## The keys

### `FIELD_ENCRYPTION_KEY_B64` — irreplaceable

AES-256-GCM key for everything encrypted at rest (`lib/crypto.ts`, key id
`field-v1`):

- prompt bodies: `prompts.encrypted_content*`
- generation records: `generations.final_prompt_*`, `effective_prompt_*`,
  `variable_values_*`, `workflow_text_*`, and the prompt in
  `generation_failures`
- admin notification addresses (`admin_prefs.notify_email_*`) and feedback
  addresses
- guardian recovery secrets (`recovery/guardians`)
- moderation evidence (`lib/moderation/evidence.ts`)
- held payment transactions (`lib/payments/authorization.ts`)

**Lost:** none of the above can ever be read again. Paid prompts stop
generating, because the server decrypts the body for every paid render.
There is no recovery path.
**Leaked together with a database dump:** all of it is readable.

`FIELD_ENCRYPTION_KEYS_RETIRED` (`kid:base64,kid:base64`) holds earlier keys
for decryption only. `PROMPT_ENCRYPTION_KEY` is the pre-merge prompt key
(`prompt-legacy`), needed only while rows written with it exist.

### `AUTH_PEPPER` — irreplaceable, never rotated

Seasons password hashes (`lib/password-auth.ts`), derives the step-up token
key (`lib/webauthn.ts`) and salts the IP hashes that network bans match on
(`lib/ip-hash.ts`).

**Lost or changed:** every password stops working, every IP ban stops
matching, open step-up tokens die. It cannot be rotated by design.
**Leaked together with a database dump:** passwords can be attacked offline
(Argon2id still slows that down), and IP hashes can be reversed.

### `WALLET_JWT_PRIVATE_KEY` — replaceable, the most dangerous leak

Signs the JWT that tells CDP which user is signed in (`lib/wallet-jwt.ts`,
`sub` = `users.id`); CDP checks it against `/api/auth/wallet/jwks`.

**Leaked:** whoever holds it can mint a JWT for any `sub` and sign with that
user's embedded wallet. Replace it at once.
**Lost:** replaceable. CDP wallets follow the `sub`, not the key, so a new
key serves the same wallets once the JWKS shows it.
**Replace:** generate with `scripts/gen-wallet-jwt-key.mjs`, set it in
Vercel, redeploy. The JWKS route publishes the new public key by itself.

### Also on the money path, covered elsewhere

`SOLANA_FEE_PAYER_SECRET_KEY` (pays fees, fronts token accounts, holds a SOL
float only) and `SOLANA_TREASURY_SECRET_KEY`. Losing either loses its
balance; a leak lets someone spend it. Keep the float small.

## Rotating `FIELD_ENCRYPTION_KEY_B64` (after a leak)

Rotation needs a code change as well as an env change. The key id written
into new rows is the constant `CURRENT_KID` in `lib/crypto.ts`, not an env
value.

1. Generate a new key: 32 random bytes, base64.
2. In `lib/crypto.ts`, change `CURRENT_KID` to the next id (`field-v2`).
3. In Vercel, put the old key in front of `FIELD_ENCRYPTION_KEYS_RETIRED`
   as `field-v1:<old key>`, and the new key in `FIELD_ENCRYPTION_KEY_B64`.
4. Deploy the code change and the env change together. Old rows open with
   `field-v1`, new rows are written with `field-v2`.

If step 2 is skipped, new rows are also labelled `field-v1`. They still open,
because decryption tries every key with a matching id, but the old key can
then never be dropped from the ring.

A rotation protects only what is written after it. Rows encrypted with the
leaked key stay readable to whoever holds it until they are re-encrypted,
and no re-encryption job exists yet.
