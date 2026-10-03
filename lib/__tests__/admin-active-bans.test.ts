import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * Suspensions from the warning ladder run out. The admin panel counted every
 * unlifted ban as active, so a user whose 3-day suspension had ended still
 * showed as banned, and a new ban was refused as "Already banned".
 */

const SRC = readSource(join(__dirname, "..", "..", "app", "api", "admin", "route.ts"));

describe("the admin panel's idea of an active ban", () => {
  it("leaves expired bans out of the list", () => {
    expect(SRC).toMatch(/\.is\("lifted_at", null\)\.or\(unexpired\(\)\)\.limit\(100\)/);
  });

  it("lets a new ban follow an expired one", () => {
    expect(SRC).toMatch(/\.eq\("user_id", targetId\)\.is\("lifted_at", null\)\.or\(unexpired\(\)\)\.limit\(1\);/);
  });
});
