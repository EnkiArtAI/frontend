import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import {
  escrowAmounts,
  escrowRefund,
  escrowSettlement,
  settledEscrowRecovery,
  validateEscrowExpiry,
} from "../escrow-amounts";

// Fixture of an on-chain Config read, not an application default.
const configCap = 50_000_000;
const amounts = (count: number, treasury: number, artist: number, cap = configCap) =>
  escrowAmounts(count, treasury, artist, cap);

describe("escrow deposit amounts", () => {
  it("uses the stored split without adding a fee", () => {
    expect(amounts(4, 110_000, 20_000)).toEqual({
      units: 4, treasuryUnitMicro: 110_000, artistUnitMicro: 20_000, depositedMicro: 520_000,
    });
  });

  it.each([0, 25, -1, 1.5, NaN, Infinity])("refuses invalid units %s", (count) => {
    expect(() => amounts(count, 1, 0)).toThrow();
  });

  it.each([-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, Number("18446744073709551615")])(
    "refuses unrepresentable or invalid micro amounts %s", (amount) => {
      expect(() => amounts(1, amount, 0)).toThrow();
      expect(() => amounts(1, 0, amount)).toThrow();
    },
  );

  it("accepts the cap and all 24 batch units, and refuses zero or an oversized total", () => {
    expect(amounts(4, 12_500_000, 0).depositedMicro).toBe(configCap);
    expect(amounts(24, 1, 0).depositedMicro).toBe(24);
    expect(() => amounts(1, 0, 0)).toThrow();
    expect(() => amounts(4, 12_500_000, 1)).toThrow();
    expect(() => amounts(1, Number.MAX_SAFE_INTEGER, 1)).toThrow();
    expect(() => amounts(24, Number.MAX_SAFE_INTEGER, 0)).toThrow();
  });

  it("uses a changed Config cap without any second fixed limit", () => {
    expect(() => amounts(1, 2_000_000, 0, 1_000_000)).toThrow();
    expect(amounts(1, 60_000_000, 0, 60_000_000).depositedMicro).toBe(60_000_000);
    expect(() => amounts(1, 60_000_000, 0, configCap)).toThrow();
    for (const cap of [0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => amounts(1, 1, 0, cap)).toThrow();
    }
    expect(() => escrowAmounts(1, 1, 0, undefined as unknown as number)).toThrow();
  });

  it("uses a supplied chain clock and includes both TTL boundaries", () => {
    expect(() => validateEscrowExpiry(1_000, 1_600)).not.toThrow();
    expect(() => validateEscrowExpiry(1_000, 2_800)).not.toThrow();
    for (const expiry of [1_599, 2_801, 999, NaN, Infinity, 1_600.5]) {
      expect(() => validateEscrowExpiry(1_000, expiry)).toThrow();
    }
  });
});

describe("escrow settlement and refund amounts", () => {
  const deposit = amounts(4, 110_000, 20_000);

  it("charges one unit and refunds three failed units", () => {
    expect(escrowSettlement(deposit, 1, true)).toEqual({
      treasuryMicro: 110_000, artistMicro: 20_000, refundableMicro: 390_000,
    });
  });

  it("refunds everything when every unit fails", () => {
    expect(escrowSettlement(deposit, 0, true)).toEqual({
      treasuryMicro: 0, artistMicro: 0, refundableMicro: 520_000,
    });
  });

  it("refunds the artist leg when that ATA is missing or frozen", () => {
    expect(escrowSettlement(deposit, 4, false)).toEqual({
      treasuryMicro: 440_000, artistMicro: 0, refundableMicro: 80_000,
    });
  });

  it("settles a funded deposit above an older or later lowered Config cap", () => {
    expect(escrowSettlement(amounts(1, 60_000_000, 0, 60_000_000), 0, true)).toEqual({
      treasuryMicro: 0, artistMicro: 0, refundableMicro: 60_000_000,
    });
  });

  it("refuses a corrupt split or an invalid delivered count", () => {
    expect(() => escrowSettlement({ ...deposit, depositedMicro: 1 }, 1, true)).toThrow();
    for (const delivered of [-1, 5, 0.5, NaN, Infinity]) {
      expect(() => escrowSettlement(deposit, delivered, true)).toThrow();
      expect(() => settledEscrowRecovery(4, delivered, 1)).toThrow();
    }
  });

  it("charges no account-creation fee for an existing ATA", () => {
    expect(escrowRefund(600_000, true, 500_000)).toEqual({
      buyerMicro: 600_000, ataFeeMicro: 0, createBuyerAta: false,
    });
  });

  it("recreates a missing ATA only when the refund covers its fee", () => {
    expect(escrowRefund(600_000, false, 500_000)).toEqual({
      buyerMicro: 100_000, ataFeeMicro: 500_000, createBuyerAta: true,
    });
    expect(escrowRefund(500_000, false, 500_000)).toEqual({
      buyerMicro: 0, ataFeeMicro: 500_000, createBuyerAta: true,
    });
    expect(escrowRefund(499_999, false, 500_000)).toEqual({
      buyerMicro: 0, ataFeeMicro: 499_999, createBuyerAta: false,
    });
    expect(escrowRefund(0, false, 500_000).createBuyerAta).toBe(false);
    expect(escrowRefund(1, false, 0)).toEqual({ buyerMicro: 1, ataFeeMicro: 0, createBuyerAta: true });
    expect(() => escrowRefund(1, false, 1_000_001)).toThrow();
  });
});

describe("escrow Section 7 reservations", () => {
  it("books delivered units and releases failed units from the reservation", () => {
    expect(settledEscrowRecovery(4, 1, 37_500)).toEqual({ recoveredMicro: 37_500, releasedMicro: 112_500 });
    expect(settledEscrowRecovery(4, 0, 37_500)).toEqual({ recoveredMicro: 0, releasedMicro: 150_000 });
    expect(() => settledEscrowRecovery(24, 1, Number.MAX_SAFE_INTEGER)).toThrow();
  });

  it("conserves deposits, refunds and supplied reservations across 100,000 amount cases", () => {
    let seed = 123;
    const next = () => { seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0; return seed; };
    for (let i = 0; i < 100_000; i++) {
      const count = 1 + next() % 24;
      const treasury = next() % 400_000;
      const artist = 1 + next() % 400_000;
      const delivered = next() % (count + 1);
      const deposit = amounts(count, treasury, artist);
      const settlement = escrowSettlement(deposit, delivered, Boolean(next() % 2));
      assert.equal(settlement.treasuryMicro + settlement.artistMicro + settlement.refundableMicro, deposit.depositedMicro);
      assert.ok(settlement.refundableMicro >= 0);
      // The RPC already chose r; this helper only books k*r / releases (N-k)*r.
      const recoveryUnit = next() % 100_001;
      const booked = settledEscrowRecovery(count, delivered, recoveryUnit);
      assert.equal(booked.recoveredMicro + booked.releasedMicro, count * recoveryUnit);
      const refund = escrowRefund(settlement.refundableMicro, Boolean(next() % 2), next() % 1_000_001);
      assert.equal(refund.buyerMicro + refund.ataFeeMicro, settlement.refundableMicro);
    }
  });
});
