import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Download and share (components/kit/share): the order each falls back in,
 * that a dismissed share sheet ends it silently, and what is said.
 */
const notify = vi.hoisted(() => vi.fn());
vi.mock("@/components/kit/notify", () => ({ notify }));
import { downloadImage, shareImage, shareWithLink } from "@/components/kit/share";

const IMG = "https://cdn.example/a.webp";
const PAGE = "https://enki.art/generator/p1";
const png = () => new Response(new Blob(["x"], { type: "image/png" }));
const fail = (name: string) => Object.assign(new Error(name), { name });

let share: ReturnType<typeof vi.fn>;
let writeText: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;

/** A browser: `files` says whether it can share files, `sheet` whether it has a share sheet at all. */
function browser({ files, sheet }: { files: boolean; sheet: boolean }) {
  share = vi.fn(async () => {});
  writeText = vi.fn(async () => {});
  fetchMock = vi.fn(async () => png());
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("navigator", {
    clipboard: { writeText },
    ...(sheet ? { share, canShare: (d: { files?: File[] }) => files && !!d.files?.length } : {}),
  });
}

beforeEach(() => notify.mockClear());
afterEach(() => vi.unstubAllGlobals());

describe("download", () => {
  it("saves the original under the title, its number and the extension its type names", async () => {
    browser({ files: false, sheet: false });
    const a = { href: "", download: "", click: vi.fn(), remove: vi.fn() };
    const append = vi.fn();
    vi.stubGlobal("document", { createElement: () => a, body: { append } });
    const open = vi.fn();
    vi.stubGlobal("window", { open });
    vi.useFakeTimers();
    await downloadImage(IMG, "Misty Harbor", 3);
    vi.useRealTimers();
    expect(fetchMock).toHaveBeenCalledWith(IMG);
    expect(a.download).toBe("misty-harbor-3.png");
    expect(a.href).toMatch(/^blob:/);
    expect(append).toHaveBeenCalledWith(a);
    expect(a.click).toHaveBeenCalledOnce();
    expect(a.remove).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("opens the image in a new tab when its host will not hand the bytes over", async () => {
    for (const answer of [async () => { throw new TypeError("cors"); }, async () => new Response("no", { status: 403 })]) {
      browser({ files: false, sheet: false });
      vi.stubGlobal("fetch", vi.fn(answer));
      const open = vi.fn();
      vi.stubGlobal("window", { open });
      const createElement = vi.fn();
      vi.stubGlobal("document", { createElement });
      notify.mockClear();
      await downloadImage(IMG, "t", 1);
      expect(open).toHaveBeenCalledWith(IMG, "_blank", "noopener");
      expect(createElement).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledWith("Opened in a new tab");
    }
  });
});

describe("share image", () => {
  it("shares the file itself where the browser can", async () => {
    browser({ files: true, sheet: true });
    await shareImage(IMG);
    expect(share).toHaveBeenCalledOnce();
    const [data] = share.mock.calls[0] as [{ files: File[]; url?: string }];
    expect(data.files[0]).toBeInstanceOf(File);
    expect(data.files[0].type).toBe("image/png");
    expect(data.url).toBeUndefined();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("shares the link when files cannot go, then copies it when there is no share sheet", async () => {
    browser({ files: false, sheet: true });
    await shareImage(IMG);
    expect(share.mock.calls).toEqual([[{ url: IMG }]]);
    expect(writeText).not.toHaveBeenCalled();

    browser({ files: false, sheet: false });
    await shareImage(IMG);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith(IMG);
    expect(notify).toHaveBeenCalledWith("Image link copied");
  });

  it("stops without a word when the user dismisses the share sheet", async () => {
    browser({ files: true, sheet: true });
    share.mockRejectedValue(fail("AbortError"));
    await shareImage(IMG);
    expect(share).toHaveBeenCalledOnce();
    expect(writeText).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("falls through to the next way when one fails for another reason", async () => {
    browser({ files: true, sheet: true });
    share.mockRejectedValueOnce(fail("NotAllowedError"));
    await shareImage(IMG);
    expect(share).toHaveBeenCalledTimes(2);
    expect(share.mock.calls[1]).toEqual([{ url: IMG }]);
  });

  it("says a render the store missed has no link yet, and shares nothing", async () => {
    browser({ files: false, sheet: true });
    await shareImage("data:image/webp;base64,AA==");
    expect(share).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("This image has no link yet");
  });

  it("says so when every way failed", async () => {
    browser({ files: false, sheet: false });
    writeText.mockRejectedValue(fail("NotAllowedError"));
    await shareImage(IMG);
    expect(notify).toHaveBeenCalledWith("Couldn't share this image");
  });
});

describe("share image + prompt", () => {
  it("sends the file with the prompt's page where it can, else the page alone", async () => {
    browser({ files: true, sheet: true });
    await shareWithLink(IMG, PAGE, "Misty");
    const [data] = share.mock.calls[0] as [{ title: string; text: string; url: string; files: File[] }];
    expect(data).toMatchObject({ title: "Misty", text: "Misty on Enki Art", url: PAGE });
    expect(data.files).toHaveLength(1);

    browser({ files: false, sheet: true });
    await shareWithLink(IMG, PAGE, "Misty");
    expect(share.mock.calls).toEqual([[{ title: "Misty", text: "Misty on Enki Art", url: PAGE }]]);
  });

  it("copies both links without a share sheet, and the page alone for a render with no link", async () => {
    browser({ files: false, sheet: false });
    await shareWithLink(IMG, PAGE, "Misty");
    expect(writeText).toHaveBeenCalledWith(`${IMG}\n${PAGE}`);
    expect(notify).toHaveBeenCalledWith("Image and prompt link copied");

    browser({ files: false, sheet: false });
    notify.mockClear();
    await shareWithLink("data:image/webp;base64,AA==", PAGE, "Misty");
    expect(writeText).toHaveBeenCalledWith(PAGE);
    expect(notify).toHaveBeenCalledWith("Link copied");
  });

  it("stops without a word when the user dismisses the share sheet", async () => {
    browser({ files: false, sheet: true });
    share.mockRejectedValue(fail("AbortError"));
    await shareWithLink(IMG, PAGE, "Misty");
    expect(writeText).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});
