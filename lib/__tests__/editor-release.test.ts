import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * Release in the prompt editor is a save that asks for the listing (Kev,
 * 2026-10-05: the artist lists a prompt when they want, once the checks have
 * passed). It used to save only a prompt without an id and then set a publish
 * date through PATCH, which listed nothing and judged nothing.
 */
const EDITOR = readSource(join(__dirname, "..", "..", "components", "EnkiPromptEditor.tsx"));
const release = EDITOR.slice(EDITOR.indexOf("const publishPromptMutation = useMutation({"), EDITOR.indexOf("const verifiedCount ="));

describe("releasing from the prompt editor", () => {
  it("always saves what is in the editor, asking the server to list it", () => {
    expect(release).toContain("const saved = await savePromptMutation.mutateAsync({ release: true });");
    // No release without that save: an id alone no longer skips it.
    expect(release).not.toMatch(/if \(!id\) \{\s*const saved = await savePromptMutation/);
  });

  it("sends the release with the save itself", () => {
    expect(EDITOR).toContain("mutationFn: async (opts?: { release?: boolean }) => {");
    expect(EDITOR).toContain("...(opts?.release ? { release: true } : {}),");
  });

  it("no longer marks a prompt published on the side", () => {
    expect(release).not.toContain("published: true");
    expect(release).not.toContain('method: "PATCH"');
  });

  it("shows the server's reason when the release is refused", () => {
    // The save throws the server's sentence, and the release passes it on.
    expect(release).toContain('description: error instanceof Error ? error.message : "Publish failed.",');
  });
});

describe("releasing from the mobile sheet", () => {
  const SHEET = readSource(join(__dirname, "..", "..", "components", "EnkiMobileGenerateModal.tsx"));
  const button = SHEET.slice(SHEET.lastIndexOf("<button", SHEET.indexOf("Release prompt")), SHEET.indexOf("Release prompt"));

  it("releases, and never starts a paid generation instead", () => {
    // Its button fell back to generating one image when no release was wired, and the editor wired none.
    expect(button).toContain("onClick={onRelease}");
    expect(button).not.toContain("onGenerate");
    expect(button).toContain("disabled={!releaseReady || !onRelease}");
  });

  it("is wired to the editor's one release", () => {
    const sheet = EDITOR.slice(EDITOR.indexOf("<EnkiMobileGenerateModal"));
    expect(sheet.slice(0, sheet.indexOf("/>"))).toContain("onRelease={handleReleaseClick}");
  });

  it("obeys the rules the desktop button is disabled by", () => {
    const click = EDITOR.slice(EDITOR.indexOf("const handleReleaseClick = () => {"), EDITOR.indexOf("const setSettingsSectionRef"));
    expect(click).toContain("if (publishPromptMutation.isPending) return;");
    const gate = click.slice(click.indexOf("if (verifiedCount === 0) {"), click.indexOf("if (hasSettingsErrors) {"));
    expect(gate).toContain('toast({ title: "No image yet"');
    expect(gate).toContain("return;");
    expect(click.indexOf("verifiedCount === 0")).toBeLessThan(click.indexOf("publishPromptMutation.mutate()"));
  });
});

describe("a prompt released as 18+", () => {
  it("tells its artist so, from the mark the save answers with", () => {
    expect(release).toContain("return { id, adult: (saved as { adult?: unknown }).adult === true };");
    expect(release).toContain("onSuccess: ({ adult }) => {");
    const said = release.slice(release.indexOf("description: adult"), release.indexOf("queryClient.invalidateQueries"));
    expect(said.indexOf("marked 18+")).toBeGreaterThan(-1);
    expect(said.indexOf("marked 18+")).toBeLessThan(said.indexOf("Prompt is now live on the marketplace."));
  });
});

describe("the draft after a release", () => {
  const reset = EDITOR.slice(EDITOR.indexOf("const resetEditor = useCallback(() => {"), EDITOR.indexOf("const handleNewPrompt = useCallback(() => {"));

  it("is ended: the editor is reset before it is left, so the next visit starts clean", () => {
    const success = release.slice(release.indexOf("onSuccess: ({ adult }) => {"), release.indexOf("onError:"));
    expect(success).toContain("resetEditor();");
    expect(success.indexOf("resetEditor();")).toBeLessThan(success.indexOf('router.push("/showcase");'));
  });

  it("is not ended by a release that was refused", () => {
    const refused = release.slice(release.indexOf("onError:"));
    expect(refused).not.toContain("resetEditor");
    expect(refused).not.toContain("handleNewPrompt");
  });

  it("loses its tie to the released prompt, its stored copy and its images", () => {
    expect(reset).toContain("currentPromptId: null,");
    expect(reset).toContain("localStorage.removeItem(EDITOR_DRAFT_KEY);");
    expect(reset).toContain("void clearEditorVersions();");
    expect(reset).toContain('setPromptData({ title: "", body: "", type: "free-prompt", tags: [] });');
    expect(reset).toContain("setVersions([]);");
    // The reset itself says nothing: "New prompt" is the Clear button's message, not a release's.
    expect(reset).not.toContain("toast(");
  });

  it("is what Clear still wipes, with its message", () => {
    const clear = EDITOR.slice(EDITOR.indexOf("const handleNewPrompt = useCallback(() => {"), EDITOR.indexOf("const [leaveConfirm, setLeaveConfirm] = useState(false);"));
    expect(clear.length).toBeLessThan(600);
    expect(clear).toContain("resetEditor();");
    expect(clear).toContain('toast({ title: "New prompt"');
  });

  it("is not tied to a prompt by the save itself any more", () => {
    // That tie (the id written into the stored draft) is what made the overwrite certain.
    expect(EDITOR).not.toContain("rememberDraftPromptId");
  });

  it("never carries a prompt's id, stored or restored", () => {
    // A draft an earlier build stored with an id came back tied to that prompt:
    // the next release rewrote it. Its text is still restored, untied.
    expect(EDITOR).not.toContain("draft.currentPromptId");
    expect(EDITOR).not.toContain("currentPromptId: ui.currentPromptId");
    const autosave = EDITOR.slice(EDITOR.indexOf("const draft: EditorDraft = {"), EDITOR.indexOf("localStorage.setItem(EDITOR_DRAFT_KEY, JSON.stringify(draft));"));
    expect(autosave.length).toBeGreaterThan(50);
    expect(autosave).not.toContain("currentPromptId");
    const restore = EDITOR.slice(EDITOR.indexOf("const draft = JSON.parse(raw) as EditorDraft;"), EDITOR.indexOf("draftReadyRef.current = true;"));
    expect(restore.length).toBeGreaterThan(50);
    expect(restore).not.toContain("currentPromptId");
  });
});

describe("the mobile sheet's settings", () => {
  const SHEET = readSource(join(__dirname, "..", "..", "components", "EnkiMobileGenerateModal.tsx"));
  const wired = EDITOR.slice(EDITOR.indexOf("<EnkiMobileGenerateModal"));
  const props = wired.slice(0, wired.indexOf("onAutoFill={handleGrokFill}"));

  it("are the editor's own title, type, category and price, which a release sends and checks", () => {
    // On a phone the sheet is the only place to fill them; it kept a private copy the release never read.
    expect(props).toContain("title={promptData.title}");
    expect(props).toContain("setTitle={(v) => setPromptData((prev) => ({ ...prev, title: v }))}");
    expect(props).toContain("promptType={promptData.type}");
    expect(props).toContain('setPromptData((prev) => ({ ...prev, type: v }));');
    expect(props).toContain("tags={promptData.tags}");
    expect(props).toContain("onAddTag={(t) => setPromptData((prev) => ({ ...prev, tags: [t.toLowerCase()] }))}");
    expect(props).toContain("onRemoveTag={removeTag}");
    expect(props).toContain("price={promptPrice}");
    expect(props).toContain("setPromptPrice(v);");
  });

  it("show and set the one model a release sends", () => {
    // The sheet's model list kept a private choice; the release sent the editor's.
    expect(props).toContain("onToggleModel={toggleModel}");
    expect(SHEET).toContain("const prefModels = onToggleModel ? models.selected : internalPrefModels;");
  });

  it("are read by the sheet where it has them, and only then its own", () => {
    expect(SHEET).toContain("const titleVal = title ?? localTitle;");
    expect(SHEET).toContain("const onTitle = setTitle ?? setLocalTitle;");
    expect(SHEET).toContain("const typeVal = promptType ?? localType;");
    expect(SHEET).toContain("const onType = setPromptType ?? setLocalType;");
    expect(SHEET).toContain("const tagsVal = tags ?? localTags;");
    expect(SHEET).toContain("const priceVal = price ?? localPrice;");
    expect(SHEET).toContain("const onPrice = setPrice ?? setLocalPrice;");
    // Before the sheet may return nothing: a hook after that return would break the sheet.
    expect(SHEET.indexOf("const [priceText, setPriceText] = useState")).toBeLessThan(SHEET.indexOf("if (!isOpen) return null;"));
  });

  it("take only the two prompt types the editor knows", () => {
    expect(props).toContain('if (v !== "free-prompt" && v !== "premium-prompt") return;');
  });

  it("offer the categories the desktop editor saves and the feed filters by", () => {
    expect(SHEET).toContain("const CATEGORY_OPTIONS = ENKI_CATEGORIES.map((label) => ({ value: label.toLowerCase(), label }));");
    expect(SHEET).toContain('import { ENKI_CATEGORIES } from "@/components/enki/EnkiFilters";');
  });
});

describe("a premium prompt's price in the editor", () => {
  // Kev, 2026-10-05: Premium starts at $0.07; the arrows count in cents; finer prices, down to $0.0001, are typed.
  it("starts at the default price on the desktop and in the sheet, and keeps one that is set", () => {
    expect(EDITOR).toContain('import { DEFAULT_PROMPT_PRICE_USD } from "@/shared/revenue-config";');
    expect(EDITOR.split("setPromptPrice((p) => p || DEFAULT_PROMPT_PRICE_USD);")).toHaveLength(3);
    const desktop = EDITOR.slice(EDITOR.indexOf('<div className="enk-mode-card__title">Premium prompt</div>') - 600, EDITOR.indexOf('<div className="enk-mode-card__title">Premium prompt</div>'));
    expect(desktop).toContain("setPromptPrice((p) => p || DEFAULT_PROMPT_PRICE_USD);");
    const sheet = EDITOR.slice(EDITOR.indexOf("setPromptType={(v) => {"), EDITOR.indexOf("tags={promptData.tags}"));
    expect(sheet).toContain('if (v !== "premium-prompt") return;');
    expect(sheet).toContain("setPromptPrice((p) => p || DEFAULT_PROMPT_PRICE_USD);");
  });

  it("is counted up and down in cents by the arrow buttons and the arrow keys", () => {
    expect(EDITOR).toContain("onClick={() => handlePriceStep(0.01)}");
    expect(EDITOR).toContain("onClick={() => handlePriceStep(-0.01)}");
    expect(EDITOR).toContain('handlePriceStep(e.key === "ArrowUp" ? 0.01 : -0.01);');
    expect(EDITOR).not.toContain("handlePriceStep(0.0001)");
    expect(EDITOR).not.toContain("handlePriceStep(-0.0001)");
  });

  it("can still be a typed price down to $0.0001", () => {
    const step = EDITOR.slice(EDITOR.indexOf("const handlePriceStep = useCallback("), EDITOR.indexOf("setPromptPrice(next);"));
    expect(step).toContain("0.0001,");
    expect(step).toContain("parseFloat((current + delta).toFixed(4))");
  });
});
