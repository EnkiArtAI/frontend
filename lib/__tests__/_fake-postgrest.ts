/**
 * A PostgREST-shaped stand-in for the service-role client: eq/not filters,
 * conditional updates, upsert on (user_id, kind), deletes with a count, and
 * a switch that makes one table answer with an error code. Enough for the
 * MFA routes; no SQL semantics beyond that.
 */
type Row = Record<string, unknown>;

export function fakePostgrest() {
  const tables: Record<string, Row[]> = {};
  const state = { failing: null as { table: string; code: string } | null };

  function from(table: string) {
    const filters: ((r: Row) => boolean)[] = [];
    let op: { kind: "select" | "update" | "upsert" | "delete"; values?: Row; head?: boolean } = { kind: "select" };
    let one = false;
    const rows = () => (tables[table] ??= []);
    const q: Record<string, unknown> = {
      select: (_cols?: string, opts?: { head?: boolean }) => { if (op.kind === "select") op = { kind: "select", head: opts?.head }; return q; },
      update: (values: Row) => { op = { kind: "update", values }; return q; },
      upsert: (values: Row) => { op = { kind: "upsert", values }; return q; },
      delete: () => { op = { kind: "delete" }; return q; },
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
      not: (c: string, _op: string, v: unknown) => { filters.push((r) => (r[c] ?? null) !== v); return q; },
      maybeSingle: () => { one = true; return q; },
      single: () => { one = true; return q; },
      then: (ok: (v: unknown) => unknown) => {
        if (state.failing?.table === table) {
          return Promise.resolve({ data: null, error: { code: state.failing.code, message: "boom" }, count: null }).then(ok);
        }
        if (op.kind === "upsert") {
          const v = op.values!;
          let r = rows().find((x) => x.user_id === v.user_id && x.kind === v.kind);
          if (!r) {
            r = { id: `f${rows().length + 1}`, lockouts: 0, sends_count: 0, failed_attempts: 0, last_step: null, code_sent_at: null, sends_day: null, ...v };
            rows().push(r);
          } else Object.assign(r, v);
          return Promise.resolve({ data: { ...r }, error: null }).then(ok);
        }
        const hit = rows().filter((r) => filters.every((f) => f(r)));
        if (op.kind === "update") hit.forEach((r) => Object.assign(r, op.values));
        if (op.kind === "delete") tables[table] = rows().filter((r) => !hit.includes(r));
        const data = one ? (hit[0] ? { ...hit[0] } : null) : hit.map((r) => ({ ...r }));
        return Promise.resolve({ data: op.head ? null : data, error: null, count: hit.length }).then(ok);
      },
    };
    return q;
  }
  return { tables, state, client: { from } as never };
}
