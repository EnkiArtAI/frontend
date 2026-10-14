import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";
const src = (...path: string[]) => readSource(join(__dirname, "..", "..", "..", "..", ...path));

describe("Image View style loading", () => {
  it.each([
    ["components", "enki", "EnkiDetailPanel.tsx"],
    ["components", "PromptDetailModal.tsx"],
    ["app", "generator", "[id]", "GeneratorClient.tsx"],
  ])("keeps %s/%s on the frame styles until the view loads", (...path) => {
    const mount = src(...path);
    expect(mount).toContain("image-view-frame.css");
    expect(mount).not.toMatch(/import\s+["'][^"']*image-view\.css["']/);
  });
  it("loads the view's layout and phone styles with the Image View module", () => {
    const view = src("components", "image-view", "ImageView.tsx");
    expect(view).toContain('import "./image-view.css"');
    expect(view).toContain('import ImageViewMobile from "./ImageViewMobile"');
    expect(src("components", "image-view", "ImageViewMobile.tsx")).toContain('import "./image-view-mobile.css"');
  });
});
