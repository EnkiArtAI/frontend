import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";
import { withCapabilities } from "@/lib/generation/models";

/**
 * /api/generate-free read no model and rendered Flux for whatever the caller
 * picked, so every client that guessed "free" from a price or a prompt type
 * handed a paid pick a Flux picture. It now runs the selected model, and only
 * if that model renders on the free host.
 */

const ROUTE = readSource(join(__dirname, "..", "..", "app", "api", "generate-free", "route.ts"));

describe("/api/generate-free runs the selected model", () => {
  it("resolves the model the request names, and nothing when it names none", () => {
    expect(ROUTE).toMatch(/const model = UUID_RE\.test\(String\(body\?\.modelId \?\? ""\)\)\n\s+\? await resolveModel\(getSupabaseServerClientSafe\(\), \[String\(body\.modelId\)\]\)\n\s+: null;/);
    expect(ROUTE).toMatch(/if \(!model\) \{\n\s+return NextResponse\.json\(/);
    expect(ROUTE).not.toMatch(/resolveModelByName|FLUX_FREE_MODEL|"Flux \(free\)"/);
  });

  it("refuses a paid model before moderation and before the provider is called", () => {
    const refuse = ROUTE.search(/if \(model\.normal\.provider !== "pollinations"\) \{/);
    expect(refuse).toBeGreaterThan(-1);
    expect(ROUTE.indexOf("await moderate(")).toBeGreaterThan(refuse);
    expect(ROUTE.indexOf("await generateImageWithPollinations(")).toBeGreaterThan(refuse);
  });

  it("renders the routed provider model at a tier the model has, and reports what ran", () => {
    expect(ROUTE).toMatch(/generateImageWithPollinations\(\n\s+prompt,\n\s+body\.aspectRatio \|\| '1:1',\n\s+resolution,\n\s+model\.normal\.providerModel,\n\s+\)/);
    expect(ROUTE).toMatch(/RESOLUTION_TIERS\.indexOf\(resolution\) > RESOLUTION_TIERS\.indexOf\(model\.maxResolution\)/);
    expect(ROUTE).toMatch(/model: model\.normal\.providerModel,/);
    expect(ROUTE).not.toMatch(/model: "flux"/);
  });
});

describe("the catalogue says which model is free", () => {
  const link = (role: string, key: string, model: string) => ({
    id: `${key}-${role}`, role, provider_model: model, active: true, priority: 10, applies_when: null,
    provider_id: key, providers: { id: key, key, audience: "public", active: true },
  });

  it("free means renders on the free host, never a price of zero", () => {
    const [flux, nano] = withCapabilities([
      { id: "f", name: "Flux (free)", price: 0, model_providers: [link("normal", "pollinations", "flux")] },
      { id: "n", name: "Nano Banana Pro", price: 0, model_providers: [link("normal", "wavespeed", "google/nano-banana-pro/text-to-image")] },
    ] as never);
    expect((flux as { free: boolean }).free).toBe(true);
    expect((nano as { free: boolean }).free).toBe(false);
  });
});
