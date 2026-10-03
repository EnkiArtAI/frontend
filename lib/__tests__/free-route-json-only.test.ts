import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * The free generator takes no account header, so a page on another site
 * could post a prompt in a visitor's name as a form or plain text, which a
 * browser sends without asking: each one cost a prompt check and could earn
 * the visitor's address warnings. Only JSON is taken now, and JSON from
 * another site has to ask first.
 */

const checked = vi.fn();
vi.mock("@/lib/moderation/prompt-check", async (orig) => ({
  ...(await orig<typeof import("@/lib/moderation/prompt-check")>()),
  checkPrompt: (...a: unknown[]) => checked(...a),
}));

import { POST } from "../../app/api/generate-free/route";

const send = (contentType: string | null, prompt = "an explicit request") => POST(new NextRequest("http://enki.test/api/generate-free", {
  method: "POST",
  headers: contentType ? { "Content-Type": contentType } : {},
  body: JSON.stringify({ prompt, modelId: "m1" }),
}));

describe("the free generator", () => {
  it("refuses a form or plain text before anything is checked", async () => {
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", null]) {
      expect((await send(type)).status).toBe(415);
    }
    expect(checked).not.toHaveBeenCalled();
  });

  it("takes JSON", async () => {
    // An empty prompt is refused right after the body is read: nothing further is called.
    const res = await send("application/json; charset=utf-8", "");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("prompt is required");
  });
});
