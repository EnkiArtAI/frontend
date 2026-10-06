/**
 * Workflow tokens — how an embedded prompt/workflow marks its place inside a
 * host prompt (Kev, 2026-09-05: "nen premade prompt oder nen anderen
 * workflow einfügen … workflows inside workflows").
 *
 * `{{wf:<nodeId>}}` on purpose, NOT square brackets: `[name]` is the variable
 * grammar (TOKEN_SRC), and the body parser turns every unknown [token] into a
 * text-input node — a workflow marker must never be mistaken for one.
 */
export const WF_TOKEN_RE = /\{\{wf:([A-Za-z0-9_-]+)\}\}/g;

export const wfToken = (nodeId: string) => `{{wf:${nodeId}}}`;

export interface EmbeddedWorkflow {
  id: string;
  /** The embedded prompt's own text, with its own [variables]. */
  text: string;
  /** Values for those variables, keyed by bare name (no brackets). */
  vars: Record<string, string>;
}

/**
 * Replace every workflow token with its resolved text. The embedded text's
 * [variables] are filled from `vars`; an unfilled one is dropped rather than
 * shipped as a literal "[angle]" to the model. Tokens with no matching
 * workflow (a deleted node) vanish.
 */
export function resolveWorkflowTokens(body: string, workflows: EmbeddedWorkflow[]): string {
  const byId = new Map(workflows.map((w) => [w.id, w]));
  return body.replace(WF_TOKEN_RE, (_m, id: string) => {
    const w = byId.get(id);
    if (!w) return "";
    return w.text
      .replace(/\[([^\]\n]+)\]/g, (_t, name: string) => w.vars[name] ?? "")
      .replace(/\s{2,}/g, " ")
      .trim();
  });
}

/** Names of the [variables] an embedded text exposes, in order, unique. */
export function workflowVars(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\[([^\]\n]+)\]/g)) {
    const name = m[1].trim();
    if (name && !/^Reference Image \d+$/.test(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

/** The text with all workflow tokens removed (for signatures, previews). */
export const stripWorkflowTokens = (body: string) => body.replace(WF_TOKEN_RE, "").replace(/\s{2,}/g, " ").trim();
