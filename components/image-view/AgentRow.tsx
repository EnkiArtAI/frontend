"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, ChevronDown } from "lucide-react";
import { AGENT_PATH, agentBody, agentCurl, agentNotes, agentPrice, agentProbe } from "@/lib/ui/image-view/agent";
import { copyText, type ImageViewModel } from "./useImageViewModel";

/**
 * "Let your AI agent use this prompt": the request an agent sends to the
 * existing x402 route (plan §5 #22), the price it is told, and where its
 * render can differ from this page's. The price comes from the route itself:
 * the same body without X-PAYMENT answers 402 with it and settles nothing.
 * Asked only while the row is open, half a second after the settings rest.
 */
export default function AgentRow({ model: m }: { model: ImageViewModel }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const { setup } = m;
  const body = setup && agentBody(setup, m.variables);
  const asked = body && JSON.stringify(body);
  const [settled, setSettled] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => setSettled(asked), 500);
    return () => clearTimeout(t);
  }, [open, asked]);

  const probe = useQuery({
    queryKey: ["agent-price", settled],
    queryFn: async () => {
      const res = await fetch(AGENT_PATH, agentProbe(JSON.parse(settled as string)));
      return agentPrice(res.status, await res.json().catch(() => null));
    },
    enabled: open && !!settled && settled === asked,
    staleTime: 60_000,
  });
  const answer = settled === asked ? probe.data : undefined;
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
      {open && (
        setup && body ? (
          <>
            <pre className="iv-code">
              {`POST ${location.origin}${AGENT_PATH}\nContent-Type: application/json\nX-PAYMENT: <x402 payment payload>\n${JSON.stringify(body, null, 2)}\n→ 402 Payment Required · `}
              {answer ? ("price" in answer ? `${answer.price} per image` : "no price") : "…"}
              <button type="button" className="iv-code-copy" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
            </pre>
            <p className="iv-agent-note">
              Your agent calls the endpoint, gets a 402 with the price, pays per image in USDC on Solana and receives the render.{" "}
              {answer && "error" in answer ? `Agents can't use this prompt right now: ${answer.error}` : agentNotes({ premium: m.premium, artistUsd, setup }).join(" ")}
            </p>
          </>
        ) : (
          <p className="iv-agent-note">Pick a generator to see the request.</p>
        )
      )}
    </div>
  );
}
