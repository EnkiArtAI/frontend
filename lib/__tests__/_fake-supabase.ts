import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

/**
 * An in-memory postgrest-shaped client for route and helper tests: rows live
 * in plain arrays, the builder records filters and applies them when awaited.
 * Only the operators the code under test uses are implemented; an unknown one
 * throws rather than silently matching everything.
 */
type Row = Record<string, unknown>;
type Filter = { op: string; col: string; val: unknown };
type DbError = { message: string; code?: string; details?: string };

export type FakeDb = {
  client: SupabaseClient;
  tables: Record<string, Row[]>;
  /** Every `${table}.${op}` in call order, for "never inserted a users row" assertions. */
  ops: string[];
};

export function fakeDb(seed: Record<string, Row[]> = {}, errors: Record<string, DbError> = {}): FakeDb {
  const tables: Record<string, Row[]> = {};
  for (const [t, rows] of Object.entries(seed)) tables[t] = rows.map((r) => ({ ...r }));
  const ops: string[] = [];

  const matches = (row: Row, f: Filter): boolean => {
    const v = row[f.col];
    switch (f.op) {
      case "eq": return v === f.val;
      case "is": return v === f.val || (f.val === null && v === undefined);
      case "gt": return typeof v === "string" && typeof f.val === "string" && v > f.val;
      case "ilike": return typeof v === "string" && v.toLowerCase() === String(f.val).replace(/\\([%_])/g, "$1").toLowerCase();
      case "in": return Array.isArray(f.val) && f.val.includes(v);
      case "not-is": return !(v === f.val || (f.val === null && v === undefined));
      case "or": return true; // activeBanFor's expiry disjunction; seed only live bans
      default: throw new Error(`fakeDb: operator ${f.op} not implemented`);
    }
  };

  function builder(table: string) {
    let op = "select";
    let payload: Row | Row[] | null = null;
    const filters: Filter[] = [];
    let limit: number | null = null;
    let mode: "many" | "single" | "maybe" = "many";
    let head = false;

    const run = (): { data: unknown; error: DbError | null; count: number | null } => {
      ops.push(`${table}.${op}`);
      const err = errors[`${table}.${op}`] ?? errors[table];
      if (err) return { data: null, error: err, count: null };
      tables[table] ??= [];
      const rows = tables[table];
      const hit = rows.filter((r) => filters.every((f) => matches(r, f)));
      let out: Row[];
      if (op === "insert") {
        out = (Array.isArray(payload) ? payload : [payload!]).map((r) => ({ id: randomUUID(), ...r }));
        rows.push(...out);
      } else if (op === "update") {
        hit.forEach((r) => Object.assign(r, payload));
        out = hit;
      } else if (op === "delete") {
        tables[table] = rows.filter((r) => !hit.includes(r));
        out = hit;
      } else {
        out = limit === null ? hit : hit.slice(0, limit);
      }
      if (head) return { data: null, error: null, count: out.length };
      if (mode === "maybe") return { data: out[0] ?? null, error: null, count: null };
      if (mode === "single") return out[0] ? { data: out[0], error: null, count: null } : { data: null, error: { message: "no rows", code: "PGRST116" }, count: null };
      return { data: out, error: null, count: out.length };
    };

    const b: Record<string, unknown> = {
      select: (_cols?: string, opts?: { head?: boolean }) => { head = !!opts?.head; return b; },
      insert: (rows: Row | Row[]) => { op = "insert"; payload = rows; return b; },
      update: (patch: Row) => { op = "update"; payload = patch; return b; },
      delete: () => { op = "delete"; return b; },
      eq: (col: string, val: unknown) => { filters.push({ op: "eq", col, val }); return b; },
      is: (col: string, val: unknown) => { filters.push({ op: "is", col, val }); return b; },
      gt: (col: string, val: unknown) => { filters.push({ op: "gt", col, val }); return b; },
      ilike: (col: string, val: unknown) => { filters.push({ op: "ilike", col, val }); return b; },
      in: (col: string, val: unknown) => { filters.push({ op: "in", col, val }); return b; },
      not: (col: string, o: string, val: unknown) => { filters.push({ op: `not-${o}`, col, val }); return b; },
      or: (expr: string) => { filters.push({ op: "or", col: "", val: expr }); return b; },
      order: () => b,
      limit: (n: number) => { limit = n; return b; },
      maybeSingle: () => { mode = "maybe"; return Promise.resolve(run()); },
      single: () => { mode = "single"; return Promise.resolve(run()); },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
    };
    return b;
  }

  const client = { from: (table: string) => builder(table) } as unknown as SupabaseClient;
  return { client, tables, ops };
}
