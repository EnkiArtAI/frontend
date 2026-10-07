import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { Connection, Keypair } from "@solana/web3.js";
import { PAYMENT_CHAINS } from "@/shared/payment-config";
import { getUsdcBalance } from "@/lib/usdc-balance";

/**
 * The balance a user sees is read on the chain payments settle on, over the
 * same RPC. The lookup resolved both itself and applied SOLANA_RPC_URL on
 * every chain, so a mainnet URL in a devnet deployment read every balance as
 * $0 (the RPC's 401 was swallowed) while payments went through the devnet RPC.
 */

const MAINNET_OVERRIDE = "https://mainnet.rpc.example/?api-key=x";
const WALLET = Keypair.generate().publicKey.toBase58();
let asked: string[];

beforeEach(() => {
  asked = [];
  // The RPC answers for whichever endpoint the lookup chose; nothing leaves the machine.
  vi.spyOn(Connection.prototype, "getTokenAccountBalance").mockImplementation(async function (this: Connection) {
    asked.push(this.rpcEndpoint);
    return { context: { slot: 1 }, value: { amount: "12500000", decimals: 6, uiAmount: 12.5, uiAmountString: "12.5" } };
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the balance lookup's RPC", () => {
  it("ignores a mainnet override on devnet and reads the chain's own RPC", async () => {
    vi.stubEnv("SOLANA_PAYMENT_CHAIN", "solana-devnet");
    vi.stubEnv("SOLANA_RPC_URL", MAINNET_OVERRIDE);
    expect(await getUsdcBalance(WALLET)).toBe(12.5);
    expect(asked).toEqual([PAYMENT_CHAINS["solana-devnet"].rpcUrl]);
  });

  it("uses the override on mainnet", async () => {
    vi.stubEnv("SOLANA_PAYMENT_CHAIN", "solana");
    vi.stubEnv("SOLANA_RPC_URL", MAINNET_OVERRIDE);
    expect(await getUsdcBalance(WALLET)).toBe(12.5);
    expect(asked).toEqual([MAINNET_OVERRIDE]);
  });

  it("reads zero for an address that is no wallet, without asking", async () => {
    vi.stubEnv("SOLANA_PAYMENT_CHAIN", "solana-devnet");
    expect(await getUsdcBalance("not-an-address")).toBe(0);
    expect(asked).toEqual([]);
  });
});
