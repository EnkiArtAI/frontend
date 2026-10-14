/**
 * The generators a prompt offers (Kev, 2026-10-13: the editor's multi-select;
 * buyers pick among these), as app/api/prompt keeps them: catalogue names in
 * prompts.ai_settings.models, the primary first. Read by the owner's GET, the
 * Image View and the editor; nothing for a prompt saved before the list.
 */
export function offeredModels(settings: unknown): string[] {
  const models = settings && typeof settings === "object" && !Array.isArray(settings) ? (settings as { models?: unknown }).models : undefined;
  if (!Array.isArray(models)) return [];
  return [...new Set(models.filter((m): m is string => typeof m === "string").map((m) => m.trim()).filter(Boolean))];
}
