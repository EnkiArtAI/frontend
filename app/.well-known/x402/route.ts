/**
 * x402 discovery manifest — how an agent FINDS the payable resources
 * (the Apify moment: the agent in Kev's reference discovered the paid API
 * on its own; this file is what makes Enki discoverable the same way).
 * Public by design; the proxy allowlists /.well-known/.
 */
import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    x402Version: 1,
    name: "Enki Art",
    description:
      "AI image marketplace. Generate images from curated artist prompts or plain text — priced per image, paid in USDC on Solana via x402. Artists earn their share on every prompt-backed generation.",
    network: "solana",
    resources: [
      {
        resource: "/api/x402/generate",
        method: "POST",
        description:
          "Generate one image. Body: { prompt } for plain text, or { promptId, variableValues } to use an artist's prompt (the artist's share is paid inside your own transaction). Required: modelFamily (nano-banana-pro | gpt-image-2). Optional: resolution (1K|2K|4K), aspectRatio, quality. A request without X-PAYMENT answers 402 with exact requirements: extra.feePayer carries our gas payer (you only need USDC) and extra.legs lists every required TransferChecked — one per recipient, exact amounts. Send the partially signed transaction back in X-PAYMENT; we co-sign, settle and answer with the image.",
        status: "live — plain prompts, free/showcase prompts and priced artist prompts (multi-leg source split)",
      },
    ],
  });
}
