// Recompute prompts.tags for every prompt with the publish rules of
// lib/search/tags.ts (Kev, 2026-10-07: tags are ours, automatic, and a paid
// body yields subjects only). Prompts saved before that carry creator tags or
// none at all.
//
//   node scripts/backfill-search-tags.mjs           dry run: prints title -> tags
//   node scripts/backfill-search-tags.mjs --apply   writes them
//
// Reads SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and the field encryption keys
// from .env.local. Prints titles and the computed tags only, never a body or a
// key. The body is decrypted in this process, matched, and dropped.
//
// Run it AFTER the deploy that stops the editor from saving its category in
// tags: a save by the old code would put a category back. A row whose
// category still lives only in tags[0] gets it moved to prompts.category, so
// this run never deletes the last copy. A row changed since it was read is
// left alone.
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const jiti = createJiti(import.meta.url);
const { decryptString } = await jiti.import("../lib/crypto.ts");
const { extractTags, storedTags } = await jiti.import("../lib/search/tags.ts");
const { isPublicText } = await jiti.import("../lib/prompt-visibility.ts");
const { ENKI_CATEGORIES } = await jiti.import("../lib/categories.ts");
const categories = new Set(ENKI_CATEGORIES.map((c) => c.toLowerCase()));

const apply = process.argv.includes("--apply");
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
const get = async (path) => {
  const res = await fetch(`${url}/rest/v1/${path}`, { headers });
  if (!res.ok) throw new Error(`GET ${path.split("?")[0]}: ${res.status}`);
  return res.json();
};

const prompts = await get(
  "prompts?select=id,title,tags,category,updated_at,prompt_type,is_free_showcase,encrypted_content,encrypted_content_iv,encrypted_content_tag,encrypted_content_kid&order=created_at.asc",
);
const variables = await get("prompt_variables?select=prompt_id,name,label,default_value,options&deleted_at=is.null");

let changed = 0;
for (const p of prompts) {
  let body = "";
  if (p.encrypted_content) {
    try {
      body = decryptString({ encrypted: p.encrypted_content, iv: p.encrypted_content_iv, authTag: p.encrypted_content_tag, kid: p.encrypted_content_kid ?? undefined });
    } catch {
      // Still replace the creator's tags: title and variables are enough.
      console.warn(`${p.id}: body does not decrypt, tagging from title and variables only`);
    }
  }
  const variableText = variables
    .filter((v) => v.prompt_id === p.id)
    .flatMap((v) => [v.name, v.label, v.default_value, ...(Array.isArray(v.options) ? v.options : []).flatMap((o) => [o?.visibleName, o?.label, o?.promptValue])])
    .filter((s) => typeof s === "string")
    .join("\n");
  const tags = storedTags(extractTags(body, { paid: !isPublicText(p) }), extractTags(`${p.title ?? ""}\n${variableText}`));
  const old = p.tags ?? [];
  const category = !p.category && categories.has(String(old[0] ?? "")) ? String(old[0]) : null;
  const same = JSON.stringify(tags) === JSON.stringify(old) && !category;
  console.log(`${same ? "=" : "~"} ${String(p.title ?? "").slice(0, 60)}: [${old.join(", ")}] -> [${tags.join(", ")}]${category ? ` category ${category}` : ""}`);
  if (same) continue;
  changed++;
  if (apply) {
    const res = await fetch(`${url}/rest/v1/prompts?id=eq.${p.id}&updated_at=eq.${encodeURIComponent(p.updated_at)}`, {
      method: "PATCH",
      headers: { ...headers, Prefer: "return=representation" },
      body: JSON.stringify(category ? { tags, category } : { tags }),
    });
    if (!res.ok) throw new Error(`PATCH ${p.id}: ${res.status}`);
    if ((await res.json()).length === 0) console.warn(`${p.id}: changed since it was read, left alone`);
  }
}
console.log(`${prompts.length} prompts, ${changed} ${apply ? "updated" : "would change (dry run; --apply writes)"}`);
