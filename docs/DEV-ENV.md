# Developer environments

Rule one: **developers never receive production secrets.** Every developer
works against a separate dev environment whose keys can move no real money
and see no real user. What a developer gets is decided by their task, not by
copying one big file.

## The three tiers

| Tier | Who | Contains |
| --- | --- | --- |
| core | every developer | dev Supabase project, the environment's pepper and encryption key (shared through the vault), localhost URLs, devnet chain, optional mail and blob |
| generation | only who works on image generation | Gemini, OpenAI, WaveSpeed, xAI: one key per developer with a hard spend cap, revoked when the task ends |
| payments | only backend developers on wallet, payments or login | devnet fee payer, wallet JWT key, CDP dev project, Google and X dev OAuth clients |

Frontend tasks need only core. The free model (Pollinations) runs without any
provider key. Every route that needs a missing key must answer with a clear
sentence ("Google sign in is not configured") instead of a stack trace; where
it does not yet, that is a bug (ClickUp ENV-01).

## One time setup by Kev

1. Supabase: create the project `enki-dev`, run every file in `migrations/`
   against it (same order as production), seed nothing. Its URL, anon key and
   service role key are the only dashboard values a core developer needs.
2. Coinbase CDP: create the project `enki-dev`, register the JWKS URL of the
   developer's tunnel or leave the wallet off for developers who do not touch
   payments.
3. Google Cloud and X developer console: dev OAuth clients with the
   `http://localhost:3008/...` redirect URIs from `.env.example`.
4. Provider consoles: one key per generation developer, monthly budget set,
   revoked when the task ends.

## How a developer gets their file

Never by chat or mail. Two ways, pick one and keep it:

- **Vault (simple):** a shared Bitwarden or 1Password vault with one item per
  developer holding exactly their tier; remove the person from the vault when
  they leave.
- **Secrets manager (cleaner):** Infisical or Doppler, free for small teams:
  environments dev, preview, prod; permissions per person; audit log; the
  developer runs `infisical run -- npm run dev` and no key ever sits in a file
  on their disk. Removing the person removes the access.

The generator builds the file itself, so only the dashboard values travel:

```bash
node scripts/make-dev-env.mjs --tier core
node scripts/make-dev-env.mjs --tier generation
node scripts/make-dev-env.mjs --tier payments
```

It writes `.env.local` with per developer secrets generated locally (fee payer,
wallet JWT key), fixed dev values and `PASTE_FROM_DASHBOARD` markers for the
rest. Three values are ENVIRONMENT secrets, not per developer: `AUTH_PEPPER`,
`FIELD_ENCRYPTION_KEY_B64` and `CONTENT_ACCESS_TOKEN_SECRET`. Every developer on
the same database must use the same three, otherwise a prompt encrypted by one
developer cannot be read by the next. Kev generates them once per environment
with `--new-environment` and puts them into the vault next to the Supabase keys. It prints which variables it set
and the devnet fee payer's public key for the faucet, never a value.

## Rotation and offboarding

- Production keys live in Vercel and with Kev only. Nobody else has them, so
  leaving developers cause no production rotation.
- When a developer leaves, revoke their provider keys and remove their vault or
  Infisical access. If they had the `enki-dev` service role key, regenerate it
  in the Supabase dashboard and update the others.
- The environment secrets of `enki-dev` (pepper, encryption key) are dev only;
  rotating them means re-creating the dev data, which is acceptable there.
  Production has its own, held by Kev and Vercel only.

## Why not simply share the current database

Sharing one database also means sharing its `FIELD_ENCRYPTION_KEY_B64` and
`AUTH_PEPPER`, because every encrypted prompt and every password hash depends
on them. Whoever works against the production database therefore holds two
production secrets, and one careless migration or a test that deletes rows hits
real users. Today the live database holds only test data, so sharing it with a
first developer is tolerable for a few days; the moment a backend developer
writes a migration, or the first real user signs up, `enki-dev` must exist.
It is a second free Supabase project and takes ten minutes.

## What must never happen

- A production value in a developer's `.env.local`.
- A provider key without a spend cap.
- A key in chat, mail, ClickUp, a screenshot or a commit. `.gitignore` already
  excludes `.env*` except `.env.example`.
