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
  const editor = src("components", "EnkiPromptEditor.tsx");
  const launcher = src("components", "GenerateLauncher.tsx");
  const viewer = src("components", "PromptGeneratorView.tsx");
  const node = src("components", "enki-shell", "NodeCreator.tsx");
  const modal = src("components", "EnkiMobileGenerateModal.tsx");

  it("asks the core per size, from the sizes the catalogue answer carries", () => {
    expect(core).toContain("boostAt: (tier) => boostAt(entry, tier),");
    const limits = src("hooks", "useModelLimits.ts");
    expect(limits).toContain("boostTiers: Array.isArray(r.boostTiers)");
    expect(limits).toContain('? r.boostTiers.filter((t): t is "1K" | "2K" | "4K" => t === "1K" || t === "2K" || t === "4K")');
  });

  it("passes the size to the toggle", () => {
    expect(editor).toContain("sameHost={!boostAt(picked, genResolution)}");
    expect(viewer).toContain("sameHost={!core.boostAt(quoteResolution)}");
    expect(node).toContain("sameHost={!!selectedModel && !boostAt(selectedModel, tierFor(selectedModel))}");
    expect(launcher).toContain("boostSameHost={!core.boostAt(resolution)}");
    expect(modal).toContain("sameHost={boostSameHost}");
  });

  it("keeps the flag out of quotes and generations at such a size", () => {
    expect(editor).toContain("boost: boost && boostAt(m, genResolution),");
    expect(editor).toContain("boost: boost && boostAt(picked, genResolution),");
    expect(launcher.split("core.boostAt(tier) && boost")).toHaveLength(3);
    expect(viewer.split("core.boostAt(quoteResolution) && boost")).toHaveLength(4);
    expect(viewer).toContain("resolution: t, boost: core.boostAt(t) && boost, quality }))");
    expect(node).toContain("boost: boostRef.current && boostAt(picked, tier),");
    expect(node).toContain("boost: boost && boostAt(m, tier),");
    for (const s of [editor, launcher, viewer, node]) expect(s).not.toMatch(/boostAvailable && boost|boost && !!m\\.boostAvailable/);
  });
});
