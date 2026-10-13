import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readSource } from "./_read-source";

/**
 * The shell's menu is on screen every time (Kev, 2026-10-13: "the left side
 * bar must be there EVERY TIME"): every link to a prompt opens it as the feed
 * with the view over it (promptPage), never as the page of its own that
 * /generator/[id] used to be. And Analytics is the same page without a print
 * yet, every figure at 0, never a placeholder.
 */
const src = (...p: string[]) => readSource(join(__dirname, "..", "..", ...p));

describe("every link to a prompt", () => {
  it.each([
    ["app/leaderboard/page.tsx", "router.push(promptPage(id))"],
    ["components/enki-shell/NotificationsPanel.tsx", "router.push(promptPage(rec.id))"],
    ["components/enki-shell/NotificationsPanel.tsx", "router.push(promptPage(id))"],
    ["components/enki-shell/AnalyticsPanel.tsx", "router.push(promptPage(r.id))"],
    ["components/prompt-editor/PromptEditor.tsx", "router.push(promptPage(data.id))"],
  ])("%s opens it beside the menu", (file, call) => {
    const text = src(...file.split("/"));
    expect(text).toContain(call);
    expect(text).not.toMatch(/router\.(push|replace)\(`\/generator\//);
  });

  it("/generator/<id> itself goes on to the feed, keeping only its link-preview head", () => {
    const client = src("app", "generator", "[id]", "GeneratorClient.tsx");
    expect(client).toContain("router.replace(promptPage(id));");
    expect(client).not.toContain("<ImageView");
    // The head is still served for the bots that unfurl a pasted link.
    expect(src("app", "generator", "[id]", "page.tsx")).toContain("export async function generateMetadata(");
  });
});

describe("Analytics without a print", () => {
  it("shows the dashboard at 0, never a placeholder", () => {
    const panel = src("components", "enki-shell", "AnalyticsPanel.tsx");
    expect(panel).not.toContain("Nothing to chart yet");
    expect(panel).not.toContain("hasAny");
    // Loading and failure are the only other states; data, however empty, draws the cards.
    expect(panel).toMatch(/\) : !data \? \([^]*?\) : \(\n\s*<>\n/);
    expect(panel).toContain('<StatCard label="Prints" value={(st?.prints ?? 0).toLocaleString("en-US")}');
  });
});
