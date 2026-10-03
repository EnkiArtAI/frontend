import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { checkPrompt, textValues, PROMPT_CHECK_MODEL, PROMPT_CHECK_INSTRUCTION } from "@/lib/moderation/prompt-check";

/**
 * The prompt check judges what a prompt asks for before anything is made:
 * extraction of a hidden prompt, sexual content with minors, explicit sexual
 * content. No call ever goes out here: fetch is stubbed, the key is a
 * placeholder.
 */

const INPUT = { subject: "something" };

function answer(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const scored = (p: { extraction?: number; minor_sexual?: number; explicit_sexual?: number }) =>
  answer({ choices: [{ message: { content: JSON.stringify({ extraction: 0, minor_sexual: 0, explicit_sexual: 0, ...p }) } }] });

beforeEach(() => vi.stubEnv("OPENAI_API_KEY", "test-key-not-a-real-one"));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("the prompt check", () => {
  it("calls nothing when there is no text", async () => {
    const fetchMock = scored({});
    expect(await checkPrompt({}, { hidden: true })).toEqual({ verdict: "clear" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lets a clean prompt through", async () => {
    scored({ extraction: 0.1, minor_sexual: 0.05, explicit_sexual: 0.2 });
    expect(await checkPrompt(INPUT, { hidden: true })).toEqual({ verdict: "clear" });
  });

  it("reports a confident extraction attempt on a hidden prompt", async () => {
    scored({ extraction: 0.9 });
    expect(await checkPrompt(INPUT, { hidden: true })).toEqual({ verdict: "extraction", confidence: 0.9 });
  });

  it("ignores extraction on an own prompt, which hides nothing", async () => {
    scored({ extraction: 0.95 });
    expect(await checkPrompt(INPUT, { hidden: false })).toEqual({ verdict: "clear" });
  });

  it("reports an explicit request", async () => {
    scored({ explicit_sexual: 0.8 });
    expect(await checkPrompt(INPUT, { hidden: false })).toEqual({ verdict: "explicit_sexual", confidence: 0.8 });
  });

  it("reports a child-safety request", async () => {
    scored({ minor_sexual: 0.75 });
    expect(await checkPrompt(INPUT, { hidden: false })).toEqual({ verdict: "minor_sexual", confidence: 0.75 });
  });

  it("puts a child-safety finding before every other", async () => {
    scored({ extraction: 0.99, minor_sexual: 0.8, explicit_sexual: 0.99 });
    expect(await checkPrompt(INPUT, { hidden: true })).toMatchObject({ verdict: "minor_sexual" });
  });

  it("puts an explicit finding before extraction", async () => {
    scored({ extraction: 0.99, explicit_sexual: 0.8 });
    expect(await checkPrompt(INPUT, { hidden: true })).toMatchObject({ verdict: "explicit_sexual" });
  });

  it("lets a doubtful score through", async () => {
    scored({ explicit_sexual: 0.69 });
    expect(await checkPrompt(INPUT, { hidden: false })).toEqual({ verdict: "clear" });
  });

  it("reports itself unavailable when the API fails", async () => {
    answer({ error: "overloaded" }, 503);
    expect(await checkPrompt(INPUT, { hidden: true })).toMatchObject({ verdict: "unavailable" });
  });

  it("reports itself unavailable on an answer outside the schema", async () => {
    answer({ choices: [{ message: { content: JSON.stringify({ extraction: 0 }) } }] });
    expect(await checkPrompt(INPUT, { hidden: true })).toMatchObject({ verdict: "unavailable" });
  });

  it("reports itself unavailable without a key", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEYS", "");
    expect(await checkPrompt(INPUT, { hidden: true })).toMatchObject({ verdict: "unavailable" });
  });
});

describe("what the check sends", () => {
  async function sent() {
    const fetchMock = scored({});
    await checkPrompt(INPUT, { hidden: true });
    return JSON.parse(String(((fetchMock.mock.calls[0] as unknown[])[1] as RequestInit).body));
  }

  it("asks the cheap model with no reasoning and no stored state", async () => {
    expect(await sent()).toMatchObject({ model: PROMPT_CHECK_MODEL, reasoning_effort: "none", store: false });
  });

  it("forces three probabilities into a strict schema", async () => {
    const { response_format } = await sent();
    expect(response_format).toMatchObject({ type: "json_schema", json_schema: { strict: true } });
    expect(response_format.json_schema.schema.required).toEqual(["extraction", "minor_sexual", "explicit_sexual"]);
  });

  it("puts the instruction in the system message and the text in the user message as data", async () => {
    const { messages } = await sent();
    expect(messages[0]).toEqual({ role: "system", content: PROMPT_CHECK_INSTRUCTION });
    expect(JSON.parse(messages[1].content)).toEqual({ inputs: INPUT });
  });

  it("tells the model that nudity alone is not explicit", () => {
    expect(PROMPT_CHECK_INSTRUCTION).toMatch(/Nudity on its own, swimwear, lingerie, a provocative pose or a kiss are not explicit/);
  });

  it("names coded terms for minors", () => {
    expect(PROMPT_CHECK_INSTRUCTION).toMatch(/loli or shota/);
  });
});

describe("which values are judged", () => {
  it("keeps only non-empty text", () => {
    expect(textValues({ a: "fox", b: "", c: 5, d: "  ", e: "wolf" })).toEqual({ a: "fox", e: "wolf" });
  });
});
