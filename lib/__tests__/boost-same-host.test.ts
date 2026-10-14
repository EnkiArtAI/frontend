import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";
import { boostAt } from "@/hooks/useModelLimits";

/**
 * Boost is disabled, not hidden, at a size where the regular host is already
 * the boost host (Nano Banana 2 at 1K), and the hover text says why (Kev,
 * 2026-10-06). The flag then stays out of the quote and the generation.
 */
const src = (...p: string[]) => readSource(join(__dirname, "..", "..", ...p));

describe("boostAt", () => {
  it("answers per size from the catalogue's boostTiers", () => {
    const nb2 = { boostAvailable: true, boostTiers: ["2K", "4K"] as Array<"1K" | "2K" | "4K"> };
    expect(boostAt(nb2, "1K")).toBe(false);
    expect(boostAt(nb2, "2K")).toBe(true);
    expect(boostAt(nb2, "4K")).toBe(true);
    expect(boostAt({ boostAvailable: true, boostTiers: [] }, "2K")).toBe(false);
  });

  it("is never a choice without a model, and falls back to the model flag for an old catalogue answer", () => {
    expect(boostAt(undefined, "2K")).toBe(false);
    expect(boostAt(null, "2K")).toBe(false);
    expect(boostAt({ boostAvailable: true }, "1K")).toBe(true);
    expect(boostAt({ boostAvailable: false }, "1K")).toBe(false);
  });
});

describe("the toggle at a size with nothing to boost", () => {
  const toggle = src("components", "generation", "BoostToggle.tsx");

  it("is disabled, shows as off and says why on hover", () => {
    expect(toggle).toContain('const SAME_HOST = "Already on the fastest host at this size — nothing to speed up.";');
    expect(toggle).toContain("const on = boost && !sameHost;");
    expect(toggle).toContain("aria-checked={on}");
    expect(toggle).toContain("disabled={disabled || sameHost}");
    expect(toggle).toContain('className={\`enki-boost\${on ? " enki-boost--on" : ""} \${className}\`.trim()}');
    expect(toggle).toContain("sameHost\n          ? SAME_HOST\n          : boost");
    expect(toggle).toContain('aria-label={sameHost ? SAME_HOST : "Boost — run this model on its fastest host"}');
  });
});

describe("every generate surface", () => {
  const core = src("hooks", "useGenerationCore.ts");
  const editor = src("components", "prompt-editor", "GenerateBar.tsx");
  const launcher = src("components", "GenerateLauncher.tsx");
  const viewer = src("components", "image-view", "ImageViewDesktop.tsx");
  const modal = src("components", "EnkiMobileGenerateModal.tsx");

  it("asks the core per size, from the sizes the catalogue answer carries", () => {
    expect(core).toContain("boostAt: (tier) => boostAt(entry, tier),");
    const limits = src("hooks", "useModelLimits.ts");
    expect(limits).toContain("boostTiers: Array.isArray(r.boostTiers)");
    expect(limits).toContain('? r.boostTiers.filter((t): t is "1K" | "2K" | "4K" => t === "1K" || t === "2K" || t === "4K")');
  });

  it("shows no toggle for now (Kev, 2026-10-13: it will pick the cheapest or fastest host by itself later), the flag wired and off", () => {
    const mobile = src("components", "image-view", "ImageViewMobile.tsx");
    for (const s of [editor, viewer, mobile, modal]) expect(s).not.toContain("BoostToggle");
    expect(launcher).toContain("boostSameHost={!core.boostAt(resolution)}");
    // The flag still travels: a surface that turns it on later needs nothing else.
    expect(src("lib", "ui", "image-view", "setups.ts")).toContain("boost: c.boost && boostAt(model, c.resolution),");
    expect(src("components", "image-view", "useImageViewModel.ts")).toContain("const [boost, setBoost] = useState(false);");
  });

  it("keeps the flag out of quotes and generations at such a size", () => {
    expect(src("lib", "editor", "generate-checks.ts")).toContain("boost: picks.boost && boostAt(entry, resolution) && entry.boostAvailable === true,");
    expect(launcher.split("core.boostAt(tier) && boost")).toHaveLength(3);
    expect(src("lib", "ui", "image-view", "setups.ts")).toContain("boost: c.boost && boostAt(model, c.resolution),");
    for (const s of [editor, launcher, viewer]) expect(s).not.toMatch(/boostAvailable && boost|boost && !!m\\.boostAvailable/);
  });
});
