import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EscrowChain } from "../escrow/server-chain";
const mocks = vi.hoisted(() => ({ advance: vi.fn(), status: vi.fn(), retry: vi.fn(), expire: vi.fn() }));
vi.mock("../escrow/server-lifecycle", async importOriginal => ({ ...await importOriginal<typeof import("../escrow/server-lifecycle")>(), advanceGenerationEscrow: mocks.advance }));
vi.mock("../escrow/server-deposit", async importOriginal => ({ ...await importOriginal<typeof import("../escrow/server-deposit")>(),
  generationEscrowStatus: mocks.status, retrySubmittedGenerationEscrow: mocks.retry, expireUnfundedGenerationEscrow: mocks.expire,
}));
import { sweepGenerationEscrows } from "../escrow/server-sweep";
import { EscrowReconciliationError } from "../escrow/server-lifecycle";
const chain = { fixture: true } as unknown as EscrowChain;
const candidate = (id: string, state = "funded") => ({ intent_id: id, owner_wallet: "CaseExactOwner", deposit_state: state });
const fixture = (items: ReturnType<typeof candidate>[]) => {
  const rpc = vi.fn().mockResolvedValue({ data: items, error: null }); return { rpc, db: {rpc} as unknown as SupabaseClient };
};
beforeEach(() => { vi.clearAllMocks();
  mocks.status.mockResolvedValue({funded:true}); mocks.retry.mockResolvedValue({funded:false,state:"submitted"});
  mocks.expire.mockResolvedValue({state:"expired"}); mocks.advance.mockResolvedValue({batch:{state:"closed"}});
});
describe("bounded escrow reconciliation", () => {
  it("closes owned funded work, preserving canonical session identifiers", async () => {
    const f=fixture([candidate("payment-1")]); expect(await sweepGenerationEscrows(f.db,chain)).toEqual({checked:1,pending:0,closed:1,alerts:0});
    expect(mocks.advance).toHaveBeenCalledWith(f.db,chain,"payment-1","CaseExactOwner");
  });
  it("retries only a server-persisted deposit before its proof-based expiry check", async () => {
    const f=fixture([candidate("payment-1","submitted")]); expect(await sweepGenerationEscrows(f.db,chain)).toMatchObject({checked:1,closed:0,pending:0});
    expect(mocks.retry).toHaveBeenCalledWith(f.db,chain,"payment-1","CaseExactOwner");
    expect(mocks.expire).toHaveBeenCalledWith(f.db,chain,"payment-1","CaseExactOwner"); expect(mocks.advance).not.toHaveBeenCalled();
  });
  it("does not call an unconfirmed order funded or settled", async () => {
    mocks.status.mockResolvedValue({funded:false}); mocks.expire.mockResolvedValue({state:"prepared"});
    const f=fixture([candidate("payment-1","prepared")]); expect(await sweepGenerationEscrows(f.db,chain)).toMatchObject({pending:1,closed:0}); expect(mocks.advance).not.toHaveBeenCalled();
  });
  it("stops new work at the deadline and clamps query count", async () => {
    const clock=vi.spyOn(Date,"now").mockReturnValue(100);
    const f=fixture([candidate("payment-1")]); expect(await sweepGenerationEscrows(f.db,chain,200,100)).toMatchObject({checked:0});
    expect(f.rpc).toHaveBeenCalledWith("generation_escrow_work_items",{p_limit:50}); expect(mocks.status).not.toHaveBeenCalled(); clock.mockRestore();
  });
  it("alerts on a delivered-unit mismatch and still processes subsequent orders", async () => {
    mocks.advance.mockRejectedValueOnce(new EscrowReconciliationError("settled_units_mismatch"));
    const logs=vi.spyOn(console,"error").mockImplementation(()=>{}); const f=fixture([candidate("payment-1"),candidate("payment-2")]);
    expect(await sweepGenerationEscrows(f.db,chain)).toEqual({checked:2,pending:0,closed:1,alerts:1});
    expect(logs).toHaveBeenCalledWith("[escrow/reconcile]","settled_units_mismatch","payment-1"); logs.mockRestore();
  });
  it("does not put private RPC errors into monitoring output", async () => {
    mocks.status.mockRejectedValueOnce(new Error("https://rpc.invalid/secret")); const logs=vi.spyOn(console,"error").mockImplementation(()=>{});
    await sweepGenerationEscrows(fixture([candidate("payment-1")]).db,chain); expect(JSON.stringify(logs.mock.calls)).not.toContain("secret"); logs.mockRestore();
  });
  it("fails closed when the database cannot select candidates", async () => {
    const f=fixture([]); f.rpc.mockResolvedValue({data:null,error:{message:"private-secret"}});
    await expect(sweepGenerationEscrows(f.db,chain)).rejects.toThrow("Escrow candidates are unavailable."); expect(mocks.status).not.toHaveBeenCalled();
  });
});
