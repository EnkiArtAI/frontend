import { describe, it, expect, beforeEach } from "vitest";
import crypto from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * These tests exist for one claim: an authorisation can be captured or voided,
 * never both, and it dies from SILENCE rather than from a clock.
 *
 * That means the fake below has to model a conditional UPDATE honestly — a
 * stub that always returns a row would pass every mutual-exclusion assertion
 * while the real thing double-spends. So it applies the accumulated filters to
 * the rows and updates only what matches, exactly as PostgREST would, and an
 * UPDATE matching nothing yields null without an error.
 */

// ── a Postgres-shaped fake ──────────────────────────────────────────────

type Row = Record<string, any>;

/** Split on top-level commas, so and(...) groups survive intact. */
function splitClauses(expr: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    if (expr[i] === "(") depth++;
    else if (expr[i] === ")") depth--;
    else if (expr[i] === "," && depth === 0) {
      out.push(expr.slice(start, i));
      start = i + 1;
    }
  }
  out.push(expr.slice(start));
  return out;
}

function clauseToPredicate(clause: string): (r: Row) => boolean {
  // [\s\S] rather than the dotAll flag — the build target predates es2018.
  const and = clause.match(/^and\(([\s\S]*)\)$/);
  if (and) {
    const inner = splitClauses(and[1]).map(clauseToPredicate);
    return (r) => inner.every((p) => p(r));
  }
  const [col, op, ...rest] = clause.split(".");
  const value = rest.join(".");
  if (op === "is" && value === "null") return (r) => (r[col] ?? null) === null;
  if (op === "lt") return (r) => r[col] != null && String(r[col]) < value;
  throw new Error(`fake: unsupported or() clause "${clause}"`);
}

class Builder implements PromiseLike<{ data: any; error: any }> {
  private filters: ((r: Row) => boolean)[] = [];
  private patch: Row | null = null;
  private cap = Infinity;
  private single = false;

  constructor(private rows: Row[]) {}

  update(patch: Row) {
    this.patch = patch;
    return this;
  }
  select(_cols?: string) {
    return this;
  }
  eq(col: string, v: unknown) {
    this.filters.push((r) => r[col] === v);
    return this;
  }
  is(col: string, v: unknown) {
    this.filters.push((r) => (r[col] ?? null) === v);
    return this;
  }
  not(col: string, op: string, v: unknown) {
    if (op !== "is") throw new Error(`fake: unsupported not(${op})`);
    this.filters.push((r) => (r[col] ?? null) !== v);
    return this;
  }
  lt(col: string, v: string) {
    this.filters.push((r) => r[col] != null && String(r[col]) < v);
    return this;
  }
  or(expr: string) {
    const preds = splitClauses(expr).map(clauseToPredicate);
    this.filters.push((r) => preds.some((p) => p(r)));
    return this;
  }
  limit(n: number) {
    this.cap = n;
    return this;
  }
  maybeSingle() {
    this.single = true;
    return this;
  }

  private run() {
    const matched = this.rows.filter((r) => this.filters.every((f) => f(r))).slice(0, this.cap);
    if (this.patch) for (const r of matched) Object.assign(r, this.patch);
    return matched;
  }

  then<A, B>(
    onfulfilled?: ((v: { data: any; error: any }) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    const matched = this.run();
    const data = this.single ? (matched[0] ?? null) : matched;
    return Promise.resolve({ data, error: null }).then(onfulfilled, onrejected);
  }
}

function fakeClient(rows: Row[]): SupabaseClient {
  return { from: () => new Builder(rows) } as unknown as SupabaseClient;
}

// ── fixtures ────────────────────────────────────────────────────────────

const BUYER = "8xKevBuyerWalletBase58";
const INTENT = "11111111-1111-1111-1111-111111111111";
const TX = "AQABBase64SignedTransactionBytes==";

const quotedRow = (over: Row = {}): Row => ({
  id: INTENT,
  buyer_wallet: BUYER,
  total_micro: 250_000,
  status: "quoted",
  authorized_at: null,
  consumed_at: null,
  captured_at: null,
  voided_at: null,
  void_reason: null,
  nonce_account: null,
  ...over,
});

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

async function mod() {
  return import("@/lib/payments/authorization");
}

/** Put a live authorisation on the table and hand back its row. */
async function authorized(rows: Row[]) {
  const { storeAuthorization } = await mod();
  const ok = await storeAuthorization(fakeClient(rows), {
    intentId: INTENT,
    buyerWallet: BUYER,
    signedTx: TX,
    nonceAccount: "NonceAcc111",
    nonceAuthority: "EnkiAuth111",
  });
  expect(ok).toBe(true);
  return rows[0];
}

describe("generation authorisation", () => {
  beforeEach(async () => {
    process.env.FIELD_ENCRYPTION_KEY_B64 = crypto.randomBytes(32).toString("base64");
    (await import("@/lib/crypto")).resetKeyringCache();
  });

  it("records the signature without claiming the work", async () => {
    const rows = [quotedRow()];
    const row = await authorized(rows);

    expect(row.authorized_at).toBeTruthy();
    /* consumed_at is the in-flight marker and belongs to claimForGeneration,
       not to this write. Setting it here would tell the sweeper a generation
       was already running the moment the buyer signed, and start its 360s
       deadline against work that had not begun. The unclaimed case is swept on
       authorized_at instead. */
    expect(row.consumed_at ?? null).toBeNull();
    expect(row.status).toBe("generating");
  });

  it("refuses to re-authorise a settled intent", async () => {
    const { storeAuthorization } = await mod();
    const rows = [quotedRow({ authorized_at: ago(1000), voided_at: ago(500) })];

    const ok = await storeAuthorization(fakeClient(rows), {
      intentId: INTENT,
      buyerWallet: BUYER,
      signedTx: TX,
      nonceAccount: "N",
      nonceAuthority: "A",
    });
    expect(ok).toBe(false);
    expect(rows[0].status).not.toBe("generating");
  });

  it("hands back the signed transaction, and only to its own row", async () => {
    const { captureAuthorization } = await mod();
    const rows = [quotedRow()];
    await authorized(rows);

    const held = await captureAuthorization(fakeClient(rows), INTENT);
    expect(held?.signedTx).toBe(TX);
    expect(held?.nonceAccount).toBe("NonceAcc111");

    // The ciphertext is bound to the intent id: lifted into another row it
    // must not open, so a leaked blob is not a charge against someone else.
    const other = "22222222-2222-2222-2222-222222222222";
    const stolen = [quotedRow({ ...rows[0], id: other, captured_at: null, voided_at: null })];
    await expect(captureAuthorization(fakeClient(stolen), other)).rejects.toThrow();
  });
});

describe("capture and void are mutually exclusive", () => {
  beforeEach(async () => {
    process.env.FIELD_ENCRYPTION_KEY_B64 = crypto.randomBytes(32).toString("base64");
    (await import("@/lib/crypto")).resetKeyringCache();
  });

  it("refuses to void what was already captured", async () => {
    const { captureAuthorization, voidAuthorization } = await mod();
    const rows = [quotedRow()];
    await authorized(rows);

    expect(await captureAuthorization(fakeClient(rows), INTENT)).not.toBeNull();
    expect(await voidAuthorization(fakeClient(rows), INTENT, "provider_failed")).toBeNull();

    expect(rows[0].captured_at).toBeTruthy();
    expect(rows[0].voided_at).toBeNull();
  });

  it("refuses to capture what was already voided", async () => {
    const { captureAuthorization, voidAuthorization } = await mod();
    const rows = [quotedRow()];
    await authorized(rows);

    expect(await voidAuthorization(fakeClient(rows), INTENT, "rejected")).not.toBeNull();
    // Losing here is the signal to hand the image over unpaid rather than
    // broadcast against a nonce that has already been advanced.
    expect(await captureAuthorization(fakeClient(rows), INTENT)).toBeNull();

    expect(rows[0].voided_at).toBeTruthy();
    expect(rows[0].void_reason).toBe("rejected");
    expect(rows[0].captured_at).toBeNull();
  });

  it("never captures twice", async () => {
    const { captureAuthorization } = await mod();
    const rows = [quotedRow()];
    await authorized(rows);

    expect(await captureAuthorization(fakeClient(rows), INTENT)).not.toBeNull();
    expect(await captureAuthorization(fakeClient(rows), INTENT)).toBeNull();
  });

  it("a voided authorisation can no longer be captured", async () => {
    /* This replaces a test of beat(), which told a running job it had lost so
       it could stop. There is no beat any more: the abort condition is a
       deadline on consumed_at, not silence. What still has to hold is the part
       that protected the money — once something else has taken the decision,
       the capture must not go through. */
    const { captureAuthorization, voidAuthorization } = await mod();
    const rows = [quotedRow()];
    await authorized(rows);

    await voidAuthorization(fakeClient(rows), INTENT, "cancelled");
    expect(await captureAuthorization(fakeClient(rows), INTENT)).toBeNull();
    expect(rows[0].captured_at ?? null).toBeNull();
  });
});

describe("the abort condition is silence, not elapsed time", () => {
  beforeEach(async () => {
    process.env.FIELD_ENCRYPTION_KEY_B64 = crypto.randomBytes(32).toString("base64");
    (await import("@/lib/crypto")).resetKeyringCache();
  });

  it("leaves a two-hour-old authorisation alone while it is still beating", async () => {
    const { sweepAbandoned, ABANDONED_AFTER_MS } = await mod();
    const rows = [quotedRow()];
    const row = await authorized(rows);

    // Older than any deadline anyone would have picked — and irrelevant,
    // because the worker is still there. This is the whole point of the
    // design: no generation dies of taking long.
    row.authorized_at = ago(2 * 60 * 60_000);
    row.consumed_at = ago(ABANDONED_AFTER_MS / 3);

    expect(await sweepAbandoned(fakeClient(rows))).toEqual([]);
    expect(rows[0].voided_at).toBeNull();
  });

  it("voids one that went quiet, and says which nonce to flush", async () => {
    const { sweepAbandoned, ABANDONED_AFTER_MS } = await mod();
    const rows = [quotedRow()];
    const row = await authorized(rows);
    row.consumed_at = ago(ABANDONED_AFTER_MS + 1000);

    const flushed = await sweepAbandoned(fakeClient(rows));
    expect(flushed).toEqual([{ intentId: INTENT, nonceAccount: "NonceAcc111" }]);
    expect(rows[0].void_reason).toBe("abandoned");
  });

  it("does not touch a job one beat behind", async () => {
    const { sweepAbandoned } = await mod();
    const rows = [quotedRow()];
    const row = await authorized(rows);
    // One missed beat is a slow DB write, not a death. The grace is three.
    row.consumed_at = ago(20_000);

    expect(await sweepAbandoned(fakeClient(rows))).toEqual([]);
  });

  it("clears an authorised row that never beat, rather than leaving it forever", async () => {
    const { sweepAbandoned, ABANDONED_AFTER_MS } = await mod();
    const rows = [quotedRow()];
    const row = await authorized(rows);
    // storeAuthorization always writes a first beat, so this state is a bug —
    // the sweep makes the bug self-clearing instead of a permanent live nonce.
    row.consumed_at = null;
    row.authorized_at = ago(ABANDONED_AFTER_MS + 1000);

    expect(await sweepAbandoned(fakeClient(rows))).toHaveLength(1);
  });

  it("leaves settled rows out of the sweep entirely", async () => {
    const { sweepAbandoned, ABANDONED_AFTER_MS } = await mod();
    const stale = ago(ABANDONED_AFTER_MS + 1000);
    const rows = [
      quotedRow({ id: "a", authorized_at: stale, consumed_at: stale, captured_at: stale }),
      quotedRow({ id: "b", authorized_at: stale, consumed_at: stale, voided_at: stale }),
      quotedRow({ id: "c" }), // never authorised: only a quote, no signature to flush
    ];
    expect(await sweepAbandoned(fakeClient(rows))).toEqual([]);
  });
});

/**
 * The sweep selects on the heartbeat and then has to kill through a separate
 * write. If that write does not repeat the condition, a worker that beat in
 * between is killed anyway — its generation runs to completion against a dead
 * authorisation, captureAndBroadcast returns null, and the image ships free.
 *
 * The file's own comment claimed per-row voiding prevented exactly this. It
 * did not: voidAuthorization's WHERE carried no heartbeat condition at all.
 */
describe("a beat that lands mid-sweep saves the row", () => {
  beforeEach(async () => {
    process.env.FIELD_ENCRYPTION_KEY_B64 = crypto.randomBytes(32).toString("base64");
    (await import("@/lib/crypto")).resetKeyringCache();
  });

  /** A client that lets the worker beat once, right after the sweep's SELECT. */
  function racingClient(rows: Row[], onFirstResolve: () => void): SupabaseClient {
    let n = 0;
    return {
      from: () => {
        const b = new Builder(rows);
        const original = b.then.bind(b);
        (b as unknown as { then: unknown }).then = (
          onfulfilled?: ((v: { data: unknown; error: unknown }) => unknown) | null,
          onrejected?: ((reason: unknown) => unknown) | null,
        ) =>
          original((res: { data: unknown; error: unknown }) => {
            if (n++ === 0) onFirstResolve();
            return onfulfilled ? onfulfilled(res) : res;
          }, onrejected);
        return b;
      },
    } as unknown as SupabaseClient;
  }

  it("leaves the row alone when the heartbeat refreshed after the SELECT", async () => {
    const { sweepAbandoned, ABANDONED_AFTER_MS } = await mod();
    const rows = [quotedRow()];
    const row = await authorized(rows);
    row.consumed_at = ago(ABANDONED_AFTER_MS * 2); // stale, so the SELECT takes it

    // The worker wakes up between the SELECT and the write — the exact race
    // the sweep's comment promised was handled.
    const flushed = await sweepAbandoned(racingClient(rows, () => {
      row.consumed_at = new Date().toISOString();
    }));

    expect(flushed).toEqual([]);
    expect(row.voided_at ?? null).toBeNull();
    expect(row.void_reason ?? null).toBeNull();
  });

  it("still voids a row that is genuinely silent — the fix must not disable the sweep", async () => {
    const { sweepAbandoned, ABANDONED_AFTER_MS } = await mod();
    const rows = [quotedRow()];
    const row = await authorized(rows);
    row.consumed_at = ago(ABANDONED_AFTER_MS * 2);

    const flushed = await sweepAbandoned(fakeClient(rows));

    expect(flushed.map((f) => f.intentId)).toEqual([INTENT]);
    expect(row.void_reason).toBe("abandoned");
  });

  it("still voids an authorised row that never beat at all", async () => {
    // The OR's second branch: a NULL heartbeat does not satisfy `lt`, so
    // dropping it from the write would make this row immortal.
    const { sweepAbandoned, ABANDONED_AFTER_MS } = await mod();
    const rows = [quotedRow()];
    const row = await authorized(rows);
    row.consumed_at = null;
    row.authorized_at = ago(ABANDONED_AFTER_MS * 2);

    const flushed = await sweepAbandoned(fakeClient(rows));

    expect(flushed.map((f) => f.intentId)).toEqual([INTENT]);
    expect(row.void_reason).toBe("abandoned");
  });
});

describe("a checkout cancelled before signing gives its nonce rent back", () => {
  const building = (over: Row = {}) => quotedRow({ status: "building", nonce_account: "NonceAcc222", updated_at: ago(1000), ...over });

  it("voids an intent prepared and never signed once it is stale, and names the nonce to close", async () => {
    const { sweepUnsubmitted, ABANDONED_AFTER_MS } = await mod();
    const rows = [building({ updated_at: ago(ABANDONED_AFTER_MS + 1000) })];
    expect(await sweepUnsubmitted(fakeClient(rows))).toEqual([{ intentId: INTENT, nonceAccount: "NonceAcc222" }]);
    expect(rows[0].void_reason).toBe("abandoned");
    expect(rows[0].status).toBe("voided");
  });

  it("leaves a buyer who is still in the wallet popup alone", async () => {
    const { sweepUnsubmitted } = await mod();
    expect(await sweepUnsubmitted(fakeClient([building()]))).toEqual([]);
  });

  it("finds a stale one behind a page of fresh ones", async () => {
    const { sweepUnsubmitted, ABANDONED_AFTER_MS } = await mod();
    const fresh = Array.from({ length: 20 }, (_, i) => building({ id: `fresh-${i}` }));
    const rows = [...fresh, building({ updated_at: ago(ABANDONED_AFTER_MS + 1000) })];
    expect(await sweepUnsubmitted(fakeClient(rows))).toEqual([{ intentId: INTENT, nonceAccount: "NonceAcc222" }]);
  });

  it("lets a /submit that lands between its SELECT and its write win", async () => {
    const { sweepUnsubmitted, ABANDONED_AFTER_MS } = await mod();
    const rows = [building({ updated_at: ago(ABANDONED_AFTER_MS + 1000) })];
    let n = 0;
    const racing = {
      from: () => {
        const b = new Builder(rows);
        const original = b.then.bind(b);
        (b as unknown as { then: unknown }).then = (
          ok?: ((v: { data: unknown; error: unknown }) => unknown) | null,
          ko?: ((reason: unknown) => unknown) | null,
        ) => original((res: { data: unknown; error: unknown }) => {
          if (n++ === 0) rows[0].authorized_at = new Date().toISOString(); // the buyer's signature arrives
          return ok ? ok(res) : res;
        }, ko);
        return b;
      },
    } as unknown as SupabaseClient;
    expect(await sweepUnsubmitted(racing)).toEqual([]);
    expect(rows[0].voided_at).toBeNull();
  });

  it("never voids one that was signed, however old", async () => {
    const { sweepUnsubmitted, ABANDONED_AFTER_MS } = await mod();
    const rows = [building({ updated_at: ago(ABANDONED_AFTER_MS + 1000), authorized_at: ago(ABANDONED_AFTER_MS + 500) })];
    expect(await sweepUnsubmitted(fakeClient(rows))).toEqual([]);
    expect(rows[0].voided_at).toBeNull();
  });
});
