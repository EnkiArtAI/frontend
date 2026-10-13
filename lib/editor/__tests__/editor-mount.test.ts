import { describe, it, expect } from "vitest";
import { editorMount, editorOwner, type EditorMount } from "../editor-mount";

/** Which editor /editor shows: a new `n` is a fresh one (app/editor/page.tsx keys it by n). */
const at: EditorMount = { id: null, n: 3, own: null, user: "A" };

describe("editorMount", () => {
  it("keeps the same mount, the same object, while nothing changes", () => {
    expect(editorMount(at, null, "A")).toBe(at);
  });

  it("starts afresh for another ?id=, but keeps the editor its own first release moved there (R13)", () => {
    expect(editorMount(at, "p1", "A")).toEqual({ id: "p1", n: 4, own: null, user: "A" });
    const released = { ...at, own: "p1" };
    expect(editorMount(released, "p1", "A")).toEqual({ id: "p1", n: 3, own: null, user: "A" });
    expect(editorMount({ ...at, id: "p1", own: "p1" }, null, "A")).toEqual({ id: null, n: 4, own: null, user: "A" });
    expect(editorMount({ ...at, id: "p1" }, null, "A").n).toBe(4);
    expect(editorMount(at, "p1", null)).toEqual({ id: "p1", n: 4, own: null, user: "A" });
  });

  it("starts afresh for another account, whose drafts and jobs are its own (R15)", () => {
    expect(editorMount(at, null, "B")).toEqual({ id: null, n: 4, own: null, user: "B" });
    expect(editorMount({ ...at, own: "p9" }, null, "B").own).toBe("p9");
    expect(editorMount(at, "p1", "B").n).toBe(4);
  });

  it("a wallet connecting mid-session is not another account: the editor stays (Kev, 2026-10-13)", () => {
    // After a reload the wallet is not connected, so there is no wallet key; the first payment connects it.
    const before = editorOwner("u-1", null);
    const after = editorOwner("u-1", "CM9cDp9JtuvbzybkPx6FBxcTUqR2qqjaW5c4PvbEBL8E");
    expect(before).toBe("account:u-1");
    expect(after).toBe(before);
    const mount: EditorMount = { id: null, n: 3, own: null, user: before };
    expect(editorMount(mount, null, after)).toBe(mount);
    // Another account on the same wallet key is still another account.
    expect(editorMount(mount, null, editorOwner("u-2", "CM9cDp9JtuvbzybkPx6FBxcTUqR2qqjaW5c4PvbEBL8E")).n).toBe(4);
    // Without an account the wallet key is all there is; without either, nobody.
    expect(editorOwner(null, "0xabc")).toBe("0xabc");
    expect(editorOwner(null, null)).toBeNull();
  });

  it("keeps what was typed through a first sign-in, and through signing out and back in as the same account", () => {
    const anon = { ...at, user: null };
    expect(editorMount(anon, null, "A")).toEqual({ ...anon, user: "A" });
    expect(editorMount(anon, null, null)).toBe(anon);
    expect(editorMount(at, null, null)).toBe(at);
    expect(editorMount(editorMount(at, null, null), null, "A")).toBe(at);
  });
});
