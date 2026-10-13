import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import EditorHeader from "@/components/prompt-editor/EditorHeader";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * What only the Prompt Editor's components decide, pinned on their source:
 * the logic itself is tested in lib/editor; these say the editor calls it,
 * in the right place and order, and calls nothing else.
 */
const ROOT = join(__dirname, "..", "..", "..");
const DIR = join(ROOT, "components", "prompt-editor");
const src = (file: string) => readSource(join(DIR, file));
const all = readdirSync(DIR).filter((f) => /\.tsx?$/.test(f)).map((f) => [f, src(f)] as const);
const EDITOR = src("PromptEditor.tsx");
const CSS = src("prompt-editor.css");
const count = (text: string, needle: string) => text.split(needle).length - 1;

describe("the Prompt Editor's route", () => {
  it("renders the editor inside the shell and no longer Create Prompt 1 or its stylesheet (R1)", () => {
    const page = readSource(join(ROOT, "app", "editor", "page.tsx"));
    expect(page).toMatch(/<EnkiHome>\s*<PromptEditor key=\{mount\.n\} promptId=\{id \?\? undefined\}/);
    expect(page).not.toMatch(/EnkiPromptEditor|enki-editor\.css/);
  });

  it("keeps the editor when its own first release moves it to ?id=, and starts afresh for another id or account (R13, R15)", () => {
    const page = readSource(join(ROOT, "app", "editor", "page.tsx"));
    expect(page).toContain('const owner = userKey ?? (userId ? "account:" + userId : null);');
    expect(page).toContain('useState<EditorMount>({ id, n: 0, own: null, user: owner })');
    expect(page).toContain('const next = editorMount(mount, id, owner);');
    expect(page).toContain('if (next !== mount) setMount(next);');
    expect(page).toContain("onReleased={(own) => setMount((m) => ({ ...m, own }))}");
  });

  it("is a fixed layer below the 2FA bar, beside the menu, and over the phone's header and tab bar", () => {
    const root = /\n\.pe-root \{([^}]*)\}/.exec(CSS)?.[1] ?? "";
    for (const d of ["position: fixed;", "top: var(--ek-banner-h, 0px);", "left: var(--ek-sw);", "right: 0;", "bottom: 0;", "z-index: 140;"]) {
      expect(root).toContain(d);
    }
    expect(CSS).toMatch(/@media \(max-width: 767\.98px\) \{\n {2}\.pe-root \{ left: 0; z-index: 158; \}/);
  });

  it("on a phone, lets a shell panel (Add funds) sit between the shell's own header and tab bar", () => {
    const phone = /@media \(max-width: 767\.98px\) \{([\s\S]*?)\n\}/.exec(CSS)?.[1] ?? "";
    expect(phone).toContain(".ek-app:has(.ek-panel-scrim) .pe-root { z-index: 140; }");
  });
});

describe("test renders", () => {
  it("send the artist's own draft: the queue's request is editorRequest (authoring, no promptId), with the read-in references", () => {
    expect(EDITOR).toContain("toRequest: (s) => editorRequest(s, catalogue, readyRefs(state.refs, s.refIds) ?? []),");
    // No request of its own: nothing else builds one or calls the generation.
    for (const [file, text] of all) {
      expect(text, file).not.toContain("runGeneration");
      expect(text, file).not.toContain("GenerationRequest");
    }
  });

  it("check new orders before making jobs and resume signed payments without another quote (R12)", () => {
    const attempt = /const attempt = \([\s\S]*?\n {2}\};\n/.exec(EDITOR)?.[0] ?? "";
    expect(attempt).toMatch(
      /const block = generateBlock\(\{[\s\S]*\}\);\n\s*if \(block \|\| !entry\) \{\n\s*if \(block\) act\(block, from\);\n\s*return block \?\? \{ check: "generator" \};\n\s*\}[\s\S]*if \(job && from\.retry\) queue\.retry\(job\.id\);\n\s*else queue\.runBatch\(\[setup\]\);/,
    );
    // No other way to a job: one queue, and these two calls on it.
    for (const [file, text] of all) expect(count(text, "useRenderQueue<"), file).toBe(file === "PromptEditor.tsx" ? 1 : 0);
    expect(count(EDITOR, "queue.runBatch(")).toBe(1);
    expect(count(EDITOR, "queue.retry(")).toBe(2);
    const payment = attempt.slice(attempt.indexOf("if (job && from.retry && job.error?.payment)"), attempt.indexOf("const entry ="));
    expect(payment).toContain("queue.retry(job.id);");
    expect(payment).toContain("if (!signedIn)");
    expect(payment).toContain("readyRefs(state.refs, job.setup.refIds) === null");
    expect(payment).not.toContain("queue.runBatch(");
    expect(EDITOR).toContain("onPress: () => attempt({}),");
    expect(EDITOR).toContain("onTryAnyway={() => attempt(funds, true)}");
    expect(EDITOR).toContain("const stopped = attempt({ job, retry });");
  });
});

describe("release", () => {
  it("goes only through POST /api/prompt, with the body releaseBody or updateBody builds (release: true)", () => {
    const sent = /const send = async \(\{ body, refIds \}: \{ body: ReleaseBody; refIds: string\[\] \}\) => \{[\s\S]*?\n {2}\};\n/.exec(EDITOR)?.[0] ?? "";
    expect(sent).toMatch(/await fetch\("\/api\/prompt", \{\n\s*method: "POST",\n\s*headers: \{ "Content-Type": "application\/json", \.\.\.sessionAuthHeaders\(\) \},\n\s*body: JSON\.stringify\(body\),/);
    expect(EDITOR).toMatch(
      /\? \{ body: updateBody\(\{ listing, saved: loaded\.saved, id: loaded\.id, catalogue: models \}\), refIds: loaded\.doc\.refIds \}\n\s*: releaseBody\(\{ listing, starred: starredJobs, refs: state\.refs, id: id \?\? undefined, catalogue: models \}\);/,
    );
    expect(EDITOR).toContain("void send(made);");
    // Nothing else in the editor writes: Vary is useDiceRoll's, the rest reads.
    for (const [file, text] of all) expect(count(text, '"POST"'), file).toBe(file === "PromptEditor.tsx" ? 1 : 0);
  });

  it("updates the listing alone only when lib/editor/release listingOnly says so, for the listing as it is now", () => {
    expect(EDITOR).toContain("const updating = !!loaded && state.seeded === loaded.id && listingOnly(doc, listing, loaded, starredJobs.length);");
    expect(EDITOR).toContain("const verdict = releaseBlock({ listing, starred: starredJobs, loaded: updating ? loaded.doc : null, busy: releasing });");
  });

  it("keeps the server's stored references, so a later release never sends their data again (Kev)", () => {
    expect(EDITOR).toContain('dispatch({ type: "released", stored: storedRefs(refIds, data.referenceImages) });');
  });

  it("refreshes the Image View's copy of the prompt, which its owner may render from next", () => {
    expect(EDITOR).toContain("void queryClient.invalidateQueries({ queryKey: [`/api/prompts/${data.id}`] });");
    expect(EDITOR).toContain('void queryClient.invalidateQueries({ queryKey: ["prompt-public-images", data.id] });');
  });

  it("stays in the editor afterwards, re-keyed to /editor?id=, instead of leaving for /showcase (R13)", () => {
    expect(EDITOR).toMatch(/if \(!body\.id\) \{\n\s*store\.clear\(\);\n\s*if \(!mounted\.current\) return;\n\s*setReleasedId\(data\.id\);\n\s*onReleased\?\.\(data\.id\);\n\s*router\.replace\(`\/editor\?id=\$\{data\.id\}`\);/);
    for (const [file, text] of all) expect(text, file).not.toContain("/showcase");
  });

  it("never pulls the user back into an editor they left while the release was on its way", () => {
    expect(EDITOR).toMatch(/const mounted = useRef\(true\);\n\s*useEffect\(\(\) => \{\n\s*mounted\.current = true;\n\s*return \(\) => \{\n\s*mounted\.current = false;\n\s*\};\n\s*\}, \[\]\);/);
  });
});

describe("opening a released prompt", () => {
  it("tells a prompt that is not this account's from one that did not load, and offers to try again", () => {
    expect(src("usePromptLoad.ts")).toContain("const missing = refused && notYours((error as { status?: number }).status);");
    expect(src("usePromptLoad.ts")).toContain("if (!res.ok) throw Object.assign(new Error(`GET /api/prompt ${res.status}`), { status: res.status });");
    expect(EDITOR).toMatch(/editing && load\.failed \? \(\n\s*<div className="pe-state">\n\s*<p>Couldn&apos;t load this prompt\.<\/p>\n\s*<button type="button" className="pe-add kit-hit" onClick=\{load\.retry\}>Try again<\/button>/);
  });
});

describe("the + Variable pill", () => {
  it("is wired to making the variable from the checked selection, under a suggested name it selects for retyping", () => {
    expect(src("PromptField.tsx")).toContain("selectionPill={{ onCreate: onCreateVariable }}");
    expect(EDITOR).toContain("onCreateVariable={createVariable}");
    expect(EDITOR).toMatch(/const createVariable = \(range: VariableRange\) => \{\n\s*const name = suggestedName\(range\.name, varNames\(doc\.prompt\)\);\n\s*setSuggested\(\(s\) => new Set\(s\)\.add\(name\)\);[\s\S]*?field\?\.focus\(\);\n\s*field\?\.select\(\);[\s\S]*?commit\(variableFrom\(range, name\)\);\n {2}\};/);
  });

  it("shows the suggested name red until the row is edited or left", () => {
    expect(EDITOR).toContain("suggested={suggested} onNamed={named}");
    expect(src("VariableList.tsx")).toContain("suggested={suggested.has(name)}");
    expect(src("VariableList.tsx")).toContain("onNamed={() => onNamed(name)}");
    expect(src("VariableRow.tsx")).toContain('data-state={draft || issue ? "error" : suggested ? "suggested" : !name ? "unnamed" : undefined}');
    expect(src("VariableRow.tsx")).toMatch(/onBlur=\{\(\) => \{\n\s*setDraft\(null\);\n\s*onNamed\(\);\n\s*\}\}/);
    expect(src("prompt-editor.css")).toContain('.pe-var-name[data-state="suggested"] { color: var(--enki-danger); border-bottom-color: var(--enki-danger); }');
  });
});

describe("leaving while renders run", () => {
  it("asks first from Back, and the browser asks on a reload or close", () => {
    expect(EDITOR).toMatch(/const leave = \(\) => \{\n\s*if \(!rendering\) return router\.push\("\/home"\);\n\s*setAsk\(\{ text: leaveText\(rendering\), ok: "Leave", cancel: "Stay", run: \(\) => router\.push\("\/home"\) \}\);/);
    expect(EDITOR).toContain("onBack={leave}");
    expect(EDITOR).toMatch(/const busy = rendering > 0;\n\s*useEffect\(\(\) => \{\n\s*if \(!busy\) return;[\s\S]*?window\.addEventListener\("beforeunload", guard\);\n\s*return \(\) => window\.removeEventListener\("beforeunload", guard\);\n\s*\}, \[busy\]\);/);
  });

  it("says they are still charged and land in the gallery, not here", () => {
    expect(EDITOR).toContain("`${n} image${n === 1 ? \" is\" : \"s are\"} still rendering. They're still charged and saved to your gallery, but won't appear here. Leave?`");
  });
});

describe("the steps", () => {
  const header = (tabs: boolean) => renderToStaticMarkup(createElement(EditorHeader, {
    title: "", onTitle: () => {}, done: [true, false, false], active: 1, tab: "craft", onTab: () => {},
    tabs, panes: { craft: "pc", verify: "pv" }, rendering: 0, onBack: () => {},
  }));
  const release = /<span class="pe-step"[^>]*><span class="pe-step-badge" aria-hidden="true">3<\/span>Release<\/span>/;

  it("below 1024 px are two tabs, Craft and Verify, each controlling its pane; Release is a step, not a tab", () => {
    const html = header(true);
    expect(count(html, 'role="tablist"')).toBe(1);
    expect(count(html, 'role="tab"')).toBe(2);
    expect(html).toMatch(/<button type="button" role="tab" id="pc-tab" class="pe-step kit-hit"[^>]*aria-selected="true" aria-controls="pc">/);
    expect(html).toMatch(/<button type="button" role="tab" id="pv-tab" class="pe-step kit-hit"[^>]*aria-selected="false" aria-controls="pv">/);
    expect(html).toMatch(release);
    expect(html).toMatch(/<\/div><span class="pe-step"[^>]*>.*Release<\/span><\/div>/);
  });

  it("from 1024 px only show progress: nothing to press or tab to, the step reached marked current", () => {
    const html = header(false);
    expect(html).not.toMatch(/role="tab|aria-selected|aria-controls/);
    expect(count(html, "<button")).toBe(1);
    expect(html).toMatch(release);
    expect(html).toMatch(/<span class="pe-step" data-active="true" aria-current="step"><span class="pe-step-badge" aria-hidden="true">2<\/span>Verify<\/span>/);
    expect(count(html, "aria-current")).toBe(1);
  });

  it("the panes are the tabs' panels below 1024 px", () => {
    expect(EDITOR).toContain('const pane = (t: EditorTab): PaneProps => ({ id: panes[t], role: tabs ? "tabpanel" : undefined, "aria-labelledby": tabs ? `${panes[t]}-tab` : undefined });');
    expect(EDITOR).toContain('<div className="pe-craft" {...pane("craft")}>');
    expect(EDITOR).toContain('<VerifyPane pane={pane("verify")}');
    expect(src("VerifyPane.tsx")).toContain('<div className="pe-verify" data-wide={wide || undefined} {...pane}>');
  });
});

describe("touch, focus and motion", () => {
  it("gives every small button a 44 px hit area on a touch screen", () => {
    expect(src("LiveStrip.tsx")).toContain('className="pe-add kit-hit" onClick={onAll}>All results →');
    expect(src("PromptField.tsx")).toContain('className="pe-add pe-tabs-only kit-hit" onClick={onAddVariable}>+ Add variable');
    expect(src("VariableList.tsx")).toContain('className="pe-add pe-wide-only kit-hit" onClick={onAdd}>+ Add variable');
    expect(src("VariationGroup.tsx")).toContain('className="pe-load kit-hit"');
    expect(src("StackCard.tsx")).toContain('className="pe-tray-x kit-hit" onClick={onToggle}>Collapse');
    expect(src("ResultTile.tsx")).toContain('className="pe-tile-retry kit-hit"');
    expect(EDITOR).toContain('className="pe-add kit-hit" onClick={leave}>Back');
  });

  it("shows where the keyboard is in the fields that drop the kit's focus ring", () => {
    expect(CSS).toContain(".pe-title:focus-visible { box-shadow: inset 0 -2px 0 var(--enki-ember); }");
    expect(CSS).toContain(".pe-price:has(input:focus-visible) { border-color: var(--enki-ember); }");
    // Before the states, so an unnamed or wrong name keeps its colour and turns solid.
    expect(CSS).toMatch(/\.pe-var-name:focus-visible \{ border-bottom-style: solid; border-bottom-color: var\(--enki-ember\); \}\n\.pe-var-name\[data-state="unnamed"\]/);
  });

  it("stills the rolling dice for Reduce Motion", () => {
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\n\s*\.pe-vary\[data-rolling\] svg \{ animation: none; \}\n\}/);
  });
});

describe("the listing row (Kev, 2026-10-13)", () => {
  it("Open | Premium is a sliding switch, and the price has a slot that opens and closes beside it", () => {
    const row = src("ListingRow.tsx");
    expect(row).toContain('<Segmented slide role="radiogroup" ariaLabel="Listing"');
    expect(row).toContain('<span className="pe-price-slot" data-open={listing.mode === "premium" || undefined} inert={listing.mode !== "premium" || undefined}>');
    expect(CSS).toContain(".pe-price-slot[data-open] { grid-template-columns: 1fr; margin-right: 0; opacity: 1; }");
  });
});
