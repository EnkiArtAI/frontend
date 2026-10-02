/**
 * x402 entrance for AGENTS — image generation as a payable HTTP resource
 * (Kev, 2026-08-23: "wir bauen das alles erst auf solana aus, damit agents
 * auch zugriff auf unsere prompts haben können").
 *
 * The protocol (x402): a request without payment answers HTTP 402 carrying
 * EXACT payment requirements; the agent builds a Solana transaction paying
 * them (one USDC TransferChecked to the platform wallet, OUR fee payer as
 * payer — only USDC needed, never SOL), partially signs it and resends with
 * the X-PAYMENT header. We verify offline, co-sign, submit with preflight,
 * generate, and answer with the image plus X-PAYMENT-RESPONSE.
 *
 *   GET  /api/x402/generate?modelFamily=…      → 402 requirements (probe)
 *   POST /api/x402/generate                    → 402 without X-PAYMENT
 *        { prompt } or { promptId, variableValues? }, plus the model
 *        { modelFamily } and optional { resolution, aspectRatio, quality }
 *   POST + X-PAYMENT                           → settle, generate, 200
 *
 * Prices are THE SAME ladders humans pay. Since 2026-08-24 (Kev: "i want
 * agents to purchase artists prompts") priced prompts settle too: the 402's
 * extra.legs lists every required transfer — for an artist prompt that is
 * TWO TransferChecked in one transaction (artist share + platform leg), the
 * same atomic source-split the human rails settle with. The artist is paid
 * by the buyer's own transaction, never out of platform custody. A paid
 * prompt's body is decrypted server-side for the generation only — the
 * agent buys the generation, never the text.
 *
 * Order of operations is deliberate: model, route, prompt text and
 * moderation are all resolved BEFORE the payment settles — the only thing
 * standing between a settled payment and a delivered image is the provider
 * call itself. Payment first would take money for requests we then refuse.
 */
import { NextRequest, NextResponse, after } from "next/server";
import { z } from "zod";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { computeQuote } from "@/lib/payments/generation-quote";
import {
  getModelCostMicro, computeGenerationSplit, UnknownModelError,
} from "@/lib/payments/generation-pricing";
import { usdcMint, feePayerKeypair, solanaConnection, solanaChainKey } from "@/lib/payments/solana";
import { effectiveQuality } from "@/lib/pricing";
import { reportPriceDrift } from "@/lib/generation/price-drift";
import {
  parseXPayment, verifyAgentPayment, cosignAsFeePayer, submitAndConfirm, paymentResponseHeader,
} from "@/lib/payments/x402-settle";
import { checkAndRecordSolanaSignature } from "@/backend/solana-x402-verifier";
import { isSolanaChain } from "@/shared/payment-config";
import { loadPromptText, fillVariables } from "@/lib/generation/prompt-text";
import { findMissingAtas } from "@/lib/payments/authorize-flow";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { moderate, CLIENT_BLOCK_MESSAGE } from "@/lib/moderation";
import { resolveModelByFamily, chooseRoute } from "@/lib/generation/models";
import { clampTier } from "@/lib/generation/resolution";
import { reportSuccess, reportFailure } from "@/lib/generation/provider-health";
import { storeGeneratedImage } from "@/lib/generation/derivative-store";
import { generateImagesWithWaveSpeed } from "@/backend/services/wavespeed-image-generation";
import { generateImagesWithOpenAI } from "@/backend/services/openai-image-generation";
import { generateImagesWithGemini } from "@/backend/services/gemini-image-generation";
import type { ImageGenerationRequest } from "@/backend/services/types";
import { PublicKey } from "@solana/web3.js";

export const maxDuration = 300;

const RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"] as const;

const bodySchema = z.object({
  prompt: z.string().trim().min(1).max(4000).optional(),
  promptId: z.string().uuid().optional(),
  variableValues: z.record(z.string(), z.string().max(2000)).optional(),
  // Required: an agent that names no model gets a refusal, never a default
  // one (Kev, 2026-10-02: "NIEMALS IRGENDEIN standardmodell").
  modelFamily: z.string({ error: "modelFamily is required" }).trim().min(1, "modelFamily is required").max(64),
  resolution: z.enum(["1K", "2K", "4K"]).default("2K"),
  aspectRatio: z.string().trim().max(8).default("1:1"),
  quality: z.enum(["low", "medium", "high"]).optional(),
}).refine((v) => v.prompt || v.promptId, { message: "Send prompt or promptId" });

type Input = z.infer<typeof bodySchema>;

function platformWallet(): string | null {
  return process.env.SOLANA_PLATFORM_WALLET || process.env.NEXT_PUBLIC_SOLANA_PLATFORM_WALLET || null;
}

/** Fee payer address for the 402's extra — null when settlement is unconfigured. */
function feePayerAddress(): string | null {
  try { return feePayerKeypair().publicKey.toBase58(); } catch { return null; }
}

interface Priced {
  status: 402;
  body: Record<string, unknown>;
  amountMicro: number;
  /**
   * Every transfer the payment must carry. One leg (platform) for plain and
   * free-prompt generations; two (artist + platform) when the prompt has a
   * priced artist share — the same atomic source-split the human rails
   * settle with, so the artist is paid by the buyer's own transaction.
   */
  legs: Array<{ recipient: string; amountMicro: number }>;
}
type Requirements = Priced | { status: 400 | 404 | 422 | 500 | 503; body: { error: string } };

/** The 402 body, in the x402 ecosystem's shape — Solana-first by decree. */
async function requirementsFor(input: Input): Promise<Requirements> {
  const payTo = platformWallet();
  if (!payTo) return { status: 503, body: { error: "Payments are not configured on this deployment" } };

  let amountMicro: number;
  let legs: Priced["legs"];
  let description: string;
  if (input.promptId) {
    const supabase = getSupabaseServerClient();
    const quote = await computeQuote(supabase, {
      promptId: input.promptId,
      modelFamily: input.modelFamily,
      resolution: input.resolution,
      quality: input.quality,
    });
    if (!quote.ok) return { status: quote.status, body: { error: quote.error } };
    amountMicro = quote.split.totalMicro;
    const artistMicro = quote.split.artistAmountMicro;
    if (artistMicro > 0 && !quote.artistWallet) {
      return { status: 503, body: { error: "This prompt's artist has no payout wallet yet" } };
    }
    legs = artistMicro > 0 && quote.artistWallet
      ? [
          { recipient: quote.artistWallet, amountMicro: artistMicro },
          { recipient: payTo, amountMicro: quote.split.enkiTotalMicro },
        ]
      : [{ recipient: payTo, amountMicro }];
    description = `Generate 1 image from prompt ${input.promptId} (${input.modelFamily}, ${input.resolution}) — artist share included`;
  } else {
    try {
      const modelCostMicro = getModelCostMicro(input.modelFamily, input.resolution, { quality: input.quality });
      amountMicro = computeGenerationSplit(0, modelCostMicro).totalMicro;
      legs = [{ recipient: payTo, amountMicro }];
      description = `Generate 1 image (${input.modelFamily}, ${input.resolution})`;
    } catch (e) {
      if (e instanceof UnknownModelError) return { status: 422, body: { error: e.message } };
      throw e;
    }
  }

  const feePayer = feePayerAddress();
  return {
    status: 402,
    amountMicro,
    legs,
    body: {
      x402Version: 1,
      error: "X-PAYMENT header is required",
      accepts: [
        {
          scheme: "exact",
          network: "solana",
          asset: usdcMint().toBase58(),
          payTo,
          maxAmountRequired: String(amountMicro),
          resource: "/api/x402/generate",
          description,
          mimeType: "application/json",
          maxTimeoutSeconds: 120,
          extra: {
            // The agent builds its transaction WITH this fee payer, which is
            // how "only USDC, never SOL" is kept: we pay the gas.
            ...(feePayer ? { feePayer } : {}),
            // Build ONE TransferChecked per entry, exact amounts. Two legs
            // means the prompt's artist is paid inside your own transaction.
            legs,
            modelFamily: input.modelFamily,
            resolution: input.resolution,
            aspectRatio: input.aspectRatio,
            ...(input.quality ? { quality: input.quality } : {}),
            note: "Only USDC is needed — the platform fee payer carries Solana gas. Send one TransferChecked per extra.legs entry.",
          },
        },
      ],
    },
  };
}

/** 402 again with a reason — the spec's answer to an unusable payment. */
function rejectPayment(reqs: Priced, error: string) {
  return NextResponse.json({ ...reqs.body, error }, { status: 402 });
}

async function settleAndGenerate(input: Input, paymentHeader: string): Promise<NextResponse> {
  // ── Everything refusable is refused BEFORE money moves ──────────────────
  let feePayer;
  try {
    feePayer = feePayerKeypair();
  } catch {
    return NextResponse.json(
      { error: "x402 settlement is not configured on this deployment. No funds moved." },
      { status: 503 },
    );
  }

  const reqs = await requirementsFor(input);
  if (reqs.status !== 402) return NextResponse.json(reqs.body, { status: reqs.status });

  const supabase = getSupabaseServerClient();

  // Prompt text: sent directly, or loaded from the prompt row. A PAID
  // prompt's full body is encrypted at rest — it is decrypted HERE, used for
  // the generation, and never leaves this function: the agent buys the
  // generation, not the text (Kev, 2026-08-24: "i want agents to purchase
  // artists prompts"). Free/showcase prompts read their public text.
  let promptText = input.prompt ?? "";
  if (input.promptId) {
    const text = await loadPromptText(supabase, input.promptId);
    if (!text.ok) return NextResponse.json({ error: text.error }, { status: text.status });
    promptText = fillVariables(text.text, input.variableValues, text.variables);
  }

  const verdict = await moderate({ prompt: promptText, surface: "x402-generate" });
  if (!verdict.allowed) {
    return NextResponse.json({ error: CLIENT_BLOCK_MESSAGE }, { status: 422 });
  }

  const model = await resolveModelByFamily(supabase, input.modelFamily);
  if (!model) return NextResponse.json({ error: `Unknown model family: ${input.modelFamily}` }, { status: 422 });
  // The EFFECTIVE quality routes, prices and renders — one value, three uses
  // (gpt's route conditions fail closed on a missing quality).
  const effQuality = model.supportsQuality ? effectiveQuality(input.resolution, input.quality) : null;
  const route = await chooseRoute(supabase, model, {
    quality: effQuality,
    resolution: input.resolution,
    referenceImages: 0,
  });
  if (!route) {
    return NextResponse.json({ error: "No healthy route for this model right now — retry shortly" }, { status: 503 });
  }
  // A paid request never falls back to a guessed model (Kev, 2026-09-22) and
  // never lands on a host this route cannot call or on the free Flux host:
  // both are refused here, before any money moves.
  if (!["gemini", "wavespeed", "openai"].includes(route.provider)) {
    return NextResponse.json({ error: "This model is not available on a paid host right now — nothing was charged" }, { status: 503 });
  }
  if (!route.providerModel) {
    return NextResponse.json({ error: "This model has no provider model configured — nothing was charged" }, { status: 503 });
  }

  // ── Verify the agent's transaction offline ──────────────────────────────
  const parsed = parseXPayment(paymentHeader);
  if (!parsed.ok) return rejectPayment(reqs, parsed.error);
  const verified = verifyAgentPayment(parsed.tx, {
    legs: reqs.legs.map((l) => ({ owner: new PublicKey(l.recipient), amountMicro: l.amountMicro })),
    mint: usdcMint(),
    feePayer: feePayer.publicKey,
  });
  if (!verified.ok) return rejectPayment(reqs, verified.error);

  // A leg can point at a wallet with no USDC account yet (a new artist).
  // TransferChecked to a missing ATA fails the whole payment, so the fee
  // payer fronts the account first — the same thing the human rails do.
  // Rent (~0.002 SOL each) is carried by the fee payer for now; ledger
  // recovery for agent payments needs its own bookkeeping and is a noted
  // follow-up, not silently skipped.
  try {
    const owners = reqs.legs.map((l) => l.recipient);
    const missing = await findMissingAtas(owners);
    if (missing.length > 0) {
      const conn = solanaConnection();
      const mint = usdcMint();
      const ixs = missing.map((owner) =>
        createAssociatedTokenAccountIdempotentInstruction(
          feePayer.publicKey,
          getAssociatedTokenAddressSync(mint, new PublicKey(owner)),
          new PublicKey(owner),
          mint,
        ),
      );
      const { blockhash } = await conn.getLatestBlockhash("confirmed");
      const msg = new TransactionMessage({
        payerKey: feePayer.publicKey, recentBlockhash: blockhash, instructions: ixs,
      }).compileToV0Message();
      const fronted = new VersionedTransaction(msg);
      fronted.sign([feePayer]);
      const sig = await conn.sendRawTransaction(Buffer.from(fronted.serialize()), { maxRetries: 3 });
      await conn.confirmTransaction(sig, "confirmed");
      console.warn(`[x402] fronted ${missing.length} USDC account(s) for payment legs — rent on the fee payer`);
    }
  } catch (e) {
    return NextResponse.json(
      { error: "Could not prepare a recipient's USDC account — no funds moved. Retry shortly." },
      { status: 503 },
    );
  }

  // ── Settle: co-sign, replay-guard on the deterministic signature, submit ─
  const signature = cosignAsFeePayer(parsed.tx, feePayer);
  // solanaChainKey() already throws on non-Solana chains; the guard only
  // narrows the TYPE down to what the replay recorder accepts.
  const chainKey = solanaChainKey();
  if (!isSolanaChain(chainKey)) {
    return NextResponse.json({ error: "Deployment chain is not Solana" }, { status: 503 });
  }
  const replay = await checkAndRecordSolanaSignature(signature, chainKey, "x402-agent-generate");
  if (!replay.isNew) {
    return NextResponse.json(
      { error: "This payment transaction was already settled", transaction: signature },
      { status: 409 },
    );
  }
  const settled = await submitAndConfirm(solanaConnection(), parsed.tx);
  if (!settled.ok) {
    // Preflight/on-chain rejection means no funds moved; a confirmation
    // timeout is the one ambiguous case, so the signature travels with the
    // error for the agent to check.
    const timedOut = settled.error.includes("Timed out");
    return NextResponse.json(
      { error: settled.error, transaction: signature },
      { status: timedOut ? 504 : 402 },
    );
  }

  // ── Paid work: one provider call on the routed host ─────────────────────
  const ratio = (RATIOS as readonly string[]).includes(input.aspectRatio) ? input.aspectRatio : "1:1";
  const genRequest: ImageGenerationRequest = {
    prompt: promptText,
    // The routed model, exactly as the human route sends it. Without it every
    // adapter used to fall back to its own default model.
    modelVersion: route.providerModel,
    aspectRatio: ratio as ImageGenerationRequest["aspectRatio"],
    imageSize: model.supportsResolution
      ? clampTier(input.resolution, route.provider, route.providerModel)
      : undefined,
    quality: model.supportsQuality ? (effQuality ?? undefined) : undefined,
    numImages: 1,
  };
  const result =
    route.provider === "wavespeed" ? await generateImagesWithWaveSpeed(genRequest)
    : route.provider === "openai" ? await generateImagesWithOpenAI(genRequest)
    : await generateImagesWithGemini(genRequest);

  const buffer = result.success ? result.imageBuffers?.[0] : undefined;
  if (!buffer) {
    if (route.modelProviderId && route.providerId) {
      after(reportFailure(getSupabaseServerClient(), route.modelProviderId, route.providerId, result.error || "generation failed"));
    }
    // The payment settled; hiding that would be worse than the failure.
    return NextResponse.json(
      {
        error: result.error || "Image generation failed after your payment settled.",
        transaction: signature,
        note: "Keep this transaction signature — support will make it right.",
      },
      { status: 502 },
    );
  }
  if (route.modelProviderId && route.providerId) {
    after(reportSuccess(getSupabaseServerClient(), route.modelProviderId, route.providerId));
  }
  if (typeof result.usage?.costUsd === "number") {
    after(reportPriceDrift(supabase, {
      provider: route.provider,
      modelFamily: input.modelFamily,
      resolution: input.resolution,
      quality: effQuality,
      observedUsd: result.usage.costUsd,
    }));
  }

  const dataUrl = `data:image/png;base64,${buffer.toString("base64")}`;
  const stored = await storeGeneratedImage(dataUrl, "x402-agent");

  return NextResponse.json(
    {
      imageUrl: stored.imageUrl,
      ...(stored.previewUrl ? { previewUrl: stored.previewUrl } : {}),
      modelFamily: input.modelFamily,
      resolution: input.resolution,
      aspectRatio: ratio,
      paidMicroUsdc: reqs.amountMicro,
      transaction: signature,
    },
    { headers: { "X-PAYMENT-RESPONSE": paymentResponseHeader(signature, "solana", feePayer.publicKey) } },
  );
}

export async function GET(req: NextRequest) {
  const parsed = bodySchema.safeParse({
    prompt: req.nextUrl.searchParams.get("prompt") ?? "probe",
    promptId: req.nextUrl.searchParams.get("promptId") ?? undefined,
    modelFamily: req.nextUrl.searchParams.get("modelFamily") ?? undefined,
    resolution: req.nextUrl.searchParams.get("resolution") ?? undefined,
  });
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  const r = await requirementsFor(parsed.data);
  return NextResponse.json(r.body, { status: r.status });
}

export async function POST(req: NextRequest) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  }

  const payment = req.headers.get("X-PAYMENT");
  if (payment) return settleAndGenerate(parsed.data, payment);

  const r = await requirementsFor(parsed.data);
  return NextResponse.json(r.body, { status: r.status });
}
