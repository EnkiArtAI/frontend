/**
 * Supabase Management API (https://api.supabase.com, bearer personal access
 * token, 120 requests a minute). Fetch based, no dependency, every failure is
 * one sentence. Endpoints used, per the published OpenAPI document at
 * https://api.supabase.com/api/v1-json:
 *   GET  /v1/organizations
 *   GET  /v1/projects, GET /v1/projects/{ref}, POST /v1/projects
 *   GET  /v1/projects/{ref}/health?services=db,rest,pooler
 *   GET  /v1/projects/{ref}/api-keys?reveal=true
 *   GET  /v1/projects/{ref}/config/database/pooler
 *   POST /v1/projects/{ref}/database/query   { query, read_only }
 */

export type Organization = { id: string; slug: string; name: string };
export type Project = {
  id: string;
  ref: string;
  organization_id: string;
  organization_slug: string;
  name: string;
  region: string;
  status: string;
  database?: { host: string; version: string };
};
export type ApiKey = { name: string; api_key?: string; type?: "legacy" | "publishable" | "secret" | null };
export type Health = { name: string; healthy: boolean; status: string };

export const MANAGEMENT_API = "https://api.supabase.com";

export function createManagementClient(token: string, fetchImpl: typeof fetch = fetch, base = MANAGEMENT_API) {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text.slice(0, 300);
      try { message = String((JSON.parse(text) as { message?: string }).message ?? message); } catch { /* plain text */ }
      throw new Error(`Supabase Management API ${method} ${path} answered ${res.status}: ${message}`);
    }
    return (text ? JSON.parse(text) : null) as T;
  }
  return {
    organizations: () => call<Organization[]>("GET", "/v1/organizations"),
    projects: () => call<Project[]>("GET", "/v1/projects"),
    project: (ref: string) => call<Project>("GET", `/v1/projects/${ref}`),
    createProject: (body: { name: string; organization_slug: string; db_pass: string; region: string }) =>
      call<Project>("POST", "/v1/projects", {
        name: body.name,
        organization_slug: body.organization_slug,
        db_pass: body.db_pass,
        region_selection: { type: "specific", code: body.region },
      }),
    health: (ref: string) => call<Health[]>("GET", `/v1/projects/${ref}/health?services=db,rest,pooler`),
    apiKeys: (ref: string) => call<ApiKey[]>("GET", `/v1/projects/${ref}/api-keys?reveal=true`),
    poolerConfig: (ref: string) => call<{ database_type: string; db_host: string; db_user: string; pool_mode?: string }[]>("GET", `/v1/projects/${ref}/config/database/pooler`),
    /** Rows of a SELECT, or an empty array for a statement. `readOnly` runs as supabase_read_only_user. */
    query: <T = Record<string, unknown>>(ref: string, sql: string, readOnly = false) =>
      call<T[] | null>("POST", `/v1/projects/${ref}/database/query`, { query: sql, read_only: readOnly }).then((r) => r ?? []),
  };
}

export type ManagementClient = ReturnType<typeof createManagementClient>;

/** Reuse the project with that name in the organization, or create it in the given region. */
export async function findOrCreateProject(
  client: ManagementClient,
  opts: { name: string; organizationSlug: string; region: string; dbPass: () => string },
): Promise<{ project: Project; created: boolean }> {
  const orgs = await client.organizations();
  if (!orgs.some((o) => o.slug === opts.organizationSlug)) {
    throw new Error(`The access token cannot see organization ${opts.organizationSlug}, which owns the live project.`);
  }
  const existing = (await client.projects()).filter((p) => p.organization_slug === opts.organizationSlug && p.name === opts.name && p.status !== "REMOVED");
  if (existing.length > 1) throw new Error(`Organization ${opts.organizationSlug} has ${existing.length} projects named ${opts.name}; rename or delete until one is left.`);
  if (existing.length === 1) return { project: existing[0], created: false };
  try {
    const project = await client.createProject({ name: opts.name, organization_slug: opts.organizationSlug, db_pass: opts.dbPass(), region: opts.region });
    return { project, created: true };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(`${reason} The free plan allows two active projects per organization; pause or delete one at https://supabase.com/dashboard/projects and run again.`);
  }
}

const FINAL_FAILURES = new Set(["INIT_FAILED", "REMOVED", "RESTORE_FAILED", "PAUSE_FAILED"]);

/** Poll until the project reports ACTIVE_HEALTHY and db, rest and pooler are healthy. */
export async function waitUntilHealthy(
  client: ManagementClient,
  ref: string,
  opts: { sleep: (ms: number) => Promise<void>; intervalMs?: number; attempts?: number; onPoll?: (status: string) => void },
): Promise<Project> {
  const { sleep, intervalMs = 10_000, attempts = 90 } = opts;
  let project: Project | null = null;
  for (let i = 0; i < attempts; i++) {
    project = await client.project(ref);
    opts.onPoll?.(project.status);
    if (project.status === "INACTIVE") throw new Error(`Project ${ref} is paused; restore it at https://supabase.com/dashboard/project/${ref} and run again.`);
    if (FINAL_FAILURES.has(project.status)) throw new Error(`Project ${ref} is in state ${project.status} and will not become healthy.`);
    if (project.status === "ACTIVE_HEALTHY") {
      const health = await client.health(ref);
      if (health.every((h) => h.healthy)) return project;
      opts.onPoll?.(`services: ${health.map((h) => `${h.name}=${h.status}`).join(" ")}`);
    }
    await sleep(intervalMs);
  }
  throw new Error(`Project ${ref} did not become healthy within ${Math.round((attempts * intervalMs) / 60_000)} minutes (last status ${project?.status ?? "unknown"}).`);
}

/** anon and service_role (legacy JWT keys), or the publishable and secret keys of a project without legacy keys. */
export function pickApiKeys(keys: ApiKey[]): { anon: string; serviceRole: string } {
  const revealed = keys.filter((k) => typeof k.api_key === "string" && k.api_key);
  const byName = (name: string) => revealed.find((k) => k.name === name)?.api_key;
  const byType = (type: string) => revealed.find((k) => k.type === type)?.api_key;
  const anon = byName("anon") ?? byType("publishable");
  const serviceRole = byName("service_role") ?? byType("secret");
  if (!anon || !serviceRole) throw new Error("The project's API keys were not revealed; the access token needs the secrets:read scope.");
  return { anon, serviceRole };
}
