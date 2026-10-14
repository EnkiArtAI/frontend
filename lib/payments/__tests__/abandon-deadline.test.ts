import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/** Escrow leases must outlive both the route and its concurrency slot. */
const ROOT = join(__dirname, "..", "..", "..");
const route = readSource(join(ROOT, "app", "api", "generate-image", "route.ts"));
const concurrency = readSource(join(ROOT, "lib", "generation", "concurrency.ts"));
const migration = readSource(join(ROOT, "migrations", "2026-10-12-escrow-unit-claims.sql"));
const number = (source: string, pattern: RegExp, name: string): number => {
  const value = source.match(pattern)?.[1];
  if (!value) throw new Error(`Missing ${name} in the current payment path`);
  return Number(value.replaceAll("_", ""));
};
const maxDurationMs = number(route, /export const maxDuration = ([0-9_]+);/, "route budget") * 1000;
const slotTtlMs = number(concurrency, /const SLOT_TTL_MS = ([0-9_]+);/, "concurrency lifetime");
const leaseMs = number(migration, /lease_expires_at=now\(\)\+interval '(\d+) seconds'/, "escrow unit lease") * 1000;
const admissionMs = number(migration, /v_deposit\.expires_at_seconds<=GREATEST\(p_chain_now_seconds,extract\(epoch FROM now\(\)\)::bigint\)\+(\d+)/, "funded admission headroom") * 1000;

describe("the active escrow payment budget ladder", () => {
  it("reads the actual route and SQL lease values", () => {
    expect(maxDurationMs).toBe(300_000);
    expect(slotTtlMs).toBe(330_000);
    expect(leaseMs).toBe(360_000);
    expect(admissionMs).toBe(420_000);
  });
  it("never expires a paid unit while the route can still deliver", () => {
    expect(maxDurationMs).toBeLessThan(slotTtlMs);
    expect(slotTtlMs).toBeLessThan(leaseMs);
  });
  it("requires at least a minute for settlement after the unit lease", () => {
    expect(admissionMs - leaseMs).toBeGreaterThanOrEqual(60_000);
  });
  it("waits for pending and running units before freezing the durable delivered count", () => {
    expect(migration).toMatch(/state IN \('pending','running'\)/);
    expect(migration).toMatch(/state='running' AND lease_expires_at<=now\(\)/);
    expect(migration).toMatch(/count\(\*\)[\s\S]{0,200}state='delivered'/);
  });
});
