import { describe, it, expect } from "vitest";
import { createManagementClient, findOrCreateProject, pickApiKeys, waitUntilHealthy, type Project } from "@/lib/dev/supabase-management";

type Call = { method: string; path: string; body: unknown };

/** A fetch that answers from a route table and records every call; unknown routes answer 404. */
function fakeFetch(routes: Record<string, (call: Call) => { status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = { method: init?.method ?? "GET", path: url.pathname + url.search, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const route = routes[`${call.method} ${call.path}`];
    const res = route ? route(call) : { status: 404, body: { message: `no route for ${call.method} ${call.path}` } };
    return new Response(JSON.stringify(res.body), { status: res.status ?? 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const project = (over: Partial<Project>): Project => ({
  id: "1", ref: "abcdefghijklmnopqrst", organization_id: "org-1", organization_slug: "enki", name: "enki-dev", region: "eu-central-1", status: "ACTIVE_HEALTHY", ...over,
});

describe("management client", () => {
  it("sends the bearer token and turns a failure into one sentence with the server's message", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (_: string | URL | Request, init?: RequestInit) => {
      seen.push(String((init?.headers as Record<string, string>).Authorization));
      return new Response(JSON.stringify({ message: "Rate limit exceeded" }), { status: 429 });
    }) as typeof fetch;
    const client = createManagementClient("tok", fetchImpl);
    await expect(client.organizations()).rejects.toThrow("Supabase Management API GET /v1/organizations answered 429: Rate limit exceeded");
    expect(seen).toEqual(["Bearer tok"]);
  });

  it("creates a project with organization_slug and a specific region_selection, and treats a null query result as no rows", async () => {
    const { fetchImpl, calls } = fakeFetch({
      "POST /v1/projects": (c) => ({ status: 201, body: project({ ref: "newnewnewnewnewnewne", status: "COMING_UP", name: (c.body as { name: string }).name }) }),
      "POST /v1/projects/abcdefghijklmnopqrst/database/query": () => ({ status: 201, body: null }),
    });
    const client = createManagementClient("tok", fetchImpl);
    await client.createProject({ name: "enki-dev", organization_slug: "enki", db_pass: "pw", region: "eu-central-1" });
    expect(calls[0].body).toEqual({ name: "enki-dev", organization_slug: "enki", db_pass: "pw", region_selection: { type: "specific", code: "eu-central-1" } });
    expect(await client.query("abcdefghijklmnopqrst", "notify pgrst, 'reload schema'")).toEqual([]);
    expect(calls[1].body).toEqual({ query: "notify pgrst, 'reload schema'", read_only: false });
  });
});

describe("find or create", () => {
  const orgs = () => ({ body: [{ id: "org-1", slug: "enki", name: "Enki" }] });

  it("reuses the project with that name in the organization and never calls create", async () => {
    const { fetchImpl, calls } = fakeFetch({
      "GET /v1/organizations": orgs,
      "GET /v1/projects": () => ({ body: [project({ name: "live", ref: "liveliveliveliveliv1" }), project({ name: "enki-dev", status: "INACTIVE" }), project({ name: "enki-dev", status: "REMOVED", ref: "gonegonegonegonegone" })] }),
    });
    const out = await findOrCreateProject(createManagementClient("t", fetchImpl), { name: "enki-dev", organizationSlug: "enki", region: "eu-central-1", dbPass: () => { throw new Error("must not generate a password when reusing"); } });
    expect(out).toMatchObject({ created: false, project: { ref: "abcdefghijklmnopqrst", status: "INACTIVE" } });
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET"]);
  });

  it("creates it in the source region when absent, and explains the free plan limit when creation is refused", async () => {
    let pass = "";
    const { fetchImpl, calls } = fakeFetch({
      "GET /v1/organizations": orgs,
      "GET /v1/projects": () => ({ body: [project({ name: "live" })] }),
      "POST /v1/projects": (c) => ({ status: 201, body: project({ ref: "newnewnewnewnewnewne", status: "COMING_UP", name: (c.body as { name: string }).name }) }),
    });
    const out = await findOrCreateProject(createManagementClient("t", fetchImpl), { name: "enki-dev", organizationSlug: "enki", region: "us-west-1", dbPass: () => (pass = "generated-pw") });
    expect(out).toMatchObject({ created: true, project: { ref: "newnewnewnewnewnewne" } });
    expect(calls[2].body).toMatchObject({ db_pass: pass, region_selection: { type: "specific", code: "us-west-1" } });

    const refused = fakeFetch({
      "GET /v1/organizations": orgs,
      "GET /v1/projects": () => ({ body: [] }),
      "POST /v1/projects": () => ({ status: 402, body: { message: "Your organization has reached its project limit" } }),
    });
    await expect(findOrCreateProject(createManagementClient("t", refused.fetchImpl), { name: "enki-dev", organizationSlug: "enki", region: "us-west-1", dbPass: () => "x" }))
      .rejects.toThrow(/answered 402: Your organization has reached its project limit The free plan allows two active projects per organization; pause or delete one/);
  });

  it("refuses an organization the token cannot see and an ambiguous name", async () => {
    const invisible = fakeFetch({ "GET /v1/organizations": () => ({ body: [{ id: "o", slug: "other", name: "Other" }] }) });
    await expect(findOrCreateProject(createManagementClient("t", invisible.fetchImpl), { name: "enki-dev", organizationSlug: "enki", region: "r", dbPass: () => "x" }))
      .rejects.toThrow("The access token cannot see organization enki, which owns the live project.");
    const twice = fakeFetch({ "GET /v1/organizations": orgs, "GET /v1/projects": () => ({ body: [project({}), project({ ref: "secondsecondsecondse" })] }) });
    await expect(findOrCreateProject(createManagementClient("t", twice.fetchImpl), { name: "enki-dev", organizationSlug: "enki", region: "r", dbPass: () => "x" }))
      .rejects.toThrow("Organization enki has 2 projects named enki-dev; rename or delete until one is left.");
  });
});

describe("wait until healthy", () => {
  const ref = "abcdefghijklmnopqrst";
  const noSleep = { sleep: async () => {}, intervalMs: 10_000 };

  it("polls the status, then the services, and returns when db, rest and pooler are healthy", async () => {
    const statuses = ["COMING_UP", "COMING_UP", "ACTIVE_HEALTHY", "ACTIVE_HEALTHY"];
    const healths = [
      [{ name: "db", healthy: true, status: "ACTIVE_HEALTHY" }, { name: "rest", healthy: false, status: "COMING_UP" }, { name: "pooler", healthy: true, status: "ACTIVE_HEALTHY" }],
      [{ name: "db", healthy: true, status: "ACTIVE_HEALTHY" }, { name: "rest", healthy: true, status: "ACTIVE_HEALTHY" }, { name: "pooler", healthy: true, status: "ACTIVE_HEALTHY" }],
    ];
    const { fetchImpl, calls } = fakeFetch({
      [`GET /v1/projects/${ref}`]: () => ({ body: project({ status: statuses.shift() ?? "ACTIVE_HEALTHY" }) }),
      [`GET /v1/projects/${ref}/health?services=db,rest,pooler`]: () => ({ body: healths.shift() }),
    });
    const polled: string[] = [];
    const slept: number[] = [];
    const out = await waitUntilHealthy(createManagementClient("t", fetchImpl), ref, { ...noSleep, sleep: async (ms) => { slept.push(ms); }, onPoll: (s) => polled.push(s) });
    expect(out.status).toBe("ACTIVE_HEALTHY");
    expect(polled).toEqual(["COMING_UP", "COMING_UP", "ACTIVE_HEALTHY", "services: db=ACTIVE_HEALTHY rest=COMING_UP pooler=ACTIVE_HEALTHY", "ACTIVE_HEALTHY"]);
    expect(slept).toEqual([10_000, 10_000, 10_000]);
    expect(calls.filter((c) => c.path.includes("/health")).length).toBe(2);
  });

  it("stops with one sentence on a paused project, a final failure, or a timeout", async () => {
    const paused = fakeFetch({ [`GET /v1/projects/${ref}`]: () => ({ body: project({ status: "INACTIVE" }) }) });
    await expect(waitUntilHealthy(createManagementClient("t", paused.fetchImpl), ref, noSleep)).rejects.toThrow(`Project ${ref} is paused; restore it at https://supabase.com/dashboard/project/${ref} and run again.`);
    const failed = fakeFetch({ [`GET /v1/projects/${ref}`]: () => ({ body: project({ status: "INIT_FAILED" }) }) });
    await expect(waitUntilHealthy(createManagementClient("t", failed.fetchImpl), ref, noSleep)).rejects.toThrow(`Project ${ref} is in state INIT_FAILED and will not become healthy.`);
    const stuck = fakeFetch({ [`GET /v1/projects/${ref}`]: () => ({ body: project({ status: "COMING_UP" }) }) });
    await expect(waitUntilHealthy(createManagementClient("t", stuck.fetchImpl), ref, { ...noSleep, attempts: 3, intervalMs: 60_000 })).rejects.toThrow(`Project ${ref} did not become healthy within 3 minutes (last status COMING_UP).`);
    expect(stuck.calls.length).toBe(3);
  });
});

describe("api keys", () => {
  it("takes the legacy anon and service_role keys, else the publishable and secret keys, else refuses", () => {
    expect(pickApiKeys([
      { name: "anon", api_key: "eyJ-anon", type: "legacy" },
      { name: "service_role", api_key: "eyJ-service", type: "legacy" },
      { name: "default", api_key: "sb_publishable_x", type: "publishable" },
    ])).toEqual({ anon: "eyJ-anon", serviceRole: "eyJ-service" });
    expect(pickApiKeys([
      { name: "default", api_key: "sb_publishable_x", type: "publishable" },
      { name: "server", api_key: "sb_secret_y", type: "secret" },
    ])).toEqual({ anon: "sb_publishable_x", serviceRole: "sb_secret_y" });
    expect(() => pickApiKeys([{ name: "anon", type: "legacy" }, { name: "service_role", type: "legacy" }])).toThrow("The project's API keys were not revealed; the access token needs the secrets:read scope.");
    expect(() => pickApiKeys([{ name: "anon", api_key: "a", type: "legacy" }])).toThrow(/not revealed/);
  });
});
