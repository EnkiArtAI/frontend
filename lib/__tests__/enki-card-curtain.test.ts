import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readSource } from "./_read-source";
import type { EnkiPrompt } from "@/lib/enkiPromptAdapter";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {} }) }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ prefetchQuery: () => Promise.resolve() }) }));
vi.mock("@/components/BetaGate", () => ({ useBetaAccess: () => ({ access: "ok", role: "user" }) }));
vi.mock("@/components/enki/EnkiDetailPanel", () => ({ preloadImageUI() {} }));
vi.mock("@/components/enki/BookmarkPicker", () => ({ default: () => null }));

import EnkiCard from "@/components/enki/EnkiCard";

const prompt = (before: string | null): EnkiPrompt => ({
  id: "p1",
  title: "Ember Split",
  description: "",
  artist: { id: "a1", name: "Nyx", handle: "nyx", avatar: "" },
  tags: [],
  price: 2,
  downloads: 0,
  rating: 0,
  likes: 0,
  isVideo: false,
  visibility: "full",
  art: { url: "https://cdn.example/after.webp", width: 1024, height: 1024, ratio: "1:1" },
  before,
  showcase: [],
  versions: [],
  variables: [],
  promptTemplate: "",
  model: "",
  publishedAt: "",
});

const render = (before: string | null) => renderToStaticMarkup(createElement(EnkiCard, { prompt: prompt(before) }));

/**
 * A curtain card takes focus for the arrow keys, so it must also be a real
 * keyboard control: named, announced as a button and openable with Enter or
 * Space. A plain card stays out of the tab order as before.
 */
describe("EnkiCard curtain host", () => {
  it("is a named, focusable button that says how to compare", () => {
    const html = render("https://cdn.example/before.webp");
    const article = html.match(/<article [^>]*>/)?.[0] ?? "";
    expect(article).toContain('role="button"');
    expect(article).toContain('tabindex="0"');
    expect(article).toContain('aria-label="Ember Split, press left or right to compare input and output"');
  });

  it("plain card: no role, label or tab stop, and its image loads lazily", () => {
    const html = render(null);
    const article = html.match(/<article [^>]*>/)?.[0] ?? "";
    expect(article).not.toContain("role=");
    expect(article).not.toContain("tabindex");
    expect(article).not.toContain("aria-label");
    expect(html).toMatch(/<img src="https:\/\/cdn\.example\/after\.webp"[^>]*loading="lazy"[^>]*decoding="async"/);
  });

  it("opens on Enter and Space, leaving the arrow keys to the curtain", () => {
    const src = readSource("components/enki/EnkiCard.tsx");
    const handler = src.match(/onKeyDown=\{prompt\.before \? \(event\) => \{([\s\S]*?)\} : undefined\}/)?.[1] ?? "";
    expect(handler).toContain('if (event.key !== "Enter" && event.key !== " ") return;');
    expect(handler).toContain("event.preventDefault();");
    expect(handler).toContain("onOpen?.(prompt);");
    expect(handler).not.toMatch(/Arrow/);
  });
});
