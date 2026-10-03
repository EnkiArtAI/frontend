import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import {
  escrowAmounts,
  escrowRecovery,
  escrowRefund,
  escrowSettlement,
  settledEscrowRecovery,
  validateEscrowExpiry,
} from "../escrow-amounts";

describe("escrow deposit amounts", () => {
  it("uses the stored split without adding a fee", () => {
    expect(escrowAmounts(4, 110_000, 20_000)).toEqual({
      units: 4, treasuryUnitMicro: 110_000, artistUnitMicro: 20_000, depositedMicro: 520_000,
    });
  });

  it.each([0, 25, -1, 1.5, NaN, Infinity])("refuses invalid units %s", (count) => {
    expect(() => escrowAmounts(count, 1, 0)).toThrow();
  });

  it.each([-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, Number("18446744073709551615")])(
    "refuses unrepresentable or invalid micro amounts %s", (amount) => {
      expect(() => escrowAmounts(1, amount, 0)).toThrow();
      expect(() => escrowAmounts(1, 0, amount)).toThrow();
    },
  );

  it("accepts the cap and all 24 batch units, and refuses zero or an oversized total", () => {
    expect(escrowAmounts(1, 25_000_000, 0).depositedMicro).toBe(25_000_000);
    expect(escrowAmounts(24, 1, 0).depositedMicro).toBe(24);
    expect(() => escrowAmounts(1, 0, 0)).toThrow();
    expect(() => escrowAmounts(4, 6_250_000, 1)).toThrow();
    expect(() => escrowAmounts(1, Number.MAX_SAFE_INTEGER, 1)).toThrow();
    expect(() => escrowAmounts(24, Number.MAX_SAFE_INTEGER, 0)).toThrow();
  });

  it("allows a tighter configured cap but never expands the hard cap", () => {
    expect(() => escrowAmounts(1, 2_000_000, 0, 1_000_000)).toThrow();
    expect(() => escrowAmounts(1, 1, 0, 25_000_001)).toThrow();
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
  const amounts = escrowAmounts(4, 110_000, 20_000);

  it("charges one unit and refunds three failed units", () => {
    expect(escrowSettlement(amounts, 1, true)).toEqual({
      treasuryMicro: 110_000, artistMicro: 20_000, refundableMicro: 390_000,
    });
  });

  it("refunds everything when every unit fails", () => {
    expect(escrowSettlement(amounts, 0, true)).toEqual({
      treasuryMicro: 0, artistMicro: 0, refundableMicro: 520_000,
    });
  });

  it("refunds the artist leg when that ATA is missing or frozen", () => {
    expect(escrowSettlement(amounts, 4, false)).toEqual({
      treasuryMicro: 440_000, artistMicro: 0, refundableMicro: 80_000,
    });
  });

  it("refuses a corrupt split or an invalid delivered count", () => {
    expect(() => escrowSettlement({ ...amounts, depositedMicro: 1 }, 1, true)).toThrow();
    for (const delivered of [-1, 5, 0.5, NaN, Infinity]) {
      expect(() => escrowSettlement(amounts, delivered, true)).toThrow();
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
  const ledger = { units: 4, artistUnitMicro: 100_000, frontedTotalMicro: 150_000,
    outstandingMicro: 150_000, reservedMicro: 0 };

  it("reserves debt across the full batch so another open intent cannot recover it", () => {
    const first = escrowRecovery(ledger);
    expect(first).toEqual({ unitRecoveryMicro: 37_500, reserveMicro: 150_000 });
    expect(escrowRecovery({ ...ledger, reservedMicro: first.reserveMicro })).toEqual({
      unitRecoveryMicro: 0, reserveMicro: 0,
    });
  });

  it("floors unreserved debt per unit and leaves odd micro amounts for the artist", () => {
    expect(escrowRecovery({ ...ledger, artistUnitMicro: 5 })).toEqual({
      unitRecoveryMicro: 2, reserveMicro: 8,
    });
    expect(escrowRecovery({ ...ledger, outstandingMicro: 15, reservedMicro: 4 })).toEqual({
      unitRecoveryMicro: 2, reserveMicro: 8,
    });
  });

  it("keeps the original instalment rather than a quarter of the remaining debt", () => {
    expect(escrowRecovery({ ...ledger, units: 1, outstandingMicro: 112_500 })).toEqual({
      unitRecoveryMicro: 37_500, reserveMicro: 37_500,
    });
    expect(escrowRecovery({ ...ledger, outstandingMicro: -1 }).reserveMicro).toBe(0);
  });

  it("books delivered units and releases failed units from the reservation", () => {
    expect(settledEscrowRecovery(4, 1, 37_500)).toEqual({ recoveredMicro: 37_500, releasedMicro: 112_500 });
    expect(settledEscrowRecovery(4, 0, 37_500)).toEqual({ recoveredMicro: 0, releasedMicro: 150_000 });
    expect(() => settledEscrowRecovery(24, 1, Number.MAX_SAFE_INTEGER)).toThrow();
  });

  it("conserves funds and bounds recovery across 100,000 deterministic amount cases", () => {
    let seed = 123;
    const next = () => { seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0; return seed; };
    for (let i = 0; i < 100_000; i++) {
      const count = 1 + next() % 24;
      const treasury = next() % 400_000;
      const artist = 1 + next() % 400_000;
      const delivered = next() % (count + 1);
      const deposit = escrowAmounts(count, treasury, artist);
      const settlement = escrowSettlement(deposit, delivered, Boolean(next() % 2));
      assert.equal(settlement.treasuryMicro + settlement.artistMicro + settlement.refundableMicro, deposit.depositedMicro);
      assert.ok(settlement.refundableMicro >= 0);
      const debt = next() % 150_001;
      const reserved = next() % 150_001;
      const recovery = escrowRecovery({ units: count, artistUnitMicro: artist,
        frontedTotalMicro: 150_000, outstandingMicro: debt, reservedMicro: reserved });
      assert.ok(recovery.unitRecoveryMicro <= Math.floor(artist / 2));
      assert.ok(recovery.reserveMicro <= Math.max(0, debt - reserved));
      const booked = settledEscrowRecovery(count, delivered, recovery.unitRecoveryMicro);
      assert.equal(booked.recoveredMicro + booked.releasedMicro, recovery.reserveMicro);
      const refund = escrowRefund(settlement.refundableMicro, Boolean(next() % 2), next() % 1_000_001);
      assert.equal(refund.buyerMicro + refund.ataFeeMicro, settlement.refundableMicro);
    }
  });
});
