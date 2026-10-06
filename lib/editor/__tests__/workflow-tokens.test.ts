import { describe, it, expect } from "vitest";
import { resolveWorkflowTokens, stripWorkflowTokens, wfToken, workflowVars, WF_TOKEN_RE } from "@/lib/editor/workflow-tokens";
import { TOKEN_SRC } from "@/lib/editor/selection-variable";

describe("workflow tokens", () => {
  it("are NOT variables — the variable grammar must never match one", () => {
    const tok = wfToken("w12");
    expect(new RegExp(TOKEN_SRC).test(tok)).toBe(false);
    expect(tok.match(WF_TOKEN_RE)?.[0]).toBe(tok);
  });

  it("resolve to the embedded text with its variables filled", () => {
    const body = `A portrait of [subject], ${wfToken("w1")}, medium format grain`;
    const out = resolveWorkflowTokens(body, [
      { id: "w1", text: "lit by [angle] rim light at [strength]", vars: { angle: "a low", strength: "full" } },
    ]);
    expect(out).toBe("A portrait of [subject], lit by a low rim light at full, medium format grain");
  });

  it("drop an unfilled embedded variable instead of shipping a literal [name]", () => {
    const out = resolveWorkflowTokens(wfToken("w1"), [{ id: "w1", text: "soft [angle] light", vars: {} }]);
    expect(out).toBe("soft light");
  });

  it("vanish when their workflow is gone", () => {
    expect(resolveWorkflowTokens(`x ${wfToken("gone")} y`, [])).toBe("x  y");
  });

  it("list an embedded text's exposed variables once, without reference-image slots", () => {
    expect(workflowVars("[angle] and [angle] over [Reference Image 1] with [strength]")).toEqual(["angle", "strength"]);
  });

  it("strip cleanly for signatures", () => {
    expect(stripWorkflowTokens(`a ${wfToken("w1")}  b`)).toBe("a b");
  });
});
