import { describe, it, expect, afterEach, vi } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";
import { hideAdult, mayShowAdult } from "@/lib/adult-content";
import { setPillActive, viewerHeaders } from "@/lib/session-headers";

/**
 * Other people's 18+ stays out of every read unless the viewer is a confirmed
 * adult with the pill on; owners always see their own (Kev, 2026-10-03).
 */

const anon = { userId: null, showAdult: false };
const member = { userId: "user-1", showAdult: false };
const adultOn = { userId: "user-1", showAdult: true };

function query() {
  const filters: [string, boolean][] = [];
  const q = { filters, eq: (c: string, v: boolean) => { filters.push([c, v]); return q; } };
  return q;
}

describe("who sees an 18+ row", () => {
  it("a confirmed adult with the pill on", () => {
    expect(mayShowAdult(adultOn, "someone-else")).toBe(true);
  });

  it("its owner", () => {
    expect(mayShowAdult(member, "user-1")).toBe(true);
  });

  it("not another member", () => {
    expect(mayShowAdult(member, "someone-else")).toBe(false);
  });

  it("not an anonymous visitor on a list without an owner", () => {
    expect(mayShowAdult(anon, null)).toBe(false);
    expect(mayShowAdult(anon)).toBe(false);
  });
});

describe("a read", () => {
  it("leaves 18+ out for someone who may not see it", () => {
    expect(hideAdult(query(), member, "someone-else").filters).toEqual([["is_adult", false]]);
  });

  it("is untouched for someone who may", () => {
    expect(hideAdult(query(), adultOn).filters).toEqual([]);
    expect(hideAdult(query(), member, "user-1").filters).toEqual([]);
  });
});

describe("the browser", () => {
  afterEach(() => { vi.unstubAllGlobals(); setPillActive(false); });
  const storage = (items: Record<string, string>) => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("localStorage", { getItem: (k: string) => items[k] ?? null });
  };

  it("sends the pill with the session once the sign-in check confirmed it", () => {
    storage({ enki_session_token: "tok" });
    setPillActive(true);
    expect(viewerHeaders()).toEqual({ "X-Session-Token": "tok", "X-Show-Adult": "1" });
  });

  it("does not send a stored pill the sign-in check has not confirmed", () => {
    storage({ enki_session_token: "tok", "enki:show-adult": "someone-else" });
    expect(viewerHeaders()).toEqual({ "X-Session-Token": "tok" });
  });

  it("shows the safe view without storage", () => {
    expect(viewerHeaders()).toEqual({});
  });
});

describe("the routes", () => {
  const ROOT = join(__dirname, "..", "..");
  const src = (...p: string[]) => readSource(join(ROOT, ...p));

  it("the feed and every artist shelf", () => {
    expect(src("app", "api", "marketplace", "prompts", "route.ts"))
      .toMatch(/dbQuery = hideAdult\(dbQuery, await viewer\(supabase, request\), creatorId\);/);
  });

  it("the showcase list, which has no pill", () => {
    expect(src("app", "api", "prompts", "route.ts")).toMatch(/\.eq\("is_listed", true\)\s*\.eq\("is_adult", false\)/);
  });

  it("one prompt answers not found", () => {
    const one = src("app", "api", "prompts", "[id]", "route.ts");
    expect(one).toMatch(/,is_adult"/);
    // Its creator, recognised like a save recognises them, still sees it.
    expect(one).toMatch(/if \(!prompt \|\| \(prompt\.is_adult && !mayShowAdult\(await viewer\(supabase, req\), prompt\.creator_id\) && !\(await owns\(prompt\.creator_id\)\)\)\) \{/);
    expect(one).toMatch(/const owns = async \(creatorId: unknown\) => \(\(await resolveOwnerIds\(supabase, token\)\) \?\? \[\]\)\.includes\(String\(creatorId\)\);/);
  });

  it("a creator's profile, open to its owner", () => {
    expect(src("app", "api", "creators", "[id]", "profile", "route.ts"))
      .toMatch(/\.limit\(20\),\s*await viewer\(supabase, request\),\s*userData\.id,\s*\);/);
  });

  it("link previews show the brand card", () => {
    for (const s of [src("app", "api", "og", "[id]", "route.tsx"), src("app", "generator", "[id]", "page.tsx")]) {
      expect(s).toMatch(/\.eq\("id", id\)\s*\.eq\("is_adult", false\)/);
    }
  });

  it("the client sends the pill and the session on every such read", () => {
    expect(src("lib", "queryClient.ts")).toMatch(/fetch\(url, \{\s*headers: viewerHeaders\(\),/);
    const profile = src("components", "profile", "ProfileView.tsx");
    expect(profile).toMatch(/fetch\(`\/api\/marketplace\/prompts\?\$\{params\.toString\(\)\}`, \{ headers: viewerHeaders\(\)/);
    expect(profile).toMatch(/fetch\(`\/api\/generations\?userId=\$\{encodeURIComponent\(galleryWallet\)\}&limit=50`, \{ headers: viewerHeaders\(\) \}\)/);
    expect(src("components", "PromptGeneratorView.tsx")).toMatch(/&limit=20`, \{ headers: viewerHeaders\(\) \}\)/);
    expect(src("app", "my-gallery", "page.tsx")).toMatch(/&limit=100`, \{ headers: viewerHeaders\(\) \}\)/);
  });
});
