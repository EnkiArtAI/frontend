/**
 * Hard cap on calls to metered providers, for throwaway probes and benchmarks.
 *
 * Import this FIRST in any script that might reach a paid API:
 *
 *   import "./scripts/metered-guard.mjs";
 *   // then run with:  METERED_BUDGET=3 node __bench-whatever.mjs
 *
 * It patches globalThis.fetch, so it also covers SDKs that call out on their
 * own (@google/genai and the OpenAI client both use fetch underneath) — the
 * script does not get to decide what counts.
 *
 * ── Why it counts EVERY request, including ones expected to fail ──────────
 * On 2026-08-06 a probe sent deliberately invalid values to WaveSpeed on the
 * assumption that an invalid request is rejected before anything is billed.
 * That held for an invalid *value* and not for an unknown *field*: WaveSpeed
 * ignored the unknown field, accepted the request, and started a real
 * generation. The assumption was the defect.
 *
 * So there is no "free probe" category here. A request to a metered host
 * counts the moment it is made, because whether it bills is the provider's
 * decision and not something this side can know in advance.
 */

const METERED_HOSTS = [
  "generativelanguage.googleapis.com", // Gemini
  "api.wavespeed.ai",
  "api.openai.com",
  "api.x.ai",                          // Grok
  "image.pollinations.ai",             // free today, metered tomorrow
  // AceData: x402 settles USDC per call, so the request IS the payment.
  // Listed per host rather than as the bare domain — a bare "acedata.cloud"
  // also swallows platform2.cdn.acedata.cloud, and spending budget on
  // downloading the image you just paid for starves the run that follows.
  "api.acedata.cloud",
  "x402.acedata.cloud",
  // Helius: every RPC and NFT-index call costs credits (getAssetsByOwner 10).
  // The bare domain on purpose, unlike AceData: cdn.helius-rpc.com carries no
  // key, but whether Helius throttles or bills it is theirs to decide, so a
  // probe spends budget on it too.
  "helius-rpc.com",
];

const raw = process.env.METERED_BUDGET;
const BUDGET = Number(raw);

if (raw === undefined || !Number.isInteger(BUDGET) || BUDGET < 0) {
  throw new Error(
    "metered-guard: set METERED_BUDGET to the number of paid calls Kev approved.\n" +
    "  e.g.  METERED_BUDGET=3 node __bench-x.mjs\n" +
    "Approval is per run and stated in advance: provider, count, purpose.",
  );
}

/**
 * Fields that mean "generate this many images". One request asking for 999 is
 * ONE call and would sail past a budget of 1 — counting requests is not
 * counting money. On 2026-08-06 exactly that was sent to WaveSpeed as a
 * deliberately-invalid value; the only thing that refused it was the account
 * balance, not anything on this side.
 */
const COUNT_FIELDS = ["num_images", "numImages", "n", "count", "batch_size", "num_outputs", "samples"];

/** Kev's standing allowance, 2026-08-06: 3 images per request unless he says
 *  otherwise. Anything above needs his explicit go, per run. */
const MAX_IMAGES = Number(process.env.METERED_MAX_IMAGES ?? 3);

function requestedImages(init) {
  const body = init?.body;
  if (typeof body !== "string") return 1;
  let parsed;
  try { parsed = JSON.parse(body); } catch { return 1; }
  let most = 1;
  const walk = (node, depth) => {
    if (!node || typeof node !== "object" || depth > 4) return;
    for (const [k, v] of Object.entries(node)) {
      if (COUNT_FIELDS.includes(k) && typeof v === "number") most = Math.max(most, v);
      else if (typeof v === "object") walk(v, depth + 1);
    }
  };
  walk(parsed, 0);
  return most;
}

const nativeFetch = globalThis.fetch;
let used = 0;

globalThis.fetch = async function guardedFetch(input, init) {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  let host = "";
  try { host = new URL(url).host; } catch { /* relative — cannot be a provider */ }

  const metered = METERED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  if (!metered) return nativeFetch(input, init);

  // Check the batch size BEFORE the budget: a single oversized request is the
  // expensive failure, and it must be refused even when budget remains.
  const images = requestedImages(init);
  if (images > MAX_IMAGES) {
    throw new Error(
      `metered-guard: refusing a request for ${images} images to ${host} — the cap is ` +
      `${MAX_IMAGES}. One request can bill for hundreds; counting requests is not ` +
      `counting money. Raise METERED_MAX_IMAGES only with Kev's explicit go.`,
    );
  }

  if (used >= BUDGET) {
    throw new Error(
      `metered-guard: refusing call ${used + 1} to ${host} — budget is ${BUDGET}. ` +
      `Ask Kev before raising it.`,
    );
  }
  used += 1;
  console.log(`[metered] ${used}/${BUDGET} → ${host} (${images} image${images === 1 ? "" : "s"})`);
  return nativeFetch(input, init);
};

process.on("exit", () => {
  if (used > 0) console.log(`[metered] run finished: ${used} of ${BUDGET} approved calls used`);
});
