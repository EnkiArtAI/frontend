/**
 * "Let your AI agent use this prompt": the request an agent sends to the
 * existing x402 route (plan §5 #22: there is no /v1/prompts/{id}/generate).
 * The agent pays with an X-PAYMENT header it builds itself. The page never
 * sends one, so both the copied request and the page's own price probe get
 * the 402 with the price; the route settles only with the header.
 */
import { microToUsd } from "@/lib/generation-checkout";
import { toModelFamily } from "@/lib/generation/model-family";
import type { PromptVariable } from "./segments";
import type { ImageSetup } from "./setups";

export const AGENT_PATH = "/api/x402/generate";

/** The body app/api/x402/generate reads. */
export interface AgentBody {
  promptId: string;
  variableValues: Record<string, string>;
  modelFamily: string;
  resolution: ImageSetup["resolution"];
  aspectRatio: string;
  quality?: ImageSetup["quality"];
}

/**
 * The agent's version of a job, as the route reads it: the declared
 * variables' values by stored name, a checkbox as "true" or "false" (the
 * route writes its text itself), empty ones left out (the route refuses an
 * empty choice), and no Boost or references, which the route does not take.
 * Null without a prompt (the blank composer has no agent row).
 */
export function agentBody(s: ImageSetup, variables: PromptVariable[]): AgentBody | null {
  if (!s.promptId) return null;
  return {
    promptId: s.promptId,
    variableValues: Object.fromEntries(variables.flatMap((v) => (s.values[v.name] ? [[v.name, s.values[v.name]]] : []))),
    modelFamily: toModelFamily(s.model.name),
    resolution: s.resolution,
    aspectRatio: s.aspectRatio,
    ...(s.quality ? { quality: s.quality } : {}),
  };
}

/** The request to copy, without X-PAYMENT, so the agent is told the price before it pays. */
export const agentCurl = (origin: string, body: AgentBody) =>
  `curl -X POST ${origin}${AGENT_PATH} -H "Content-Type: application/json" -d '${JSON.stringify(body).replace(/'/g, "'\\''")}'`;

/** The page's price probe: the same body, and never an X-PAYMENT header. */
export const agentProbe = (body: AgentBody): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** The probe's answer: the 402's price per image, or the route's reason it will not serve these settings. */
export function agentPrice(status: number, json: unknown): { price: string } | { error: string } {
  const j = (json ?? {}) as { error?: unknown; accepts?: Array<{ maxAmountRequired?: unknown }> };
  const micro = status === 402 ? j.accepts?.[0]?.maxAmountRequired : undefined;
  if (typeof micro === "string" && micro) return { price: `$${microToUsd(micro)}` };
  return { error: typeof j.error === "string" && j.error ? j.error : `HTTP ${status}` };
}

/** Where the agent's render can differ from this page's, said under the snippet. */
export function agentNotes({ premium, artistUsd, setup }: { premium: boolean; artistUsd: string | null; setup: ImageSetup }): string[] {
  const notes: string[] = [];
  if (!premium) notes.push("The prompt is free; only generator cost applies.");
  else if (artistUsd) notes.push(`Same $${artistUsd} creator price as here.`);
  if (setup.boost || setup.refs.length) notes.push("Agents run without Boost and without reference images.");
  if (setup.edited !== null) notes.push("Your edits to the text are not part of the agent request.");
  return notes;
}
