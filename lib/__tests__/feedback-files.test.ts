import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "./_read-source";
import { addFeedbackFiles } from "@/lib/feedback";

/**
 * The feedback form's own copy of the route's attachment rules (Kev,
 * 2026-10-08: the form takes 4 MB): a file that would be refused is named
 * when it is picked, not after the report is sent.
 */

const f = (type: string, bytes: number, name = "a") => new File([new Uint8Array(bytes)], name, { type });
const MB = 1048576;

describe("picking attachments for a feedback report", () => {
  it("takes the listed types up to 4 MB together, and names each file it leaves out", () => {
    const { files, refused } = addFeedbackFiles([f("image/png", 3 * MB, "kept.png")], [f("image/heic", 10, "photo.heic"), f("video/mp4", MB, "fits.mp4"), f("image/png", 1, "over.png")]);
    expect(files.map((x) => x.name)).toEqual(["kept.png", "fits.mp4"]);
    expect(refused).toEqual(["“photo.heic” is not a PNG, JPG, WebP, GIF, MP4, WebM or MOV file.", "“over.png” does not fit: attachments can be 4 MB in total."]);
  });

  it("stops at five, and refuses a prototype key as a type", () => {
    expect(addFeedbackFiles([], Array.from({ length: 6 }, (_, i) => f("image/png", 1, `${i}.png`))).refused).toEqual(["“5.png” is one too many: 5 attachments at most."]);
    expect(addFeedbackFiles([], [f("constructor", 1)]).files).toEqual([]);
  });

  it("is the rule the feedback modal applies, to the types the route keeps", () => {
    const modal = readSource(join(__dirname, "..", "..", "components", "enki-shell", "FeedbackModal.tsx"));
    expect(modal).toContain("const { files: next, refused } = addFeedbackFiles(files, picked);");
    expect(modal).toContain('if (refused.length) onToast(refused.join(" "));');
    expect(modal).toContain('accept={Object.keys(FEEDBACK_FILE_EXT).join(",")}');
    expect(modal).toContain("up to {FEEDBACK_MAX_BYTES / 1048576} MB in total");
  });
});
