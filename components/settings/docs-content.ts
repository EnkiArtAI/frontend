/**
 * Copy for the How Enki works tab in Settings. Plain English for a 15 year
 * old, second person, no dash characters anywhere (lib/__tests__/docs-content
 * guards that, the paragraph length and the 1,600 word budget). Every claim
 * describes the product as built today; unfinished things are one
 * "Coming soon" sentence or left out.
 */

export type DocSection = { id: string; title: string; summary: string; body: string[] };
export type DocFaq = { q: string; a: string };

export const DOCS: DocSection[] = [
  {
    id: "intro",
    title: "What Enki is",
    summary: "A marketplace for AI image prompts.",
    body: [
      "Enki is a marketplace for AI image prompts. Artists write prompts with [brackets] for the parts you change, like [subject] or [mood]. You pick a prompt, fill in the blanks, and generate your own image from it.",
      "You pay per image, in USDC on the Solana network. USDC is a digital dollar, so 1 USDC normally equals 1 dollar. Enki is in a private beta, so you need an invite to get in.",
    ],
  },
  {
    id: "signin",
    title: "Getting in",
    summary: "Wallet or email, plus the beta gate.",
    body: [
      "Connect a Solana wallet like Phantom or Solflare and sign a short message to prove it is yours. Or create an account with an email and a password of at least 8 characters. Wallet accounts can browse and run free prompts today. To pay for images you need an email account with the built in wallet for now.",
      "Email accounts get a built in wallet, powered by Coinbase, that only you control. Forgot your password? Ask for a 7 digit code by email; it works for 15 minutes.",
      "The landing page is open to everyone, but the app needs your email or wallet on the access list. Coming soon: signing in with Google or X.",
    ],
  },
  {
    id: "feed",
    title: "The feed and prompts",
    summary: "Cards, filters, free and premium.",
    body: [
      "After sign in you land on Home. The left menu has Home, Search, Notifications, Messages, Bookmarks, Hall of Fame, Analytics and Settings; guests see only Home, Search and Hall of Fame.",
      "Each card shows the image, rating, likes, price, title and artist. Filter by tags like Portrait or Poster, or by image model. Search filters the prompts already on your screen; Ctrl+K or Cmd+K jumps to the box.",
      "Free prompts show their full text, and anyone can run them at no cost. Premium prompts hide their text; you see only the blanks and pay the artist per image.",
    ],
  },
  {
    id: "making",
    title: "Making images",
    summary: "Fill the blanks, press Generate.",
    body: [
      "Open a prompt and fill in each [bracket] box on the left. Stuck? Hit the dice and an AI fills every box with matching ideas. Then press Generate.",
      "Your image appears in the middle, with your history in a drawer on the right. Signed in users can comment, like and leave one rating per prompt.",
      "Three image models are live. Flux is free, works from text only and goes up to 2K. GPT Image 2 and Nano Banana Pro are paid, accept reference images, offer ten aspect ratios and go up to 4K.",
      "Every account gets 3 free images on Flux once signed in, and deleted images still count. Enki makes images only, no video.",
    ],
  },
  {
    id: "costs",
    title: "What it costs",
    summary: "Model cost plus 10 percent.",
    body: [
      "Everything beyond free Flux is pay per image: the model's real cost plus a 10 percent Enki fee. For a premium prompt the artist's price is added, and the fee applies to that too.",
      "Before the fee, Nano Banana Pro costs $0.134 at 1K or 2K and $0.24 at 4K. GPT Image 2 depends on quality, from $0.012 at low to $0.712 at high in 4K.",
      "The Generate button shows the full total before you click; open the resolution menu to see each size's price. Enki pays the Solana network fee, so the transaction itself costs you nothing.",
    ],
  },
  {
    id: "wallet",
    title: "Paying and your wallet",
    summary: "Your money stays in your wallet.",
    body: [
      "Your money lives in your wallet, not at Enki. That is an external Solana wallet you bring, or the built in Enki wallet you get with an email account. Enki cannot open either one.",
      "The balance you see is simply the USDC in your wallet. During the beta Enki runs on Solana devnet, a test network. USDC there is test money, not real dollars, and every price in the app is charged in it.",
      "Settings, Payment offers Add money through Coinbase, Pay out to your bank, and a Deposit Crypto address for USDC on Solana. Coinbase moves real USDC on the main network, which the beta does not count, so hold off on adding money until we move to the main network.",
      "When you buy an image, your wallet signs one transaction that pays the artist and Enki directly. It is only sent once your image comes out; if generation fails, nothing is charged. Coming soon: paying from an external wallet like Phantom, and sending USDC to any address.",
    ],
  },
  {
    id: "selling",
    title: "Selling your prompts",
    summary: "Write, release, get paid.",
    body: [
      "Open the Prompt Editor and write your prompt with [brackets] for the parts buyers fill in. Type @Image1 to point at a reference image.",
      "Generate example images, then Save or Release. A free prompt needs 1 example; a premium prompt needs 4 and your price per image. Your prompt text is stored encrypted; premium buyers never see it.",
      "Each sale sends USDC straight to your wallet inside the buyer's own transaction; Enki never holds your share. You need a Solana wallet on file, or nobody can generate from your prompt.",
      "Create Prompt 2 is a second editor where you build the prompt as a graph of nodes and save it to your private Library. Coming soon: releasing from Create Prompt 2, and earnings totals in Settings and Analytics.",
    ],
  },
  {
    id: "profile",
    title: "Your gallery and profile",
    summary: "Your images and your page.",
    body: [
      "Click your name or any artist to open their profile. Yours has Released, Gallery, Library, Likes, Reviews, About and History; visitors see less. Edit profile changes your banner, picture and text.",
      "Danger Zone in Settings, Profile deletes your account and all your work for good once you type your username. If you have guardians, they must approve first.",
    ],
  },
  {
    id: "social",
    title: "Bookmarks, notifications and Hall of Fame",
    summary: "Save, follow, compete.",
    body: [
      "Hover a card and hit the bookmark to save it into a category. The Bookmarks tab shows your categories as a grid; inside one, drag and drop to reorder.",
      "Notifications is your activity feed: comments, ratings and generations on your prompts, plus news from your guardians. The badge counts what you have not seen yet.",
      "Messages lets you chat with other users in text, images and emoji. Hall of Fame ranks users by generations for the week, month or all time. Coming soon: the earnings ranking. Hide yourself from it in Settings, Profile.",
    ],
  },
  {
    id: "safety",
    title: "Staying safe",
    summary: "Two step check, recovery, moderation and bans.",
    body: [
      "Two step check: add a passkey in Settings, Recovery & 2FA. That is your fingerprint, face or device PIN, best on a second device like your phone. Coming soon: asking for the passkey before you delete work or pay.",
      "Guardians get you back in if you lose your login. Add a wallet, an email or an authenticator app and set how many must approve. On the reset page your email guardians get a 7 digit code, and once enough approve you set a new password.",
      "Recovery file: built in wallet users can download their private key, locked with a passphrase. It opens in Phantom or Solflare even if Enki disappears. Until you add a guardian, a red banner warns that a lost login means a lost account.",
      "Every prompt is screened before it runs: a word list first, then an AI classifier. A blocked prompt just says it violates the guidelines and costs nothing. Bans are decided by people, with one exception: a prompt the AI flags as sexual content involving minors bans the account on the spot.",
      "A banned account cannot sign in and can file one appeal. Your money is still yours. With an external wallet you move it any time; with the built in wallet you write to the team and they help you move it out.",
    ],
  },
  {
    id: "developers",
    title: "For developers and AI agents",
    summary: "One request, one payment, one image.",
    body: [
      "An AI agent can buy a single image with no account. POST to /api/x402/generate with a prompt, or a promptId and its variable values, plus optional model, resolution, aspect ratio and quality. A GET with ?prompt= shows the price without paying.",
      "The first reply is HTTP 402 and lists the USDC to pay, split between Enki and the artist. Resend with one Solana transaction in the payment header the reply names: a transfer per leg, Enki as fee payer, signed by you. Enki verifies it, screens the prompt, submits it and returns the image link, never a premium prompt's text.",
    ],
  },
  {
    id: "help",
    title: "Where to ask",
    summary: "Help during the beta.",
    body: [
      "Not on the access list yet? Fill in Request access on the landing page, where the Terms of Use live too. Inside the app, Messages reaches any other user.",
    ],
  },
];

export const FAQ: DocFaq[] = [
  {
    q: "Do I need crypto to start?",
    a: "No, every account gets 3 free images on Flux and free prompts cost nothing. You only need USDC for paid models or premium prompts.",
  },
  {
    q: "Is Enki holding my money?",
    a: "No, your USDC sits in your own wallet, external or built in, and Enki cannot move it.",
  },
  {
    q: "What does an image cost?",
    a: "The model's real cost plus 10 percent, plus the artist's price on premium prompts. The Generate button shows the exact total before you click.",
  },
  {
    q: "Do I need SOL for network fees?",
    a: "No, Enki pays the Solana network fee, so USDC is all you need.",
  },
  {
    q: "Can I see a premium prompt's text after paying?",
    a: "No, you buy the image, never the text. Free prompts show their full text.",
  },
  {
    q: "Why was my prompt blocked?",
    a: "It tripped the content screen. A block costs nothing, so change the wording and try again.",
  },
  {
    q: "How do artists get paid?",
    a: "Directly, in USDC, inside the buyer's transaction, landing in the artist's Solana wallet when the image is generated.",
  },
  {
    q: "Can I make videos?",
    a: "No, Enki has image models only.",
  },
];
