/**
 * Where pg_dump and psql come from, without Docker and without a dependency.
 * Order: PG_BIN, the PATH, the download cache under the OS temp dir, then a
 * download of the official EDB zip archive of the PostgreSQL 18 Windows
 * binaries (https://www.enterprisedb.com/download-postgresql-binaries). Only
 * pgsql/bin/pg_dump.exe, psql.exe and their DLLs are extracted, with the
 * tar.exe that ships with Windows 10 and later.
 *
 * @embedded-postgres/windows-x64 was checked on 2026-09-24: its tarball holds
 * initdb, pg_ctl and postgres only, no pg_dump and no psql.
 */

export const PG_ZIP_URL = "https://get.enterprisedb.com/postgresql/postgresql-18.6-1-windows-x64-binaries.zip";
/**
 * SHA-256 of that archive, 343808005 bytes, computed on 2026-09-24 from a
 * download over TLS from get.enterprisedb.com whose pg_dump.exe and psql.exe
 * report 18.6. EDB publishes no checksum and does not sign the binaries in
 * the zip (only its installer), so this pin catches a swapped, truncated or
 * proxied archive later, not a wrong first download. Re-verify with
 * `certutil -hashfile <zip> SHA256` and update it when PG_ZIP_URL changes.
 */
export const PG_ZIP_SHA256 = "fbe23da234ee31547bf8a36d29dfd81e82b849df2d2b78d2eecb43d360252f8c";
export const PG_ZIP_MEMBERS = ["pgsql/bin/pg_dump.exe", "pgsql/bin/psql.exe", "pgsql/bin/*.dll"];
export const CACHE_DIR = "enki-pg-bin";

export type PgTools = { pgDump: string; psql: string; source: "PG_BIN" | "PATH" | "cache" | "download" };

export type PgToolsProbe = {
  env: Record<string, string | undefined>;
  platform: string;
  tmpdir: string;
  exists: (path: string) => boolean;
  /** The absolute path of a command on the PATH, or null. */
  which: (command: string) => string | null;
};

const join = (...parts: string[]) => parts.join("/").replace(/\\/g, "/").replace(/\/+/g, "/");

export const cacheBinDir = (tmpdir: string) => join(tmpdir, CACHE_DIR, "pgsql", "bin");

/** Where the binaries are, or where a download would put them (`source: "download"`). */
export function planPgTools(probe: PgToolsProbe): PgTools {
  const exe = probe.platform === "win32" ? ".exe" : "";
  const pair = (dir: string) => ({ pgDump: join(dir, `pg_dump${exe}`), psql: join(dir, `psql${exe}`) });
  if (probe.env.PG_BIN) {
    const p = pair(probe.env.PG_BIN);
    if (!probe.exists(p.pgDump) || !probe.exists(p.psql)) throw new Error(`PG_BIN is set but pg_dump and psql were not found in ${probe.env.PG_BIN}.`);
    return { ...p, source: "PG_BIN" };
  }
  const onPath = probe.which("pg_dump");
  const psqlOnPath = probe.which("psql");
  if (onPath && psqlOnPath) return { pgDump: onPath, psql: psqlOnPath, source: "PATH" };
  const cached = pair(cacheBinDir(probe.tmpdir));
  if (probe.exists(cached.pgDump) && probe.exists(cached.psql)) return { ...cached, source: "cache" };
  if (probe.platform !== "win32") {
    throw new Error("pg_dump and psql were not found; install the PostgreSQL client tools (postgresql-client) or set PG_BIN to their directory.");
  }
  return { ...cached, source: "download" };
}

/** Major version from `pg_dump --version` output, or from a Supabase database version like 17.4.1.074. */
export function majorVersion(text: string): number | null {
  const m = /(\d+)\.\d+/.exec(text);
  return m ? Number(m[1]) : null;
}
