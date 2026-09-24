/**
 * The whole db-copy run with every side effect injected, so a dry run and the
 * guards are unit tested with fixtures and a fetch that throws. The thin
 * launcher scripts/db-copy.mjs supplies the real file system, child processes
 * and network. Steps and the reasoning behind them: docs/DEV-ENV.md.
 *
 * Nothing in this file prints a value from either environment file. Logged
 * are table names, counts, project refs, statuses and the names of variables.
 */
import { generateDbPassword, missingInputs, parseEnv, projectRef, upsertEnv, type Env } from "./env.ts";
import { cacheBinDir, majorVersion, PG_ZIP_MEMBERS, PG_ZIP_URL, planPgTools, type PgTools } from "./pg-tools.ts";
import { poolerHostFromConfig, poolerUrl } from "./pooler.ts";
import {
  EMPTIED_TABLES,
  keyringFromEnv,
  paginate,
  rowPatch,
  sanitiseTable,
  tableNeedsSanitising,
  tablesFromColumns,
  type Row,
  type SanitiseContext,
  type TableSpec,
} from "./snapshot-sanitise.ts";
import { createManagementClient, findOrCreateProject, pickApiKeys, waitUntilHealthy, type ManagementClient } from "./supabase-management.ts";

export type Options = { name: string; devEnv: string | null; dryRun: boolean; reset: boolean; skipData: boolean };

export type Deps = {
  fetch: typeof fetch;
  /** Spawn without a shell; `extraEnv` is merged into the child's environment (PGPASSWORD travels here). */
  run: (command: string, args: string[], extraEnv: Record<string, string>) => Promise<{ code: number; stdout: string; stderr: string }>;
  readFile: (path: string) => string | null;
  writeFile: (path: string, text: string) => void;
  remove: (path: string) => void;
  exists: (path: string) => boolean;
  mkdir: (path: string) => void;
  which: (command: string) => string | null;
  download: (url: string, dest: string) => Promise<void>;
  tmpdir: string;
  platform: string;
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  randomBytes: (n: number) => Uint8Array;
  now: () => number;
};

export const SOURCE_INPUTS = ["SUPABASE_URL", "SUPABASE_ACCESS_TOKEN", "SUPABASE_DB_PASSWORD", "FIELD_ENCRYPTION_KEY_B64", "AUTH_PEPPER"];
export const DEV_INPUTS = ["FIELD_ENCRYPTION_KEY_B64", "AUTH_PEPPER"];

export function parseArgs(argv: string[]): Options {
  const opts: Options = { name: "enki-dev", devEnv: null, dryRun: false, reset: false, skipData: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => { const v = argv[++i]; if (!v || v.startsWith("--")) throw new Error(`${a} needs a value.`); return v; };
    if (a === "--name") opts.name = value();
    else if (a === "--dev-env") opts.devEnv = value();
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--reset") opts.reset = true;
    else if (a === "--skip-data") opts.skipData = true;
    else throw new Error(`Unknown option ${a}. Known: --dev-env <file>, --name <project>, --dry-run, --reset, --skip-data.`);
  }
  return opts;
}

// ---------------------------------------------------------------- SQL run through the Management API

const EXTENSIONS_SQL = "select e.extname, n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace order by 1";
const COLUMNS_SQL = `
select c.table_name, c.column_name, c.udt_name, (k.column_name is not null) as pk
from information_schema.columns c
join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
left join (
  select kcu.table_name, kcu.column_name
  from information_schema.table_constraints tc
  join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
  where tc.constraint_type = 'PRIMARY KEY' and tc.table_schema = 'public'
) k on k.table_name = c.table_name and k.column_name = c.column_name
where c.table_schema = 'public'
order by c.table_name, c.ordinal_position`;
const OBJECTS_SQL = `
select 'tables' as kind, count(*)::int as n from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'
union all select 'views', count(*)::int from information_schema.views where table_schema = 'public'
union all select 'functions', count(*)::int from information_schema.routines where routine_schema = 'public'
union all select 'sequences', count(*)::int from information_schema.sequences where sequence_schema = 'public'
union all select 'indexes', count(*)::int from pg_indexes where schemaname = 'public'
union all select 'policies', count(*)::int from pg_policies where schemaname = 'public'
union all select 'triggers', count(distinct trigger_name)::int from information_schema.triggers where trigger_schema = 'public'`;

const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;
const quoteText = (s: string) => `'${s.replace(/'/g, "''")}'`;

export const rowCountsSql = (tables: string[]): string =>
  tables.map((t) => `select ${quoteText(t)} as table_name, count(*)::int as n from public.${quoteIdent(t)}`).join("\nunion all ");

// ---------------------------------------------------------------- PostgREST on the copy

function createRest(baseUrl: string, serviceKey: string, fetchImpl: typeof fetch) {
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };
  const filterQuery = (filter: Record<string, unknown>) =>
    Object.entries(filter).map(([k, v]) => `${encodeURIComponent(k)}=eq.${encodeURIComponent(String(v))}`).join("&");
  return {
    async select(table: TableSpec, from: number, to: number): Promise<Row[]> {
      const order = table.columns.filter((c) => c.pk).map((c) => c.name).join(",");
      const res = await fetchImpl(`${baseUrl}/rest/v1/${table.name}?select=*${order ? `&order=${order}` : ""}`, {
        headers: { ...headers, Range: `${from}-${to}`, "Range-Unit": "items" },
      });
      if (!res.ok) throw new Error(`Reading ${table.name} from the copy answered ${res.status}.`);
      return (await res.json()) as Row[];
    },
    /** True on success; on failure the PostgREST code and message, never its details (they can quote row values). */
    async patch(table: TableSpec, filter: Record<string, unknown>, body: Row): Promise<string | null> {
      const res = await fetchImpl(`${baseUrl}/rest/v1/${table.name}?${filterQuery(filter)}`, {
        method: "PATCH",
        headers: { ...headers, Prefer: "return=minimal" },
        body: JSON.stringify(body),
      });
      if (res.ok) return null;
      let reason = `HTTP ${res.status}`;
      try { const e = (await res.json()) as { code?: string; message?: string }; reason = `${e.code ?? res.status} ${e.message ?? ""}`.trim(); } catch { /* keep the status */ }
      return reason;
    },
  };
}

// ---------------------------------------------------------------- the run

export type Summary = {
  dryRun: boolean;
  targetRef?: string;
  tables?: number;
  rows?: Record<string, number>;
  rekeyed?: number;
  decryptFailures?: number;
  pseudonyms?: number;
  emptied?: string[];
  patchFailures?: number;
  elapsedMs?: number;
};

export async function runDbCopy(argv: string[], deps: Deps): Promise<Summary> {
  const opts = parseArgs(argv);
  const started = deps.now();
  const log = deps.log;

  const envText = deps.readFile(".env.local");
  if (envText === null) throw new Error(".env.local was not found in the repository root.");
  const env = parseEnv(envText);
  const devEnvPath = opts.devEnv;
  if (!devEnvPath) throw new Error("--dev-env <file> is required: the developer environment file written by scripts/make-dev-env.mjs --new-environment.");
  const devText = deps.readFile(devEnvPath);
  const generate = `node scripts/make-dev-env.mjs --tier core --new-environment --out ${devEnvPath}`;
  if (devText === null) throw new Error(`${devEnvPath} was not found; run ${generate} first.`);
  const dev = parseEnv(devText);

  const missing = [
    ...missingInputs(env, SOURCE_INPUTS, ".env.local"),
    ...DEV_INPUTS.filter((n) => !dev[n]?.trim()).map((n) => `${n} is missing from ${devEnvPath}; generate the file with ${generate}.`),
  ];
  let sourceRef = "(unknown until SUPABASE_URL is set)";
  if (env.SUPABASE_URL) {
    try { sourceRef = projectRef(env.SUPABASE_URL); } catch (e) { missing.push((e as Error).message); }
  }
  for (const name of DEV_INPUTS) {
    if (env[name] && dev[name] && env[name] === dev[name]) missing.push(`${devEnvPath} holds the live ${name}; the copy needs its own, generate the file with ${generate}.`);
  }
  const emptied = [...EMPTIED_TABLES];
  const tools = planPgTools({ env, platform: deps.platform, tmpdir: deps.tmpdir, exists: deps.exists, which: deps.which });

  log(`plan: copy live project ${sourceRef} into Supabase project "${opts.name}"${opts.reset ? ", reloading data (--reset)" : ""}${opts.skipData ? ", schema only (--skip-data)" : ""}`);
  log(`  1 find or create "${opts.name}" in the live project's organization and region, wait until healthy, fetch its keys`);
  log(`  2 create the live project's extensions on the copy`);
  log(`  3 pg_dump the public schema over the session pooler, psql it into the copy (pg tools: ${tools.source})`);
  log(`  4 pg_dump the data and load it with session_replication_role = replica; structure only: ${emptied.join(", ")}`);
  log(`  5 re-key every envelope to the dev key, pseudonymise emails, reset passwords to the dev password, null tokens and ip hashes`);
  log(`  6 write SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_DB_PASSWORD_DEV into ${devEnvPath}`);
  if (opts.dryRun) {
    log(missing.length ? `inputs still missing (${missing.length}):` : "all inputs present");
    for (const m of missing) log(`  ${m}`);
    return { dryRun: true };
  }
  if (missing.length) throw new Error(missing.join("\n"));

  const devKey = Buffer.from(dev.FIELD_ENCRYPTION_KEY_B64, "base64");
  if (devKey.length !== 32) throw new Error(`FIELD_ENCRYPTION_KEY_B64 in ${devEnvPath} must decode to 32 bytes.`);
  const prodKeys = keyringFromEnv(env);

  // 1. project
  const mgmt = createManagementClient(env.SUPABASE_ACCESS_TOKEN, deps.fetch);
  const source = await mgmt.project(sourceRef);
  if (source.status === "INACTIVE") throw new Error(`The live project ${sourceRef} is paused; restore it in the dashboard first.`);
  let freshPassword: string | null = null;
  const { project: target, created } = await findOrCreateProject(mgmt, {
    name: opts.name,
    organizationSlug: source.organization_slug,
    region: source.region,
    dbPass: () => (freshPassword = generateDbPassword(deps.randomBytes)),
  });
  if (target.ref === sourceRef) throw new Error(`"${opts.name}" is the live project itself; pick another --name.`);
  const targetPassword = freshPassword ?? dev.SUPABASE_DB_PASSWORD_DEV;
  if (!targetPassword) throw new Error(`Project "${opts.name}" (${target.ref}) exists but SUPABASE_DB_PASSWORD_DEV is not in ${devEnvPath}; add it or delete the project so it can be recreated.`);
  const writeDevEnv = (values: Env) => deps.writeFile(devEnvPath, upsertEnv(deps.readFile(devEnvPath) ?? "", values));
  if (created) writeDevEnv({ SUPABASE_URL: `https://${target.ref}.supabase.co`, SUPABASE_DB_PASSWORD_DEV: targetPassword });
  log(`project: ${target.ref} ${created ? "created" : "reused"} in ${target.region}`);
  await waitUntilHealthy(mgmt, target.ref, { sleep: deps.sleep, onPoll: (s) => log(`  ${s}`) });
  const keys = pickApiKeys(await mgmt.apiKeys(target.ref));
  writeDevEnv({ SUPABASE_URL: `https://${target.ref}.supabase.co`, SUPABASE_ANON_KEY: keys.anon, SUPABASE_SERVICE_ROLE_KEY: keys.serviceRole, SUPABASE_DB_PASSWORD_DEV: targetPassword });
  log(`  ${devEnvPath}: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DB_PASSWORD_DEV written`);

  // 2. extensions
  await copyExtensions(mgmt, sourceRef, target.ref, log);

  // pg tools and pooler addresses
  const pg = await ensurePgTools(tools, deps);
  const dumpMajor = majorVersion((await deps.run(pg.pgDump, ["--version"], {})).stdout);
  const serverMajor = majorVersion(source.database?.version ?? "");
  if (dumpMajor && serverMajor && dumpMajor < serverMajor) throw new Error(`pg_dump ${dumpMajor} cannot dump a PostgreSQL ${serverMajor} server; set PG_BIN to a newer installation.`);
  log(`pg tools: ${pg.source}, pg_dump ${dumpMajor ?? "?"}, server ${serverMajor ?? "?"}`);
  const sourceUrl = poolerUrl({ host: poolerHostFromConfig(await mgmt.poolerConfig(sourceRef).catch(() => null), source.region), ref: sourceRef });
  const targetUrl = poolerUrl({ host: poolerHostFromConfig(await mgmt.poolerConfig(target.ref).catch(() => null), target.region), ref: target.ref });
  const workDir = `${deps.tmpdir}/enki-db-copy-${target.ref}`;
  deps.mkdir(workDir);
  const sh = async (command: string, args: string[], password: string, what: string) => {
    const r = await deps.run(command, args, { PGPASSWORD: password });
    if (r.code !== 0) throw new Error(`${what} failed (exit ${r.code}): ${r.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400)}`);
  };
  const psqlArgs = (file: string, before?: string) => ["--variable", "ON_ERROR_STOP=1", "--quiet", ...(before ? ["--command", before] : []), "--file", file, "--dbname", targetUrl];

  // 3. schema
  const tablesBefore = (await mgmt.query<{ n: number }>(target.ref, "select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'"))[0]?.n ?? 0;
  if (tablesBefore > 0) {
    log(`schema: ${tablesBefore} tables already present, skipped (delete the project to rebuild the schema)`);
  } else {
    const schemaFile = `${workDir}/schema.sql`;
    await sh(pg.pgDump, ["--schema-only", "--schema=public", "--no-owner", "--no-privileges", "--file", schemaFile, "--dbname", sourceUrl], env.SUPABASE_DB_PASSWORD, "pg_dump of the schema");
    await sh(pg.psql, psqlArgs(schemaFile), targetPassword, "psql loading the schema");
    deps.remove(schemaFile);
    await mgmt.query(target.ref, "notify pgrst, 'reload schema'");
    const objects = await mgmt.query<{ kind: string; n: number }>(target.ref, OBJECTS_SQL);
    log(`schema: ${objects.map((o) => `${o.kind} ${o.n}`).join(", ")}`);
  }

  const summary: Summary = { dryRun: false, targetRef: target.ref, emptied, elapsedMs: 0 };
  if (opts.skipData) {
    summary.elapsedMs = deps.now() - started;
    log(`done in ${Math.round(summary.elapsedMs / 1000)} s (schema only)`);
    return summary;
  }

  // 4. data
  const tables = tablesFromColumns(await mgmt.query<{ table_name: string; column_name: string; udt_name: string; pk: boolean }>(target.ref, COLUMNS_SQL));
  const names = tables.map((t) => t.name);
  const counts = async () => Object.fromEntries((await mgmt.query<{ table_name: string; n: number }>(target.ref, rowCountsSql(names))).map((r) => [r.table_name, r.n]));
  const before = await counts();
  const populated = Object.values(before).filter((n) => n > 0).length;
  if (populated > 0 && !opts.reset) throw new Error(`The copy already holds data in ${populated} tables; pass --reset to reload it.`);
  if (populated > 0) {
    await mgmt.query(target.ref, `truncate table ${names.map((n) => `public.${quoteIdent(n)}`).join(", ")} cascade`);
    log(`reset: ${populated} tables truncated`);
  }
  const dataFile = `${workDir}/data.sql`;
  const exclude = emptied.filter((t) => names.includes(t)).map((t) => `--exclude-table-data=public.${t}`);
  await sh(pg.pgDump, ["--data-only", "--schema=public", ...exclude, "--file", dataFile, "--dbname", sourceUrl], env.SUPABASE_DB_PASSWORD, "pg_dump of the data");
  await sh(pg.psql, psqlArgs(dataFile, "SET session_replication_role = replica"), targetPassword, "psql loading the data");
  deps.remove(dataFile);
  summary.rows = await counts();
  summary.tables = names.length;
  log(`data: ${names.length} tables, ${Object.values(summary.rows).reduce((a, b) => a + b, 0)} rows`);
  for (const t of names) log(`  ${t} ${summary.rows[t]}${emptied.includes(t) ? " (structure only)" : ""}`);

  // 5. re-key and sanitise on the copy
  const ctx: SanitiseContext = { prodKeys, devKey, devPepperB64: dev.AUTH_PEPPER };
  const rest = createRest(`https://${target.ref}.supabase.co`, keys.serviceRole, deps.fetch);
  let rekeyed = 0, decryptFailures = 0, pseudonyms = 0, patchFailures = 0;
  for (const table of tables) {
    if (emptied.includes(table.name) || !tableNeedsSanitising(table) || summary.rows[table.name] === 0) continue;
    const rows = await paginate((from, to) => rest.select(table, from, to));
    const { rows: after, stats } = sanitiseTable(table, rows, ctx);
    const patches = rows.map((r, i) => rowPatch(table, r, after[i])).filter((p) => p !== null);
    const failures = new Map<string, number>();
    for (let i = 0; i < patches.length; i += 8) {
      const results = await Promise.all(patches.slice(i, i + 8).map((p) => rest.patch(table, p.filter, p.body)));
      for (const r of results) if (r) failures.set(r, (failures.get(r) ?? 0) + 1);
    }
    const failed = [...failures.values()].reduce((a, b) => a + b, 0);
    rekeyed += stats.rekeyed; decryptFailures += stats.decryptFailures; pseudonyms += stats.pseudonyms; patchFailures += failed;
    log(`  ${table.name}: ${rows.length} rows, ${stats.rekeyed} envelopes re-keyed, ${stats.decryptFailures} undecryptable, ${stats.pseudonyms} pseudonymised, ${patches.length} patched${failed ? `, ${failed} failed (${[...failures.keys()].join("; ")})` : ""}`);
  }
  const elapsedMs = deps.now() - started;
  log(`report: project ${target.ref}, ${names.length} tables, ${rekeyed} envelopes re-keyed, ${decryptFailures} decrypt failures, ${pseudonyms} rows pseudonymised, ${emptied.length} tables structure only, ${patchFailures} patch failures, ${Math.round(elapsedMs / 1000)} s`);
  return { ...summary, rekeyed, decryptFailures, pseudonyms, patchFailures, elapsedMs };
}

async function copyExtensions(mgmt: ManagementClient, sourceRef: string, targetRef: string, log: (s: string) => void): Promise<void> {
  type Ext = { extname: string; nspname: string };
  const source = await mgmt.query<Ext>(sourceRef, EXTENSIONS_SQL, true);
  const present = new Set((await mgmt.query<Ext>(targetRef, EXTENSIONS_SQL, true)).map((e) => e.extname));
  const failed: string[] = [];
  let created = 0;
  for (const e of source) {
    if (present.has(e.extname)) continue;
    try {
      await mgmt.query(targetRef, `create schema if not exists ${quoteIdent(e.nspname)}; create extension if not exists ${quoteIdent(e.extname)} with schema ${quoteIdent(e.nspname)}`);
      created++;
    } catch {
      failed.push(e.extname);
    }
  }
  log(`extensions: ${source.length} on the live project, ${created} created on the copy${failed.length ? `, failed: ${failed.join(", ")}` : ""}`);
}

async function ensurePgTools(tools: PgTools, deps: Deps): Promise<PgTools> {
  if (tools.source !== "download") return tools;
  const cacheRoot = cacheBinDir(deps.tmpdir).replace(/\/pgsql\/bin$/, "");
  deps.mkdir(cacheRoot);
  const zip = `${cacheRoot}/postgresql-windows-x64-binaries.zip`;
  if (!deps.exists(zip)) {
    deps.log(`pg tools: downloading ${PG_ZIP_URL} (about 340 MB, once)`);
    await deps.download(PG_ZIP_URL, zip);
  }
  const r = await deps.run("tar", ["-xf", zip, "-C", cacheRoot, ...PG_ZIP_MEMBERS], {});
  if (r.code !== 0 || !deps.exists(tools.pgDump) || !deps.exists(tools.psql)) {
    throw new Error(`Extracting pg_dump and psql from ${zip} failed; install PostgreSQL and set PG_BIN to its bin directory.`);
  }
  deps.remove(zip);
  return tools;
}
