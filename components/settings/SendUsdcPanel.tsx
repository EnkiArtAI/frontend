"use client";

import { useState } from "react";
import { Transaction } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { ArrowLeft, CheckCircle2, ExternalLink, Loader2 } from "lucide-react";

import { useCdpAddress } from "@/hooks/useCdpAddress";
import { refreshHoldings, useHoldings } from "@/hooks/useHoldings";
import { sessionAuthHeaders } from "@/lib/session-headers";
import { requestCdpSign } from "@/lib/cdp-bridge";
import {
  base64ToBytes,
  explorerTxUrl,
  formatMicro,
  isSolanaAddress,
  parseUsdcAmount,
  shortAddress,
  signingErrorMessage,
  withdrawErrorMessage,
} from "@/lib/send-usdc";

interface Built {
  requestId: string;
  transaction: string;
  amountMicro: number;
  to: string;
  from: string;
  chain?: string;
}

type Step =
  | { kind: "form" }
  | { kind: "review" }
  | { kind: "busy"; label: string }
  | { kind: "sent"; signature: string; amountMicro: number; to: string; explorer: string | null };

async function post(path: string, body: unknown) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { res, json };
}

/**
 * Send USDC from the user's own Enki wallet to any Solana address. The server
 * builds and co-signs the transaction (it pays the network fee), the user's
 * wallet signs it here, the server broadcasts it. Mounted in Settings >
 * Payment; standalone on purpose so the banned page can mount it too, a ban
 * never locks the user's own money.
 */
export default function SendUsdcPanel({ fromAddress, onSent }: { fromAddress: string; onSent?: (signature: string) => void }) {
  const { balance, ready } = useHoldings(fromAddress);
  const { address: cdpAddress } = useCdpAddress();
  const { publicKey: adapterKey, signTransaction: adapterSign } = useWallet();

  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [all, setAll] = useState(false);
  const [step, setStep] = useState<Step>({ kind: "form" });
  const [error, setError] = useState<string | null>(null);

  const toTrimmed = to.trim();
  const toValid = toTrimmed.length > 0 && isSolanaAddress(toTrimmed) && toTrimmed !== fromAddress;
  const amountMicro = all ? null : parseUsdcAmount(amount);
  const amountValid = all || amountMicro !== null;

  // The balance arrives as a float from /api/billing/balance; it is shown, never
  // sent. MAX asks the server for `all`, which reads the exact on-chain amount.
  const balanceText = balance.toFixed(6).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  const useMax = () => {
    setAmount(balanceText);
    setAll(true);
  };

  /** The signer that owns `from`; the server verifies exactly that key, so nothing else may sign. */
  const signerFor = (from: string): ((tx: string) => Promise<string>) | null => {
    if (cdpAddress === from) return requestCdpSign;
    if (adapterKey?.toBase58() === from && adapterSign) {
      return async (b64) => {
        const signed = await adapterSign(Transaction.from(base64ToBytes(b64)));
        return signed.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
      };
    }
    return null;
  };

  const send = async () => {
    setError(null);
    setStep({ kind: "busy", label: "Preparing the transfer" });
    try {
      const build = await post("/api/wallet/withdraw/build", all ? { to: toTrimmed, all: true } : { to: toTrimmed, amountMicro });
      if (!build.res.ok || !build.json?.transaction) {
        throw new Error(withdrawErrorMessage({ status: build.res.status, body: build.json }, "Could not prepare the transfer, nothing moved."));
      }
      const built = build.json as unknown as Built;
      if (built.from !== fromAddress) throw new Error("The signed in wallet is not the one shown here, reload and try again.");
      const sign = signerFor(built.from);
      if (!sign) throw new Error("Connect the wallet that holds this balance, or sign in with your Enki wallet, to sign the transfer.");

      setStep({ kind: "busy", label: "Waiting for your wallet to sign" });
      let signed: string;
      try {
        signed = await sign(built.transaction);
      } catch (e) {
        throw new Error(signingErrorMessage(e));
      }

      setStep({ kind: "busy", label: "Sending on the network" });
      const submit = await post("/api/wallet/withdraw/submit", { requestId: built.requestId, signedTransaction: signed });
      if (!submit.res.ok || typeof submit.json?.signature !== "string") {
        throw new Error(withdrawErrorMessage({ status: submit.res.status, body: submit.json }, "The transfer could not be sent."));
      }
      const signature = submit.json.signature;
      refreshHoldings();
      onSent?.(signature);
      setStep({ kind: "sent", signature, amountMicro: built.amountMicro, to: built.to, explorer: explorerTxUrl(built.chain, signature) });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong, nothing moved.");
      setStep({ kind: "review" });
    }
  };

  const reset = () => {
    setTo("");
    setAmount("");
    setAll(false);
    setError(null);
    setStep({ kind: "form" });
  };

  if (step.kind === "sent") {
    return (
      <div className="set-send">
        <div className="set-fiat-success">
          <CheckCircle2 size={40} className="set-fiat-success-icon" />
          <div className="set-fiat-success-title">Sent</div>
          <div className="set-fiat-success-sub">
            {formatMicro(step.amountMicro)} USDC went to <span title={step.to} className="set-send-mono">{shortAddress(step.to)}</span>.
          </div>
          {step.explorer ? (
            <a className="set-btn set-btn-outline" href={step.explorer} target="_blank" rel="noopener noreferrer">
              View on explorer <ExternalLink size={12} />
            </a>
          ) : (
            <div className="set-send-mono set-item-sub" title={step.signature}>Signature {shortAddress(step.signature)}</div>
          )}
          <button className="set-btn set-btn-dark" onClick={reset}>Send more</button>
        </div>
      </div>
    );
  }

  if (step.kind === "review" || step.kind === "busy") {
    const busy = step.kind === "busy";
    return (
      <div className="set-send">
        <div className="set-prov-head">
          <button className="set-back-btn" onClick={() => setStep({ kind: "form" })} aria-label="Back" disabled={busy}>
            <ArrowLeft size={15} />
          </button>
          <span className="set-holdings-label" style={{ marginBottom: 0 }}>Review</span>
        </div>
        <dl className="set-send-review">
          <dt>To</dt>
          <dd><span className="set-send-mono" title={toTrimmed}>{shortAddress(toTrimmed)}</span></dd>
          <dt>Amount</dt>
          <dd>{all ? `Your whole balance, ${balanceText} USDC` : `${formatMicro(amountMicro!)} USDC`}</dd>
          <dt>Network fee</dt>
          <dd>Enki pays the network fee</dd>
        </dl>
        {error && <div className="set-fiat-error">{error}</div>}
        <button className="set-btn set-btn-dark set-send-cta" onClick={send} disabled={busy}>
          {busy ? <><Loader2 size={14} className="set-spin" /> {step.label}</> : "Send now"}
        </button>
        <div className="set-footnote">Your wallet signs the transfer, so nothing moves without you. Transfers on Solana cannot be reversed, so check the address.</div>
      </div>
    );
  }

  return (
    <div className="set-send">
      <label className="set-send-field">
        <span className="set-holdings-label">To</span>
        <input
          className={"set-send-input" + (toTrimmed && !toValid ? " is-invalid" : "")}
          placeholder="Solana wallet address"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
        {toTrimmed && !toValid && (
          <span className="set-send-hint">{toTrimmed === fromAddress ? "That is your own wallet." : "Not a Solana wallet address."}</span>
        )}
      </label>
      <label className="set-send-field">
        <span className="set-holdings-label">Amount</span>
        <div className={"set-amount-wrap set-send-amount" + (amount && !amountValid ? " is-invalid" : "")}>
          <input
            className="set-amount-input"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => { setAmount(e.target.value); setAll(false); }}
          />
          <span className="set-amount-prefix">USDC</span>
          <button type="button" className="set-send-max" onClick={useMax} disabled={!ready || balance <= 0}>MAX</button>
        </div>
        <span className="set-send-hint">
          {!ready ? "Loading your balance" : `${balance.toFixed(2)} USDC available`}
        </span>
      </label>
      <button className="set-btn set-btn-dark set-send-cta" onClick={() => { setError(null); setStep({ kind: "review" }); }} disabled={!toValid || !amountValid}>
        Review
      </button>
    </div>
  );
}
