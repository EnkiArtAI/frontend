/**
 * A PostgREST-shaped stand-in for the service-role client: eq / is / not /
 * gt / in / or filters, inserts, conditional updates, upsert on (user_id, kind), deletes with a
 * count, a switch that makes one table answer with an error code, and a
 * pause that hands one read its snapshot late (to stage races). Enough for
 * the MFA code; no SQL semantics beyond that.
 */
type Row = Record<string, unknown>;

const cmp = (a: unknown, b: string) => {
  const n = Number(b);
  return typeof a === "number" && !Number.isNaN(n) ? a - n : String(a).localeCompare(b);
};
// "col.is.null,col.lt.5" -> true when any branch holds.
function orFilter(expr: string): (r: Row) => boolean {
  const branches = expr.split(",").map((part) => {
    const [col, op, ...rest] = part.split(".");
    const val = rest.join(".");
    return (r: Row) => {
      const v = r[col] ?? null;
      if (op === "is") return v === (val === "null" ? null : val);
      if (v === null) return false;
      if (op === "eq") return String(v) === val;
      if (op === "lt") return cmp(v, val) < 0;
      if (op === "lte") return cmp(v, val) <= 0;
      throw new Error(`fake or(): ${op}`);
    };
  });
  return (r) => branches.some((b) => b(r));
}

export function fakePostgrest() {
  const tables: Record<string, Row[]> = {};
  const state = {
    failing: null as { table: string; code: string } | null,
    // The next select("*") on this table takes its snapshot now and answers when released.
    pauseNextRead: null as { table: string; until: Promise<void> } | null,
  };

  function from(table: string) {
    const filters: ((r: Row) => boolean)[] = [];
    let op: { kind: "select" | "insert" | "update" | "upsert" | "delete"; values?: Row; head?: boolean; star?: boolean } = { kind: "select" };
    let one = false;
    const rows = () => (tables[table] ??= []);
    const q: Record<string, unknown> = {
      select: (cols?: string, opts?: { head?: boolean }) => { if (op.kind === "select") op = { kind: "select", head: opts?.head, star: cols === "*" }; return q; },
      insert: (values: Row) => { op = { kind: "insert", values }; return q; },
      update: (values: Row) => { op = { kind: "update", values }; return q; },
      upsert: (values: Row) => { op = { kind: "upsert", values }; return q; },
      delete: () => { op = { kind: "delete" }; return q; },
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
      is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return q; },
      not: (c: string, _op: string, v: unknown) => { filters.push((r) => (r[c] ?? null) !== v); return q; },
      gt: (c: string, v: string) => { filters.push((r) => r[c] != null && String(r[c]) > v); return q; },
      in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return q; },
      or: (expr: string) => { filters.push(orFilter(expr)); return q; },
      maybeSingle: () => { one = true; return q; },
      single: () => { one = true; return q; },
      then: (ok: (v: unknown) => unknown) => {
        if (state.failing?.table === table) {
          return Promise.resolve({ data: null, error: { code: state.failing.code, message: "boom" }, count: null }).then(ok);
        }
        if (op.kind === "insert") {
          const r = { id: `${table}-${rows().length + 1}`, ...op.values };
          rows().push(r);
          return Promise.resolve({ data: { ...r }, error: null }).then(ok);
        }
        if (op.kind === "upsert") {
          const v = op.values!;
          let r = rows().find((x) => x.user_id === v.user_id && x.kind === v.kind);
          if (!r) {
            r = { id: `f${rows().length + 1}`, lockouts: 0, sends_count: 0, failed_attempts: 0, last_step: null, code_sent_at: null, sends_day: null, created_at: new Date().toISOString(), ...v };
            rows().push(r);
          } else Object.assign(r, v);
          return Promise.resolve({ data: { ...r }, error: null }).then(ok);
        }
        const hit = rows().filter((r) => filters.every((f) => f(r)));
        if (op.kind === "update") hit.forEach((r) => Object.assign(r, op.values));
        if (op.kind === "delete") tables[table] = rows().filter((r) => !hit.includes(r));
        const data = one ? (hit[0] ? { ...hit[0] } : null) : hit.map((r) => ({ ...r }));
        const result = { data: op.head ? null : data, error: null, count: hit.length };
        const pause = state.pauseNextRead;
        if (pause && pause.table === table && op.kind === "select" && op.star) {
          state.pauseNextRead = null;
          return pause.until.then(() => ok(result));
        }
        return Promise.resolve(result).then(ok);
      },
    };
    return q;
  }
  return { tables, state, client: { from } as never };
}
