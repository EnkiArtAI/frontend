import { describe, it, expect } from "vitest";
import { generateDbPassword, missingInputs, parseEnv, projectRef, upsertEnv } from "@/lib/dev/env";
import { poolerHost, poolerHostFromConfig, poolerUrl } from "@/lib/dev/pooler";
import { cacheBinDir, majorVersion, planPgTools, PG_ZIP_MEMBERS } from "@/lib/dev/pg-tools";

describe("env files", () => {
  it("parses KEY=value, strips quotes and trailing comments, ignores comments and blanks", () => {
    const env = parseEnv(`# comment\nA=1\nB="two words"\nC='x=y'\n\nD=raw # trailing\nexport E=5\nnot a line\nF=\n`);
    expect(env).toEqual({ A: "1", B: "two words", C: "x=y", D: "raw", E: "5", F: "" });
  });

  it("replaces the marker line in place and appends what was not there", () => {
    const text = "# head\n# hint\nSUPABASE_URL=PASTE_FROM_DASHBOARD\nAUTH_PEPPER=keep\n";
    const out = upsertEnv(text, { SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "anon" });
    expect(out).toBe("# head\n# hint\nSUPABASE_URL=https://x.supabase.co\nAUTH_PEPPER=keep\nSUPABASE_ANON_KEY=anon\n");
    expect(parseEnv(upsertEnv(out, { SUPABASE_URL: "https://y.supabase.co" })).SUPABASE_URL).toBe("https://y.supabase.co");
    expect(upsertEnv("", { A: "1" })).toBe("A=1\n");
  });

  it("derives the 20 letter project ref from the URL and rejects anything else", () => {
    expect(projectRef("https://abcdefghijklmnopqrst.supabase.co")).toBe("abcdefghijklmnopqrst");
    expect(projectRef("https://abcdefghijklmnopqrst.supabase.co/rest/v1")).toBe("abcdefghijklmnopqrst");
    for (const bad of [undefined, "", "not a url", "https://short.supabase.co", "https://abcdefghijklmnopqrst.example.com", "https://abcdefghijklmnopqrst.supabase.co.evil.example"]) {
      expect(() => projectRef(bad)).toThrow(/SUPABASE_URL must look like/);
    }
  });

  it("names every missing input in one sentence with where to get it", () => {
    const out = missingInputs({ SUPABASE_URL: "x", SUPABASE_DB_PASSWORD: "  " }, ["SUPABASE_URL", "SUPABASE_ACCESS_TOKEN", "SUPABASE_DB_PASSWORD"], ".env.local");
    expect(out).toEqual([
      "SUPABASE_ACCESS_TOKEN is missing from .env.local: a personal access token from https://supabase.com/dashboard/account/tokens.",
      "SUPABASE_DB_PASSWORD is missing from .env.local: the live database password, Settings > Database.",
    ]);
    expect(missingInputs({ A: "1" }, ["A"], "f")).toEqual([]);
  });

  it("generates a 32 character password from an unambiguous alphabet, unbiased and URL safe", () => {
    let seed = 0;
    const bytes = (n: number) => Uint8Array.from({ length: n }, () => (seed++ * 37 + 11) % 256);
    const pw = generateDbPassword(bytes);
    expect(pw).toMatch(/^[A-HJ-NP-Za-km-z2-9]{32}$/);
    expect(encodeURIComponent(pw)).toBe(pw);
    let calls = 0;
    const rejectedFirst = (n: number) => { const first = calls++ === 0; return Uint8Array.from({ length: n }, (_, i) => (first ? 255 : (i * 7) % 200)); };
    expect(generateDbPassword(rejectedFirst)).toHaveLength(32);
    expect(calls).toBe(2);
  });
});

describe("session pooler", () => {
  it("builds the documented host and a URL with the password percent encoded or left out for PGPASSWORD", () => {
    expect(poolerHost("eu-central-1")).toBe("aws-0-eu-central-1.pooler.supabase.com");
    expect(poolerHost("eu-central-1", 1)).toBe("aws-1-eu-central-1.pooler.supabase.com");
    const ref = "abcdefghijklmnopqrst";
    expect(poolerUrl({ host: poolerHost("eu-central-1"), ref, password: "p@ss:w/rd#1 x" })).toBe(
      "postgresql://postgres.abcdefghijklmnopqrst:p%40ss%3Aw%2Frd%231%20x@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require",
    );
    expect(poolerUrl({ host: "h", ref })).toBe("postgresql://postgres.abcdefghijklmnopqrst@h:5432/postgres?sslmode=require");
    expect(poolerUrl({ host: "h", ref, port: 6543, database: "other" })).toBe("postgresql://postgres.abcdefghijklmnopqrst@h:6543/other?sslmode=require");
  });

  it("prefers the primary host from the pooler config and falls back to the documented shape", () => {
    const rows = [
      { database_type: "READ_REPLICA", db_host: "aws-9-eu-central-1.pooler.supabase.com", db_user: "postgres.x" },
      { database_type: "PRIMARY", db_host: "aws-1-eu-central-1.pooler.supabase.com", db_user: "postgres.x", pool_mode: "transaction" },
    ];
    expect(poolerHostFromConfig(rows, "eu-central-1")).toBe("aws-1-eu-central-1.pooler.supabase.com");
    expect(poolerHostFromConfig(null, "eu-central-1")).toBe("aws-0-eu-central-1.pooler.supabase.com");
    expect(poolerHostFromConfig([{ database_type: "PRIMARY", db_host: "", db_user: "" }], "us-east-1")).toBe("aws-0-us-east-1.pooler.supabase.com");
  });
});

describe("pg tools", () => {
  const base = { platform: "win32", tmpdir: "C:/Temp", which: () => null as string | null, exists: () => false };

  it("PG_BIN wins and must hold both binaries", () => {
    const has = new Set(["C:/pg/bin/pg_dump.exe", "C:/pg/bin/psql.exe"]);
    expect(planPgTools({ ...base, env: { PG_BIN: "C:/pg/bin" }, exists: (p) => has.has(p) })).toEqual({ pgDump: "C:/pg/bin/pg_dump.exe", psql: "C:/pg/bin/psql.exe", source: "PG_BIN" });
    expect(() => planPgTools({ ...base, env: { PG_BIN: "C:/pg/bin" }, exists: (p) => p.endsWith("psql.exe") })).toThrow(/PG_BIN is set but/);
  });

  it("then the PATH, then the cache, then a download on Windows and a clear refusal elsewhere", () => {
    const onPath = (c: string) => (c === "pg_dump" ? "C:/PostgreSQL/bin/pg_dump.exe" : "C:/PostgreSQL/bin/psql.exe");
    expect(planPgTools({ ...base, env: {}, which: onPath })).toMatchObject({ source: "PATH", pgDump: "C:/PostgreSQL/bin/pg_dump.exe" });
    expect(planPgTools({ ...base, env: {}, which: (c) => (c === "pg_dump" ? "x" : null) })).toMatchObject({ source: "download" });
    const cached = { pgDump: `${cacheBinDir("C:/Temp")}/pg_dump.exe`, psql: `${cacheBinDir("C:/Temp")}/psql.exe` };
    expect(planPgTools({ ...base, env: {}, exists: (p) => p === cached.pgDump || p === cached.psql })).toEqual({ ...cached, source: "cache" });
    expect(planPgTools({ ...base, env: {} })).toEqual({ ...cached, source: "download" });
    expect(() => planPgTools({ ...base, env: {}, platform: "linux" })).toThrow(/install the PostgreSQL client tools/);
    expect(PG_ZIP_MEMBERS).toContain("pgsql/bin/pg_dump.exe");
  });

  it("reads the major version out of pg_dump and Supabase version strings", () => {
    expect(majorVersion("pg_dump (PostgreSQL) 18.6")).toBe(18);
    expect(majorVersion("17.4.1.074")).toBe(17);
    expect(majorVersion("")).toBeNull();
  });
});
