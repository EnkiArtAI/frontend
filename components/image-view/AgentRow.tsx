"use client";

import { useState } from "react";
import { Bot, Check, ChevronDown, Copy } from "lucide-react";
import { AGENT_PATH, agentBody, agentCurl, agentNotes } from "@/lib/ui/image-view/agent";
import { copyText, type ImageViewModel } from "./useImageViewModel";

/**
 * "Let your AI agent use this prompt": the request an agent sends to the
 * existing x402 route (plan §5 #22), and nothing else (Kev, 2026-10-13). The
 * price is never part of that request: the route answers the first call,
 * the one without X-PAYMENT, with 402 and the price per image (x402 v1,
 * accepts[].maxAmountRequired); the agent pays it in USDC on Solana and sends
 * the request again with X-PAYMENT.
 */
export default function AgentRow({ model: m }: { model: ImageViewModel }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const { setup } = m;
  const body = setup && agentBody(setup, m.variables);
  const artistUsd = m.quote && Number(m.quote.artistUsd) > 0 ? m.quote.artistUsd : null;

  const copy = () => {
    if (!body) return;
    copyText(agentCurl(location.origin, body), "Request copied");
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="iv-agent">
      <button type="button" className="iv-agent-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Bot size={14} strokeWidth={2} aria-hidden />
        <span>Let your AI agent use this prompt</span>
        <span className="iv-agent-badge">x402</span>
        <ChevronDown className="iv-agent-chev" size={12} strokeWidth={2.2} aria-hidden />
      </button>
      {/* Always mounted: the fold opens and closes as a quick height change (Kev, 2026-10-13); closed, it is inert. */}
      <div className="iv-agent-fold" data-open={open || undefined} inert={!open || undefined}>
        <div className="iv-agent-fold-in">
        {setup && body ? (
          <>
            <pre className="iv-code">
              {`POST ${location.origin}${AGENT_PATH}\nContent-Type: application/json\nX-PAYMENT: <x402 payment payload>\n${JSON.stringify(body, null, 2)}`}
              {/* An icon in the corner; the text wraps short of it. */}
              <button type="button" className="iv-code-copy" onClick={copy} aria-label={copied ? "Copied" : "Copy the request"}
                title={copied ? "Copied" : "Copy as curl"}>
                {copied ? <Check size={13} strokeWidth={2.4} aria-hidden /> : <Copy size={13} strokeWidth={2} aria-hidden />}
              </button>
            </pre>
            <p className="iv-agent-note">
              Sent without X-PAYMENT it answers 402 with the price per image; the agent pays that in USDC on Solana and sends it again with X-PAYMENT.{" "}
              {agentNotes({ premium: m.premium, artistUsd, setup }).join(" ")}
            </p>
          </>
        ) : (
          <p className="iv-agent-note">Pick a generator to see the request.</p>
        )}
        </div>
      </div>
    </div>
  );
}
