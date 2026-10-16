# Enki Art

**The link between artists and users to transform reality.**

> **Note (2026-10-16):** The code in this repository is the state submitted to the Colosseum hackathon (tag `colosseum-submission`, commit `8de4399a`); only this README was rewritten since. Development continues in a private repository, and www.enki.gallery runs that newer version. What changed since the submission (123 commits):
>
> **Added**
> - GPT-Image-2.5 Flare and Sunburst as generators, up to 4K, with a low / medium / high quality setting; agents can buy them over x402 too.
> - Refer a prompt: paste a post from X; its prompt is checked, shown as a preview and published from there.
> - Likes on images: a heart in the Gallery viewer and its multi-select bar (prompts could already be liked).
> - Profile Gallery: an endless wall with a near-full-screen viewer, the render's values (and its prompt text where you may see it) with copy buttons, Recreate, and multi-select to download, like or delete.
> - Android Chrome: external Solana wallets through the Mobile Wallet Adapter (connect, then tap again to sign); real-device testing in progress.
> - Settings: email accounts also see their wallet's EVM address, read-only.
>
> **Changed**
> - Images: the feed, search, prompt pages and Gallery show WebP renditions instead of multi-megabyte originals (a home feed page used to load 16.3 MB of PNGs); new previews are 2048 px. Downloads keep the original, named `enki-<title>-<id>`.
> - Pricing: Generate shows an estimated price right away, stays grey while the balance loads, and the server's quote is what gets charged.
> - Payments: an external wallet connects silently first and has 60 seconds to answer, so a wallet that never opens no longer stalls the queue.
> - Security and dependency updates.
> - Prompt editor: reference images go in at the cursor; a release takes at least the minimum number of images and has no upper limit; a free prompt runs on every generator.
> - Image view: the browser's Back returns to the feed; a picked history image brings its reference images along.
> - Deleting an image or a prompt always asks for confirmation first.
> - Settings: Add money, Pay out and Deposit sit beside the balance.
> - Shell: Quick Create waits as one round button in the corner; endless pages fold the menu into its rail and use the freed width.
> - Access: every active account is admitted once the whitelist stage ends.
>
> **Removed**
> - `/my-gallery`, a duplicate of the profile's Gallery tab.
> - The separate money sections in Settings, replaced by the three actions beside the balance.

Enki Art connects the people who craft prompts with the people who want images. Artists publish prompts with variables; users fill in the variables and turn them into their own images, with one of the image models the artist offers for that prompt. Premium prompts are paid per image and are built to keep their text hidden from buyers; the price can include a share for the prompt's artist.

<div align="center">
  <img src="https://img.shields.io/badge/Next.js-16-black?style=for-the-badge&logo=next.js" alt="Next.js 16">
  <img src="https://img.shields.io/badge/TypeScript-5-blue?style=for-the-badge&logo=typescript" alt="TypeScript 5">
  <img src="https://img.shields.io/badge/Supabase-Postgres-3ECF8E?style=for-the-badge&logo=supabase" alt="Supabase">
  <img src="https://img.shields.io/badge/Solana-USDC-9945FF?style=for-the-badge&logo=solana" alt="Solana">
</div>

---

## Features (as submitted)

- **Discover feed**: a masonry wall of released prompts with categories, search and bookmarks.
- **Variable prompts**: bracket variables (`[subject]`, `[mood]`) turn a prompt into a template. Open prompts show their text; premium prompts are built to keep it hidden.
- **Image view and editor**: compose, generate, try variations, add reference images, and release a prompt with its showcase images.
- **Generators**: Nano Banana Pro, Nano Banana 2, GPT-Image-2 and a free model.
- **Payments**: a USDC balance on Solana; paid generations go through a Solana escrow program (on devnet for the submission). Agents pay per request over x402.
- **Accounts**: email and password with an embedded Coinbase wallet, or sign in with your own Solana wallet (Phantom, Solflare). Optional second factor (passkey, authenticator app), and guardian-based recovery.
- **Community**: profiles, likes on prompts, comments, messages, a leaderboard and notifications.
- **Safety**: image checks on uploads and generations, reports, and moderation.
- **Private beta**: access by invitation.

## Tech stack

- **App**: [Next.js 16](https://nextjs.org/) (App Router), [React 19](https://react.dev/), TypeScript 5, [Tailwind CSS 4](https://tailwindcss.com/)
- **Data**: [Supabase](https://supabase.com/) (Postgres) through supabase-js; SQL migrations in `migrations/`
- **Wallets**: [Coinbase CDP](https://docs.cdp.coinbase.com/) embedded wallets, [Solana web3.js](https://solana.com/docs/clients/javascript) and `@solana/kit`, the Solana wallet adapter with Wallet Standard detection, and a generated client for the escrow program
- **Image models**: Google Gemini, OpenAI, WaveSpeed and Pollinations
- **Images**: [sharp](https://sharp.pixelplumbing.com/) and [Vercel Blob](https://vercel.com/docs/vercel-blob), with WebP previews and thumbnails next to each original
- **UI**: [Radix UI](https://www.radix-ui.com/), [Lucide](https://lucide.dev/), [TanStack Query](https://tanstack.com/query)
- **Checks**: [Vitest](https://vitest.dev/), ESLint, `tsc`

## Getting started

1. Install Node.js 24 (see `.nvmrc`).
2. Clone and install:
   ```bash
   git clone https://github.com/EnkiArtAI/frontend.git
   cd frontend
   npm ci
   ```
3. Copy `.env.example` to `.env.local` and fill in its values. A few settings the code reads are not listed there yet; `git grep process.env` shows all of them.
4. You need a Supabase project that already has the base schema: `migrations/` holds the changes on top of it, applied by hand in the SQL editor, so an empty project cannot be built from this repository alone.
5. Start the dev server:
   ```bash
   npm run dev
   ```
   Open [http://localhost:3000](http://localhost:3000).

Checks:
```bash
npm test          # unit tests (app and backend)
npm run check     # TypeScript
npm run lint      # ESLint (one known error at this commit)
npm run build
```

## Project structure

- `app/`: pages and API routes (App Router)
- `components/`: UI, grouped by surface (feed, image view, prompt editor, settings)
- `hooks/`, `providers/`: React hooks and context providers
- `lib/`: shared logic (generation, payments, moderation, the UI kit)
- `backend/`: the image provider clients
- `migrations/`: SQL migrations, applied to Supabase by hand
- `lib/payments/escrow/`: the escrow program's IDL and its generated client; the program's source lives in a separate repository
- `scripts/`: checks and generators (migration checks, the escrow client)
- `docs/`: specs and payment design notes

## Status

This snapshot is not maintained and is not meant to be deployed as is.

<div align="center">
  <br />
  Built by the Enki Art team
</div>
