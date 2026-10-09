import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * CDP-1: the deprecated direct-export path (useExportSolanaAccount /
 * exportSolanaAccount) must be gone from the whole app, not just from
 * CdpWalletBridge.tsx — a stray import elsewhere would silently reopen the
 * raw-private-key-into-app-JS path this migration closes. __tests__
 * directories are excluded from the repo-wide scan: test files legitimately
 * name the banned symbol in mocks while describing the ban, which isn't the
 * thing being guarded against. Code is read with readSource (comments
 * stripped) so an explanatory comment naming the old hook — like the one at
 * the top of KeyExport.tsx — doesn't trip this, only a real import/call would.
 */

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(p, "utf8").split("\r\n").join("\n");

function walk(dir: string, match: (f: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === "__tests__") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p, match));
    else if (match(entry)) out.push(p);
  }
  return out;
}

const SOURCE_DIRS = ["app", "components", "lib", "hooks", "providers"];
const isCodeFile = (f: string) => /\.(ts|tsx)$/.test(f);

describe("CDP-1: exportSolanaAccount / useExportSolanaAccount are gone, repo-wide", () => {
  const files = SOURCE_DIRS.flatMap((d) => walk(join(ROOT, d), isCodeFile));

  it("finds source files at all — a silent zero here would prove nothing", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("proves the detector works on code that really does name it (pre-fix sanity)", () => {
    // If exportSolanaAccount stops matching this literal, case-insensitively,
    // the test below becomes vacuous.
    expect(/exportSolanaAccount/i.test("const { exportSolanaAccount } = useExportSolanaAccount();")).toBe(true);
  });

  it("no app file imports or calls exportSolanaAccount or useExportSolanaAccount", () => {
    const offenders = files.filter((f) => /exportSolanaAccount/i.test(readSource(f)));
    expect(offenders.map((f) => f.slice(ROOT.length + 1).split("\\").join("/"))).toEqual([]);
  });
});

describe("CDP-1: export goes through CDP's secure iframe, wired inside the provider", () => {
  const bridge = readSource(join(ROOT, "components", "CdpWalletBridge.tsx"));
  const keyExport = readSource(join(ROOT, "components", "settings", "KeyExport.tsx"));
  const cdpBridgeLib = readSource(join(ROOT, "lib", "cdp-bridge.ts"));

  it("CdpWalletBridge imports useSolanaKeyExportIframe from @coinbase/cdp-hooks", () => {
    expect(bridge).toContain("useSolanaKeyExportIframe");
    expect(bridge).toMatch(/from\s+"@coinbase\/cdp-hooks"/);
  });

  it("CdpWalletBridge no longer imports exportSolanaAccount from @coinbase/cdp-core", () => {
    expect(bridge).not.toContain("exportSolanaAccount");
  });

  it("portals the export host only once a container is registered AND this mount signed in", () => {
    expect(bridge).toContain("exportContainer && mine");
    expect(bridge).toContain("createPortal(<ExportIframeHost address={mine} />, exportContainer)");
  });

  it("the export host calls the iframe hook with this mount's own address, never a stale one", () => {
    expect(bridge).toMatch(/useSolanaKeyExportIframe\(\{\s*address,/);
  });

  it("lib/cdp-bridge.ts no longer exposes the raw-key request/response pair", () => {
    expect(cdpBridgeLib).not.toContain("requestCdpKeyExport");
    expect(cdpBridgeLib).not.toContain("CDP_EXPORT_REQUEST");
    expect(cdpBridgeLib).not.toContain("CDP_EXPORT_RESULT");
  });

  it("KeyExport no longer imports the removed requestCdpKeyExport", () => {
    expect(keyExport).not.toContain("requestCdpKeyExport");
  });

  it("KeyExport registers its dialog container with the bridge instead of reading a key", () => {
    expect(keyExport).toContain("setExportIframeContainer(containerRef.current)");
  });

  it("KeyExport still gates export behind a second-factor confirm before anything opens", () => {
    expect(keyExport).toMatch(/confirm\("export"\)/);
  });
});

describe("CDP-1: the EVM address is read-only informational UI", () => {
  const billingPanel = readSource(join(ROOT, "components", "settings", "BillingPanel.tsx"));

  it("shows the EVM address without any deposit/QR action against it", () => {
    expect(billingPanel).toContain("cdpEvmAddress");
    expect(billingPanel).toContain("Informational");
  });
});

describe("CDP-1: the eslint import ban on @coinbase/cdp-hooks is unchanged", () => {
  const eslintConfig = read(join(ROOT, "eslint.config.mjs"));

  it("still bans the bare import outside the provider tree", () => {
    expect(eslintConfig).toContain('name: "@coinbase/cdp-hooks"');
    expect(eslintConfig).toContain('ignores: ["providers/CdpProvider.tsx", "components/CdpWalletBridge.tsx"]');
  });
});

describe("CDP-1: dependency upgrade", () => {
  const pkg = JSON.parse(read(join(ROOT, "package.json"))) as {
    dependencies: Record<string, string>;
  };

  it("cdp-core and cdp-hooks are off the old ^0.0.113 pin", () => {
    expect(pkg.dependencies["@coinbase/cdp-core"]).not.toBe("^0.0.113");
    expect(pkg.dependencies["@coinbase/cdp-hooks"]).not.toBe("^0.0.113");
  });

  it("@coinbase/cdp-sdk is now a direct dependency, not transitive-only", () => {
    expect(pkg.dependencies["@coinbase/cdp-sdk"]).toBeDefined();
  });
});
