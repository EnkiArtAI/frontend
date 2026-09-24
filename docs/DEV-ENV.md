# Developer environments

Rule one: **developers never receive production secrets.** Every developer
works against a separate dev environment whose keys can move no real money
and see no real user. What a developer gets is decided by their task, not by
copying one big file.

## The three tiers

| Tier | Who | Contains |
| --- | --- | --- |
| core | every developer | the `enki-dev` Supabase project (a re-keyed copy of the live database), the environment's pepper and encryption key (shared through the vault), localhost URLs, devnet chain, optional mail and blob |
| generation | only who works on image generation | Gemini, OpenAI, WaveSpeed, xAI: one key per developer with a hard spend cap, revoked when the task ends |
| payments | only backend developers on wallet, payments or login | devnet fee payer, wallet JWT key, CDP dev project, Google and X dev OAuth clients |

Frontend tasks need only core. The free model (Pollinations) runs without any
provider key. Every route that needs a missing key must answer with a clear
sentence ("Google sign in is not configured") instead of a stack trace; where
it does not yet, that is a bug (ClickUp ENV-01).

## A copy of the live database in a second Supabase project

The dev database is not an empty schema and not a local Postgres: it is a
**second Supabase project, `enki-dev`, filled programmatically with an exact
copy of the live schema and data, then re-keyed and sanitised.** No Docker, no
local Supabase, nothing to install: `scripts/db-copy.mjs` talks to the Supabase
Management API and moves the data with `pg_dump` and `psql`, which it
downloads once when they are not on the machine.

### What Kev runs

Everything below runs on Kev's machine only, because it needs the live
database password and the live encryption key.

1. Once, add two lines to `.env.local` (names in `.env.example`, block "kev only"):
   `SUPABASE_ACCESS_TOKEN` (a personal access token from
   https://supabase.com/dashboard/account/tokens) and `SUPABASE_DB_PASSWORD`
   (live project > Settings > Database).
2. Once per environment, generate the developer file with fresh environment
   secrets. `--new-environment` creates a NEW pepper and a NEW encryption key
   that have nothing to do with production:

   ```bash
   node scripts/make-dev-env.mjs --tier core --new-environment --out .env.dev.local
   ```

3. Copy the database:

   ```bash
   npm run db:copy -- --dev-env .env.dev.local --dry-run   # prints the plan and what is still missing, touches nothing
   npm run db:copy -- --dev-env .env.dev.local             # the real run
   ```

   Flags: `--name <project>` (default `enki-dev`), `--reset` (truncate the copy
   and reload the data), `--skip-data` (schema only), `--dry-run`.

The run, each step idempotent, each line of output a name or a count and
never a value:

1. Finds or creates the project `enki-dev` in the live project's organization
   and region with a generated database password, waits until it is healthy,
   fetches its anon and service role keys. Free plan: two active projects per
   organization, so the live project plus `enki-dev` fill the quota.
2. Creates the live project's extensions on the copy (`citext` lives in
   `public`, the rest in `extensions`).
3. `pg_dump --schema-only --schema=public --no-owner` over the session
   pooler, `psql` into the copy. Grants and revokes travel with the schema
   (the `anon`, `authenticated` and `service_role` roles exist on every
   project), so a function live revokes from `anon` stays revoked on the copy.
4. `pg_dump --data-only`, loaded with `SET session_replication_role =
   replica` (the method Supabase documents for restores): triggers and
   foreign key checks stay out of the way, so load order does not matter.
   Structure only, no rows: `auth_sessions`, `auth_nonces`, `otp_sessions`,
   `password_reset_tokens`, `delete_confirm_tokens`, `deletion_approvals`,
   `user_sessions`.
5. Re-keys and sanitises **on the copy, never on the source**, reading rows
   over the copy's PostgREST and patching them back by primary key:
   - every encryption envelope (`X_ct/X_iv/X_tag/X_kid`, `prompts.encrypted_content`)
     is decrypted with the live key ring and re-encrypted with the dev key;
     an envelope no key opens becomes null and is counted
   - every email becomes `user-<first 8 chars of the id>@example.test`, the
     same pseudonym for the same user in every table, lookup hashes follow
   - every password becomes `enki-dev-password` (Argon2id under the dev pepper,
     the app's own function)
   - token columns, ip hashes and the `last_seen_ip` envelope become null
   - everything else stays as it is
6. Writes the copy's `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_DB_PASSWORD_DEV` into the
   `--dev-env` file, replacing the `PASTE_FROM_DASHBOARD` markers.

The final report lists the project ref, the tables and their row counts, the
envelopes re-keyed, decrypt failures, rows pseudonymised, tables left
structure only, patch failures and the elapsed time.

The dump files are written to a work directory under the OS temp directory,
deleted at the end of the step that used them, and the work directory is
removed when the run ends, whether it succeeded or failed. When `pg_dump` or
`psql` fails, only the first error message reaches the terminal, cut before
its first colon; the CONTEXT and DETAIL lines that quote row values are
dropped. A failure during the data load or the sanitiser truncates the copy
again before the error is reported, so it never holds unsanitised rows for
longer than the run; if even the truncation fails, the copy's keys in the dev
file are replaced with `UNSANITISED_DO_NOT_SHARE` and the message says to
delete the project.

`pg_dump` and `psql` are taken from `PG_BIN`, then the PATH, then a cache in
the OS temp directory; on Windows, when none exists, the official PostgreSQL
18 binaries zip from EDB is downloaded once (about 340 MB), compared against
the SHA-256 pinned in `lib/dev/pg-tools.ts` (EDB publishes no checksum), and
only then are `pg_dump.exe`, `psql.exe` and their DLLs extracted. A mismatch
deletes the archive and stops the run.

### What a developer gets

The `.env.dev.local` file from the vault, complete. It points at `enki-dev`,
carries the dev pepper and the dev encryption key, and nothing in it opens
anything in production. Every copied user logs in with the password
`enki-dev-password`; the email is the pseudonym shown in the copy
(`user-xxxxxxxx@example.test`). Sessions, nonces and tokens are empty, so the
developer signs in fresh.

### Refresh

Re-run with `--reset`: the copy is truncated and reloaded from the live
database, then re-keyed again. The project, its keys and its password stay,
so no developer file changes. The schema is not rebuilt on a refresh; after a
live migration, delete `enki-dev` in the dashboard and run once without
`--reset`, then put the new `SUPABASE_URL` and keys into the vault.

### Key rotation semantics

The copy has its own encryption key, its own pepper and its own API keys, and
its database password is one the script generated. Production's
`FIELD_ENCRYPTION_KEY_B64`, `AUTH_PEPPER`, database password and access token
are read on Kev's machine, used to open and dump, and never written anywhere:
not into the dev file, not into a log line, not onto a command line
(`pg_dump` and `psql` receive the password as `PGPASSWORD` in the child
environment). Rotating a dev secret means re-running the copy with a new
`--new-environment` file, which is acceptable there; production keys are not
touched by any of this.

### Free plan limits

- Two active projects per organization; paused projects do not count.
- A free project is paused after one week without activity. Unpause it in the
  dashboard (https://supabase.com/dashboard/project/<ref>, button "Restore
  project"); the script detects a paused copy and says so instead of failing
  half way. A paused project can be restored for one year.
- 500 MB database, plenty for the current data.

## One time setup by Kev

1. Supabase: the copy above; `enki-dev` is created by the script.
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
with `--new-environment`; `db-copy` fills the Supabase values of that file, and
the whole file goes into the vault. The generator prints which variables it set
and the devnet fee payer's public key for the faucet, never a value.

## Rotation and offboarding

- Production keys live in Vercel and with Kev only. Nobody else has them, so
  leaving developers cause no production rotation.
- When a developer leaves, revoke their provider keys and remove their vault or
  Infisical access. If they had the `enki-dev` service role key, regenerate it
  in the Supabase dashboard and update the others.
- The environment secrets of `enki-dev` (pepper, encryption key) are dev only;
  rotating them means re-creating the dev data with a fresh `--new-environment`
  file and a `db-copy` run, which is acceptable there. Production has its own,
  held by Kev and Vercel only.

## Why not simply share the current database

Sharing one database also means sharing its `FIELD_ENCRYPTION_KEY_B64` and
`AUTH_PEPPER`, because every encrypted prompt and every password hash depends
on them. Whoever works against the production database therefore holds two
production secrets, and one careless migration or a test that deletes rows hits
real users. The copy gives every developer the same data without either secret,
and the copy can be reloaded in minutes when something breaks it.

## What must never happen

- A production value in a developer's `.env.local`.
- A provider key without a spend cap.
- A key in chat, mail, ClickUp, a screenshot or a commit. `.gitignore` already
  excludes `.env*` except `.env.example`.
