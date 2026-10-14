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
      if (op === "gt") return cmp(v, val) > 0;
      if (op === "lte") return cmp(v, val) <= 0;
      throw new Error(`fake or(): ${op}`);
    };
  });
  return (r) => branches.some((b) => b(r));
}

// Column defaults the fake applies on insert, as the migrations declare them.
const DEFAULTS: Record<string, Row> = {
  mfa_factors: { lockouts: 0, sends_count: 0, failed_attempts: 0, last_step: null, code_sent_at: null, sends_day: null },
  reports: { status: "pending" },
  users: { role: "user" }, // migrations/2026-07-12-user-roles.sql: role text NOT NULL DEFAULT 'user'
};
// Unique keys the fake enforces on insert (23505), as the migrations declare them.
const UNIQUE: Record<string, string[]> = { mfa_factors: ["user_id", "kind"], access_allowlist: ["kind", "value"], linked_wallets: ["user_id", "address"] };

export function fakePostgrest() {
  const tables: Record<string, Row[]> = {};
  const state = {
    failing: null as { table: string; code: string } | null,
    // The next select("*") on this table (after `skip` more) takes its snapshot now and answers when released.
    pauseNextRead: null as { table: string; until: Promise<void>; skip?: number } | null,
    // The next query of this kind on this table (after `skip` more) answers with this error code.
    failNext: null as { table: string; op: "select" | "insert" | "update" | "upsert" | "delete"; code: string; skip?: number } | null,
    // The next query of any kind on this table (after `skip` more) waits until released, then runs.
    holdNext: null as { table: string; until: Promise<void>; skip?: number } | null,
  };

  function from(table: string) {
    const filters: ((r: Row) => boolean)[] = [];
    let op: { kind: "select" | "insert" | "update" | "upsert" | "delete"; values?: Row; rows?: Row[]; head?: boolean; star?: boolean } = { kind: "select" };
    let one = false;
    let cap = Infinity;
    const rows = () => (tables[table] ??= []);
    const q: Record<string, unknown> = {
      select: (cols?: string, opts?: { head?: boolean }) => { if (op.kind === "select") op = { kind: "select", head: opts?.head, star: cols === "*" }; return q; },
      insert: (values: Row | Row[]) => { op = { kind: "insert", rows: [values].flat() }; return q; },
      update: (values: Row) => { op = { kind: "update", values }; return q; },
      upsert: (values: Row) => { op = { kind: "upsert", values }; return q; },
      delete: () => { op = { kind: "delete" }; return q; },
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
      is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return q; },
      not: (c: string, _op: string, v: unknown) => { filters.push((r) => (r[c] ?? null) !== v); return q; },
      neq: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) !== v); return q; },
      gt: (c: string, v: string) => { filters.push((r) => r[c] != null && String(r[c]) > v); return q; },
      in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return q; },
      ilike: (c: string, v: string) => { filters.push((r) => String(r[c] ?? "").toLowerCase() === v.toLowerCase()); return q; },
      or: (expr: string) => { filters.push(orFilter(expr)); return q; },
      order: () => q, // rows come back in insertion order
      limit: (n: number) => { cap = n; return q; }, // rows come back in insertion order
      range: () => q, // likewise: a test seeds one page at most
      maybeSingle: () => { one = true; return q; },
      single: () => { one = true; return q; },
      then: (ok: (v: unknown) => unknown): unknown => {
        const hold = state.holdNext;
        if (hold && hold.table === table) {
          if (hold.skip) hold.skip -= 1;
          else {
            state.holdNext = null;
            return hold.until.then(() => (q.then as (ok: (v: unknown) => unknown) => unknown)(ok));
          }
        }
        const fail = state.failNext;
        if (fail && fail.table === table && fail.op === op.kind) {
          if (fail.skip) fail.skip -= 1;
          else {
            state.failNext = null;
            return Promise.resolve({ data: null, error: { code: fail.code, message: "boom" }, count: null }).then(ok);
          }
        }
        if (state.failing?.table === table) {
          return Promise.resolve({ data: null, error: { code: state.failing.code, message: "boom" }, count: null }).then(ok);
        }
        if (op.kind === "insert") {
          const added: Row[] = op.rows!.map((v, i) => ({ id: `${table}-${rows().length + i + 1}`, created_at: new Date().toISOString(), ...DEFAULTS[table], ...v }));
          const key = UNIQUE[table];
          if (key && added.some((r) => rows().some((x) => key.every((c) => x[c] === r[c])))) {
            return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key" } }).then(ok);
          }
          rows().push(...added);
          return Promise.resolve({ data: one ? { ...added[0] } : added.map((r) => ({ ...r })), error: null }).then(ok);
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
        const hit = rows().filter((r) => filters.every((f) => f(r))).slice(0, op.kind === "select" ? cap : Infinity);
        if (op.kind === "update") hit.forEach((r) => Object.assign(r, op.values));
        if (op.kind === "delete") tables[table] = rows().filter((r) => !hit.includes(r));
        const data = one ? (hit[0] ? { ...hit[0] } : null) : hit.map((r) => ({ ...r }));
        const result = { data: op.head ? null : data, error: null, count: hit.length };
        const pause = state.pauseNextRead;
        if (pause && pause.table === table && op.kind === "select" && op.star) {
          if (pause.skip) pause.skip -= 1;
          else {
            state.pauseNextRead = null;
            return pause.until.then(() => ok(result));
          }
        }
        return Promise.resolve(result).then(ok);
      },
    };
    return q;
  }
  // consume_auth_nonce as migrations/combined-supabase-migrations.sql has it: an
  // unused, unexpired nonce issued for this (lowercased) address, used once.
  async function rpc(fn: string, a: { p_wallet_address: string; p_nonce: string }) {
    if (fn !== "consume_auth_nonce") throw new Error(`fake rpc: ${fn}`);
    const n = (tables.auth_nonces ??= []).find((r) => r.nonce === a.p_nonce && r.wallet_address === a.p_wallet_address.toLowerCase()
      && r.consumed === false && String(r.expires_at) > new Date().toISOString());
    if (n) n.consumed = true;
    return { data: Boolean(n), error: null };
  }
  return { tables, state, client: { from, rpc } as never };
}
