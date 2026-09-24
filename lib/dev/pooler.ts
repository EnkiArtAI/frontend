/**
 * Supavisor session pooler addresses. The direct host db.<ref>.supabase.co is
 * IPv6 only on the free plan; the shared pooler is IPv4 on every plan and
 * speaks plain Postgres in session mode on port 5432, which is what pg_dump and
 * psql need (https://supabase.com/docs/guides/database/connecting-to-postgres).
 */

export const SESSION_PORT = 5432;

/** The documented host shape; the index differs per project (aws-0, aws-1, ...). */
export const poolerHost = (region: string, index = 0): string => `aws-${index}-${region}.pooler.supabase.com`;

export type PoolerConfigRow = { database_type: string; db_host: string; db_user: string; pool_mode?: string };

/** The primary entry of GET /v1/projects/{ref}/config/database/pooler, or the documented fallback. */
export function poolerHostFromConfig(rows: PoolerConfigRow[] | null | undefined, region: string): string {
  const primary = rows?.find((r) => r.database_type === "PRIMARY" && r.db_host);
  return primary?.db_host ?? poolerHost(region);
}

export type PoolerTarget = { host: string; ref: string; password?: string; port?: number; database?: string };

/**
 * postgresql://postgres.<ref>[:password]@host:5432/postgres?sslmode=require
 * The password is percent encoded when given. scripts/db-copy.mjs leaves it out
 * and hands it to the child process as PGPASSWORD instead, so it never appears
 * on a command line or in a process list.
 */
export function poolerUrl({ host, ref, password, port = SESSION_PORT, database = "postgres" }: PoolerTarget): string {
  const auth = password === undefined ? `postgres.${ref}` : `postgres.${ref}:${encodeURIComponent(password)}`;
  return `postgresql://${auth}@${host}:${port}/${database}?sslmode=require`;
}
