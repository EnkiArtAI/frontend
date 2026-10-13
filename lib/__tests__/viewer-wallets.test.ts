import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The key the History rail reads a viewer's renders under. A wallet account
 * whose adapter has not reconnected after a reload (autoConnect is off) is
 * still signed in: its session address keys the history, or the rail showed
 * "No renders of this prompt yet" over a render made minutes before (Kev,
 * 2026-10-13: "warum zeigt meine history mein image nicht rechts an?").
 */
const w = vi.hoisted(() => ({
  evm: null as string | null,
  adapter: null as string | null,
  cdp: null as string | null,
  session: null as string | null,
}));
vi.mock("thirdweb/react", () => ({ useActiveAccount: () => (w.evm ? { address: w.evm } : undefined) }));
vi.mock("@solana/wallet-adapter-react", () => ({ useWallet: () => ({ publicKey: w.adapter ? { toBase58: () => w.adapter } : null }) }));
vi.mock("@/hooks/useCdpAddress", () => ({ useCdpAddress: () => ({ address: w.cdp }) }));
vi.mock("@/hooks/useSolanaAuth", () => ({ useSolanaAuth: () => ({ isAuthenticated: !!w.session, walletAddress: w.session }) }));

import { useViewerWallets } from "@/hooks/useViewerWallets";

const read = () => {
  let out: { userKey: string | null; payer: string | null } = { userKey: null, payer: null };
  const Probe = () => { out = useViewerWallets(); return null; };
  renderToStaticMarkup(createElement(Probe));
  return out;
};

beforeEach(() => { w.evm = null; w.adapter = null; w.cdp = null; w.session = null; });

describe("userKey", () => {
  it("is the signed-in session's address first, even with the adapter disconnected after a reload", () => {
    w.session = "CM9cSession";
    expect(read().userKey).toBe("CM9cSession");
    w.adapter = "AdapterKey";
    w.evm = "0xevm";
    w.cdp = "CdpKey";
    expect(read().userKey).toBe("CM9cSession");
  });

  it("falls back to the connected wallets, EVM then adapter then CDP, and to nothing", () => {
    expect(read().userKey).toBeNull();
    w.cdp = "CdpKey";
    expect(read().userKey).toBe("CdpKey");
    w.adapter = "AdapterKey";
    expect(read().userKey).toBe("AdapterKey");
    w.evm = "0xevm";
    expect(read().userKey).toBe("0xevm");
  });
});

describe("payer", () => {
  it("is the first Solana address: CDP, then the signed-in wallet, then the adapter, never an EVM one", () => {
    w.evm = "0xevm";
    expect(read().payer).toBeNull();
    w.adapter = "AdapterKey";
    expect(read().payer).toBe("AdapterKey");
    w.session = "CM9cSession";
    expect(read().payer).toBe("CM9cSession");
    w.cdp = "CdpKey";
    expect(read().payer).toBe("CdpKey");
  });
});
