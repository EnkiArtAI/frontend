import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * /api/x402/generate is public (proxy.ts) and had no limit at all, while every
 * request carrying an X-PAYMENT header buys a metered prompt check
 * (Kev, 2026-10-06). The address is the only handle on an agent.
 */

const AGENT = readSource(join(__dirname, "..", "..", "app", "api", "x402", "generate", "route.ts"));
const FIRST = "  const limited = ipLimited(req);\n  if (limited) return limited;\n";

describe("the agent rail", () => {
  it("limits by address", () => {
    expect(AGENT).toMatch(/checkRequestRateLimit\(rateLimitKey\(req, "x402:ip"\), 60, 60_000\)/);
  });

  it("checks the limit before anything else, on GET and POST", () => {
    for (const method of ["GET", "POST"]) {
      const at = AGENT.indexOf(`export async function ${method}(req: NextRequest) {\n`);
      expect(at).toBeGreaterThan(-1);
      const body = AGENT.slice(at, AGENT.indexOf("\n}\n", at));
      expect(body.split("\n").slice(1, 3).join("\n") + "\n").toBe(FIRST);
    }
  });
});
