import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { parseArgs, rowCountsSql, runDbCopy, type Deps } from "@/lib/dev/db-copy";
import { parseEnv } from "@/lib/dev/env";
import { openEnvelope, sealEnvelope, emailLookupHash } from "@/lib/dev/snapshot-sanitise";

/**
 * The copy script is run by Kev against the live project. These tests prove,
 * with a fetch that throws and fixtures for both environment files, that a dry
 * run and every guard never reach the network, and with a routed fetch that
 * the full run only reads the live project, hands passwords to the child
 * processes through the environment and writes the copy's keys into the dev
 * env file without ever logging them.
 */

const b64 = () => randomBytes(32).toString("base64");
const SRC = "sourcesourcesourcesr";
const TGT = "targettargettargetta";
const UUID = "3f9d2c10-7a4b-4e2e-9c1d-0a1b2c3d4e5f";
const LIVE = { SUPABASE_URL: `https://${SRC}.supabase.co`, SUPABASE_ACCESS_TOKEN: "sbp_live_token", SUPABASE_DB_PASSWORD: "live-db-password", FIELD_ENCRYPTION_KEY_B64: b64(), AUTH_PEPPER: b64() };
const DEV = { FIELD_ENCRYPTION_KEY_B64: b64(), AUTH_PEPPER: b64(), SUPABASE_URL: "PASTE_FROM_DASHBOARD" };
const envText = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
const DEV_FILE = ".env.dev.local";

type Recorded = Deps & { logs: string[]; files: Record<string, string>; fetchCalls: number; removed: string[]; runs: { command: string; args: string[]; extraEnv: Record<string, string> }[] };

function makeDeps(files: Record<string, string>, over: Partial<Deps> = {}): Recorded {
  const deps: Recorded = {
    logs: [], files: { ...files }, fetchCalls: 0, removed: [], runs: [],
    fetch: (async () => { deps.fetchCalls++; throw new Error("network touched"); }) as unknown as typeof fetch,
    run: async () => { throw new Error("child process touched"); },
    readFile: (p) => deps.files[p] ?? null,
    writeFile: (p, text) => { deps.files[p] = text; },
    remove: (p) => { deps.removed.push(p); },
    exists: () => false,
    mkdir: () => {},
    which: () => null,
    download: async () => { throw new Error("download touched"); },
    tmpdir: "C:/Temp",
    platform: "win32",
    log: (line) => deps.logs.push(line),
    sleep: async () => {},
    randomBytes: (n) => Uint8Array.from({ length: n }, (_, i) => (i * 13 + 5) % 256),
    now: () => 0,
    ...over,
  };
  return deps;
}

describe("arguments", () => {
  it("parses the flags and refuses unknown ones or a flag without its value", () => {
    expect(parseArgs([])).toEqual({ name: "enki-dev", devEnv: null, dryRun: false, reset: false, skipData: false });
    expect(parseArgs(["--dev-env", ".env.dev.local", "--name", "enki-qa", "--dry-run", "--reset", "--skip-data"])).toEqual({ name: "enki-qa", devEnv: ".env.dev.local", dryRun: true, reset: true, skipData: true });
    expect(() => parseArgs(["--bogus"])).toThrow(/Unknown option --bogus/);
    expect(() => parseArgs(["--dev-env", "--dry-run"])).toThrow("--dev-env needs a value.");
  });
});

describe("dry run and guards never touch the network", () => {
  it("prints the plan and every missing input, writes nothing", async () => {
    const deps = makeDeps({ ".env.local": envText({ SUPABASE_URL: LIVE.SUPABASE_URL, FIELD_ENCRYPTION_KEY_B64: LIVE.FIELD_ENCRYPTION_KEY_B64 }), [DEV_FILE]: envText({ AUTH_PEPPER: DEV.AUTH_PEPPER }) });
    const out = await runDbCopy(["--dry-run", "--dev-env", DEV_FILE], deps);
    expect(out).toEqual({ dryRun: true });
    const text = deps.logs.join("\n");
    expect(deps.logs[0]).toBe(`plan: copy live project ${SRC} into Supabase project "enki-dev"`);
    expect(text).toMatch(/1 find or create "enki-dev"/);
    expect(text).toMatch(/pg tools: download/);
    expect(text).toMatch(/structure only: auth_sessions, auth_nonces, otp_sessions, password_reset_tokens, delete_confirm_tokens, deletion_approvals, user_sessions/);
    expect(text).toMatch(/inputs still missing \(4\):/);
    expect(text).toContain("SUPABASE_ACCESS_TOKEN is missing from .env.local: a personal access token from https://supabase.com/dashboard/account/tokens.");
    expect(text).toContain("SUPABASE_DB_PASSWORD is missing from .env.local");
    expect(text).toContain("AUTH_PEPPER is missing from .env.local");
    expect(text).toContain(`FIELD_ENCRYPTION_KEY_B64 is missing from ${DEV_FILE}; generate the file with node scripts/make-dev-env.mjs --tier core --new-environment --out ${DEV_FILE}.`);
    expect(text).not.toContain(LIVE.FIELD_ENCRYPTION_KEY_B64);
    expect(deps.fetchCalls).toBe(0);
    expect(deps.files[DEV_FILE]).toBe(envText({ AUTH_PEPPER: DEV.AUTH_PEPPER }));
  });

  it("says when every input is present, still without a network call", async () => {
    const deps = makeDeps({ ".env.local": envText(LIVE), [DEV_FILE]: envText(DEV) });
    await runDbCopy(["--dry-run", "--dev-env", DEV_FILE, "--reset"], deps);
    expect(deps.logs).toContain("all inputs present");
    expect(deps.logs[0]).toMatch(/reloading data \(--reset\)$/);
    expect(deps.fetchCalls).toBe(0);
  });

  it("a real run stops before the network with one sentence per missing input", async () => {
    const deps = makeDeps({ ".env.local": envText({ ...LIVE, SUPABASE_ACCESS_TOKEN: "", SUPABASE_URL: "https://nope.supabase.co" }), [DEV_FILE]: envText(DEV) });
    await expect(runDbCopy(["--dev-env", DEV_FILE], deps)).rejects.toThrow(
      "SUPABASE_ACCESS_TOKEN is missing from .env.local: a personal access token from https://supabase.com/dashboard/account/tokens.\nSUPABASE_URL must look like https://<20 letter ref>.supabase.co.",
    );
    expect(deps.fetchCalls).toBe(0);
  });

  it("refuses a dev env file that carries the live encryption key or pepper", async () => {
    const deps = makeDeps({ ".env.local": envText(LIVE), [DEV_FILE]: envText({ ...DEV, FIELD_ENCRYPTION_KEY_B64: LIVE.FIELD_ENCRYPTION_KEY_B64 }) });
    await expect(runDbCopy(["--dev-env", DEV_FILE], deps)).rejects.toThrow(`${DEV_FILE} holds the live FIELD_ENCRYPTION_KEY_B64; the copy needs its own, generate the file with node scripts/make-dev-env.mjs --tier core --new-environment --out ${DEV_FILE}.`);
    expect(deps.fetchCalls).toBe(0);
  });

  it("names the missing file", async () => {
    await expect(runDbCopy(["--dev-env", DEV_FILE], makeDeps({}))).rejects.toThrow(".env.local was not found in the repository root.");
    await expect(runDbCopy([], makeDeps({ ".env.local": envText(LIVE) }))).rejects.toThrow("--dev-env <file> is required");
    await expect(runDbCopy(["--dev-env", DEV_FILE], makeDeps({ ".env.local": envText(LIVE) }))).rejects.toThrow(`${DEV_FILE} was not found; run node scripts/make-dev-env.mjs --tier core --new-environment --out ${DEV_FILE} first.`);
  });

  it("quotes table names in the row count query", () => {
    expect(rowCountsSql(["users", `odd"name`])).toBe(`select 'users' as table_name, count(*)::int as n from public."users"\nunion all select 'odd"name' as table_name, count(*)::int as n from public."odd""name"`);
  });
});

// ---------------------------------------------------------------- a routed Supabase for the full run

type Call = { method: string; url: string; body: unknown; headers: Record<string, string> };

function routedFetch(opts: { existing: boolean; tableCount: number; initialRows: number; healthy?: boolean }) {
  const calls: Call[] = [];
  const liveKey = { kid: "field-v1", key: Buffer.from(LIVE.FIELD_ENCRYPTION_KEY_B64, "base64") };
  const email = sealEnvelope("kev@real.example", liveKey.key);
  const prompt = sealEnvelope("prompt body", liveKey.key);
  const userRow = { id: UUID, handle: "kev", email_ct: email.ct, email_iv: email.iv, email_tag: email.tag, email_kid: "field-v1", email_lookup_hash: emailLookupHash("kev@real.example") };
  const promptRow = { id: UUID, title: "t", encrypted_content: prompt.ct, encrypted_content_iv: prompt.iv, encrypted_content_tag: prompt.tag, encrypted_content_kid: "field-v1" };
  const project = (ref: string, over: Record<string, unknown> = {}) => ({ id: ref, ref, organization_id: "o", organization_slug: "enki", name: ref === SRC ? "enki-live" : "enki-dev", region: "eu-central-1", status: "ACTIVE_HEALTHY", database: { host: "x", version: "17.4.1.074" }, ...over });
  let countCalls = 0;
  let loaded = false;
  const state = { truncated: false, patches: [] as { url: string; body: Record<string, unknown> }[], extensionsCreated: [] as string[] };

  const targetQuery = (sql: string): unknown => {
    const q = sql.trim();
    if (q.startsWith("select e.extname")) return [{ extname: "pgcrypto", nspname: "extensions" }];
    if (q.startsWith("create schema")) { state.extensionsCreated.push(q); return []; }
    if (q.includes("count(*)::int as n from information_schema.tables")) return [{ n: opts.tableCount }];
    if (q.startsWith("notify")) return null;
    if (q.startsWith("select 'tables'")) return [{ kind: "tables", n: 3 }, { kind: "views", n: 1 }];
    if (q.startsWith("select c.table_name")) return [
      { table_name: "users", column_name: "id", udt_name: "uuid", pk: true },
      { table_name: "users", column_name: "handle", udt_name: "citext", pk: false },
      ...["email_ct", "email_iv", "email_tag", "email_kid", "email_lookup_hash"].map((c) => ({ table_name: "users", column_name: c, udt_name: "text", pk: false })),
      { table_name: "prompts", column_name: "id", udt_name: "uuid", pk: true },
      { table_name: "prompts", column_name: "title", udt_name: "text", pk: false },
      ...["encrypted_content", "encrypted_content_iv", "encrypted_content_tag", "encrypted_content_kid"].map((c) => ({ table_name: "prompts", column_name: c, udt_name: "text", pk: false })),
      { table_name: "auth_sessions", column_name: "id", udt_name: "uuid", pk: true },
      { table_name: "auth_sessions", column_name: "token", udt_name: "text", pk: false },
    ];
    if (q.startsWith("select 'auth_sessions' as table_name")) {
      const n = countCalls++ === 0 ? opts.initialRows : loaded ? 1 : 0;
      return [{ table_name: "auth_sessions", n: 0 }, { table_name: "prompts", n }, { table_name: "users", n }];
    }
    if (q.startsWith("truncate table")) { state.truncated = true; return []; }
    throw new Error(`unexpected target query: ${q.slice(0, 60)}`);
  };

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body, headers: (init?.headers ?? {}) as Record<string, string> });
    const json = (data: unknown, status = 200) => new Response(data === null ? "" : JSON.stringify(data), { status });
    if (url === `https://api.supabase.com/v1/projects/${SRC}`) return json(project(SRC));
    if (url === "https://api.supabase.com/v1/organizations") return json([{ id: "o", slug: "enki", name: "Enki" }]);
    if (url === "https://api.supabase.com/v1/projects" && method === "GET") return json(opts.existing ? [project(SRC), project(TGT)] : [project(SRC)]);
    if (url === "https://api.supabase.com/v1/projects" && method === "POST") return json(project(TGT, { status: "COMING_UP" }), 201);
    if (url === `https://api.supabase.com/v1/projects/${TGT}`) return json(project(TGT));
    if (url === `https://api.supabase.com/v1/projects/${TGT}/health?services=db,rest,pooler`) return json(["db", "rest", "pooler"].map((name) => ({ name, healthy: opts.healthy !== false, status: "ACTIVE_HEALTHY" })));
    if (url === `https://api.supabase.com/v1/projects/${TGT}/api-keys?reveal=true`) return json([{ name: "anon", api_key: "eyJ-anon-key", type: "legacy" }, { name: "service_role", api_key: "eyJ-service-key", type: "legacy" }]);
    if (url === `https://api.supabase.com/v1/projects/${SRC}/config/database/pooler`) return json([{ database_type: "PRIMARY", db_host: "aws-1-eu-central-1.pooler.supabase.com", db_user: `postgres.${SRC}`, pool_mode: "transaction" }]);
    if (url === `https://api.supabase.com/v1/projects/${TGT}/config/database/pooler`) return json({ message: "not yet" }, 404);
    if (url === `https://api.supabase.com/v1/projects/${SRC}/database/query`) {
      const q = String((body as { query: string }).query).trim();
      if (q.startsWith("select e.extname")) return json([{ extname: "citext", nspname: "public" }, { extname: "pgcrypto", nspname: "extensions" }], 201);
      throw new Error(`unexpected live query: ${q.slice(0, 60)}`);
    }
    if (url === `https://api.supabase.com/v1/projects/${TGT}/database/query`) return json(targetQuery(String((body as { query: string }).query)), 201);
    if (url.startsWith(`https://${TGT}.supabase.co/rest/v1/users?select=*&order=id`)) return json([userRow]);
    if (url.startsWith(`https://${TGT}.supabase.co/rest/v1/prompts?select=*&order=id`)) return json([promptRow]);
    if (url.startsWith(`https://${TGT}.supabase.co/rest/v1/`) && method === "PATCH") { state.patches.push({ url, body: body as Record<string, unknown> }); return new Response(null, { status: 204 }); }
    throw new Error(`unexpected ${method} ${url}`);
  }) as typeof fetch;

  const runImpl: Deps["run"] = async (command, args) => {
    if (args[0] === "--version") return { code: 0, stdout: "pg_dump (PostgreSQL) 18.6", stderr: "" };
    if (command.endsWith("psql") && args.some((a) => a.endsWith("data.sql"))) loaded = true;
    return { code: 0, stdout: "", stderr: "" };
  };
  return { fetchImpl, runImpl, calls, state, userRow, promptRow };
}

describe("the full run against a routed Supabase", () => {
  it("creates the copy, loads it, re-keys it, writes the dev env file, and never writes to the live project or logs a secret", async () => {
    const live = routedFetch({ existing: false, tableCount: 0, initialRows: 0 });
    const deps = makeDeps({ ".env.local": envText(LIVE), [DEV_FILE]: envText(DEV) }, {
      fetch: live.fetchImpl,
      run: async (command, args, extraEnv) => { deps.runs.push({ command, args, extraEnv }); return live.runImpl(command, args, extraEnv); },
      which: (c) => `C:/pg/bin/${c}`,
    });
    const out = await runDbCopy(["--dev-env", DEV_FILE], deps);

    // the live project was only read
    for (const c of live.calls.filter((c) => c.url.includes(SRC))) {
      const query = (c.body as { query?: string; read_only?: boolean } | undefined);
      expect(c.method === "GET" || (query?.read_only === true && /^select/i.test(query.query ?? ""))).toBe(true);
    }
    expect(live.calls.some((c) => c.url.startsWith(`https://${SRC}.supabase.co`))).toBe(false);

    // extensions: only the missing one, in its source schema
    expect(live.state.extensionsCreated).toEqual([`create schema if not exists "public"; create extension if not exists "citext" with schema "public"`]);

    // pg_dump and psql: passwords through PGPASSWORD, URLs without them, the right flags
    const dev = parseEnv(deps.files[DEV_FILE]);
    const [schemaDump, schemaLoad, dataDump, dataLoad] = deps.runs.filter((r) => r.args[0] !== "--version");
    expect(schemaDump.args).toEqual(["--schema-only", "--schema=public", "--no-owner", "--no-privileges", "--file", `C:/Temp/enki-db-copy-${TGT}/schema.sql`, "--dbname", `postgresql://postgres.${SRC}@aws-1-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require`]);
    expect(schemaDump.extraEnv).toEqual({ PGPASSWORD: LIVE.SUPABASE_DB_PASSWORD });
    expect(schemaLoad.args).toEqual(["--variable", "ON_ERROR_STOP=1", "--quiet", "--file", `C:/Temp/enki-db-copy-${TGT}/schema.sql`, "--dbname", `postgresql://postgres.${TGT}@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require`]);
    expect(schemaLoad.extraEnv).toEqual({ PGPASSWORD: dev.SUPABASE_DB_PASSWORD_DEV });
    expect(dataDump.args).toContain("--data-only");
    expect(dataDump.args).toContain("--exclude-table-data=public.auth_sessions");
    expect(dataDump.args.filter((a) => a.startsWith("--exclude-table-data"))).toHaveLength(1);
    expect(dataLoad.args.slice(3, 5)).toEqual(["--command", "SET session_replication_role = replica"]);
    expect(deps.runs.flatMap((r) => r.args).join(" ")).not.toMatch(new RegExp(`${LIVE.SUPABASE_DB_PASSWORD}|${dev.SUPABASE_DB_PASSWORD_DEV}`));
    expect(deps.removed).toEqual([`C:/Temp/enki-db-copy-${TGT}/schema.sql`, `C:/Temp/enki-db-copy-${TGT}/data.sql`]);

    // the dev env file received the copy's coordinates, nothing else changed
    expect(dev).toMatchObject({ ...DEV, SUPABASE_URL: `https://${TGT}.supabase.co`, SUPABASE_ANON_KEY: "eyJ-anon-key", SUPABASE_SERVICE_ROLE_KEY: "eyJ-service-key" });
    expect(dev.SUPABASE_DB_PASSWORD_DEV).toMatch(/^[A-HJ-NP-Za-km-z2-9]{32}$/);

    // re-key on the copy: users got a pseudonym sealed with the dev key, prompts got re-keyed, auth_sessions untouched
    const devKey = [{ kid: "field-v1", key: Buffer.from(DEV.FIELD_ENCRYPTION_KEY_B64, "base64") }];
    const users = live.state.patches.find((p) => p.url.includes("/users?"))!;
    expect(users.url).toBe(`https://${TGT}.supabase.co/rest/v1/users?id=eq.${UUID}`);
    expect(Object.keys(users.body).sort()).toEqual(["email_ct", "email_iv", "email_lookup_hash", "email_tag"]);
    expect(openEnvelope({ ct: String(users.body.email_ct), iv: String(users.body.email_iv), tag: String(users.body.email_tag) }, devKey)).toBe(`user-${UUID.slice(0, 8)}@example.test`);
    const prompts = live.state.patches.find((p) => p.url.includes("/prompts?"))!;
    expect(Object.keys(prompts.body).sort()).toEqual(["encrypted_content", "encrypted_content_iv", "encrypted_content_tag"]);
    expect(openEnvelope({ ct: String(prompts.body.encrypted_content), iv: String(prompts.body.encrypted_content_iv), tag: String(prompts.body.encrypted_content_tag) }, devKey)).toBe("prompt body");
    expect(live.state.patches).toHaveLength(2);
    expect(live.calls.some((c) => c.url.includes("/rest/v1/auth_sessions"))).toBe(false);
    expect(live.state.truncated).toBe(false);

    expect(out).toMatchObject({ dryRun: false, targetRef: TGT, tables: 3, rows: { users: 1, prompts: 1, auth_sessions: 0 }, rekeyed: 1, decryptFailures: 0, pseudonyms: 1, patchFailures: 0 });

    // nothing secret in the log
    const log = deps.logs.join("\n");
    for (const secret of [LIVE.SUPABASE_ACCESS_TOKEN, LIVE.SUPABASE_DB_PASSWORD, LIVE.FIELD_ENCRYPTION_KEY_B64, LIVE.AUTH_PEPPER, DEV.FIELD_ENCRYPTION_KEY_B64, DEV.AUTH_PEPPER, dev.SUPABASE_DB_PASSWORD_DEV, "eyJ-anon-key", "eyJ-service-key", live.userRow.email_ct]) {
      expect(log).not.toContain(secret);
    }
    expect(log).toContain(`project: ${TGT} created in eu-central-1`);
    expect(log).toContain("extensions: 2 on the live project, 1 created on the copy");
    expect(log).toContain("  users: 1 rows, 0 envelopes re-keyed, 0 undecryptable, 1 pseudonymised, 1 patched");
    expect(log).toMatch(/^report: project targettargettargetta, 3 tables, 1 envelopes re-keyed, 0 decrypt failures, 1 rows pseudonymised, 7 tables structure only, 0 patch failures, 0 s$/m);
  });

  it("reuses an existing copy only with its password, skips the schema, and reloads data only with --reset", async () => {
    const files = { ".env.local": envText(LIVE), [DEV_FILE]: envText(DEV) };
    const noPassword = makeDeps(files, { fetch: routedFetch({ existing: true, tableCount: 3, initialRows: 5 }).fetchImpl, which: (c) => c });
    await expect(runDbCopy(["--dev-env", DEV_FILE], noPassword)).rejects.toThrow(`Project "enki-dev" (${TGT}) exists but SUPABASE_DB_PASSWORD_DEV is not in ${DEV_FILE}; add it or delete the project so it can be recreated.`);
    expect(noPassword.files[DEV_FILE]).toBe(files[DEV_FILE]);

    const withPassword = { ...files, [DEV_FILE]: envText({ ...DEV, SUPABASE_DB_PASSWORD_DEV: "existing-copy-password" }) };
    const full = routedFetch({ existing: true, tableCount: 3, initialRows: 5 });
    const noReset = makeDeps(withPassword, { fetch: full.fetchImpl, run: full.runImpl, which: (c) => c });
    await expect(runDbCopy(["--dev-env", DEV_FILE], noReset)).rejects.toThrow("The copy already holds data in 2 tables; pass --reset to reload it.");
    expect(noReset.logs).toContain("schema: 3 tables already present, skipped (delete the project to rebuild the schema)");
    expect(full.state.truncated).toBe(false);

    const again = routedFetch({ existing: true, tableCount: 3, initialRows: 5 });
    const reset = makeDeps(withPassword, { fetch: again.fetchImpl, run: async (command, args, extraEnv) => { reset.runs.push({ command, args, extraEnv }); return again.runImpl(command, args, extraEnv); }, which: (c) => c });
    const out = await runDbCopy(["--dev-env", DEV_FILE, "--reset"], reset);
    expect(again.state.truncated).toBe(true);
    expect(reset.logs).toContain("reset: 2 tables truncated");
    expect(reset.runs.some((r) => r.args.includes("--schema-only"))).toBe(false);
    expect(reset.runs.filter((r) => r.command === "psql").every((r) => r.extraEnv.PGPASSWORD === "existing-copy-password")).toBe(true);
    expect(out).toMatchObject({ targetRef: TGT, rekeyed: 1, pseudonyms: 1 });
  });

  it("refuses to treat the live project as the copy", async () => {
    const same = routedFetch({ existing: false, tableCount: 0, initialRows: 0 });
    const deps = makeDeps({ ".env.local": envText(LIVE), [DEV_FILE]: envText(DEV) }, { fetch: same.fetchImpl, run: same.runImpl, which: (c) => c });
    await expect(runDbCopy(["--dev-env", DEV_FILE, "--name", "enki-live"], deps)).rejects.toThrow(`"enki-live" is the live project itself; pick another --name.`);
    expect(deps.runs).toHaveLength(0);
    expect(same.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });

  it("schema only with --skip-data loads no data and reads no rows", async () => {
    const live = routedFetch({ existing: false, tableCount: 0, initialRows: 0 });
    const deps = makeDeps({ ".env.local": envText(LIVE), [DEV_FILE]: envText(DEV) }, { fetch: live.fetchImpl, run: async (command, args, extraEnv) => { deps.runs.push({ command, args, extraEnv }); return live.runImpl(command, args, extraEnv); }, which: (c) => c });
    const out = await runDbCopy(["--dev-env", DEV_FILE, "--skip-data"], deps);
    expect(deps.runs.filter((r) => r.args[0] !== "--version").map((r) => r.args[0])).toEqual(["--schema-only", "--variable"]);
    expect(live.state.patches).toHaveLength(0);
    expect(out.rows).toBeUndefined();
    expect(deps.logs.at(-1)).toBe("done in 0 s (schema only)");
  });
});
