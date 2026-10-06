import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored design snapshot: never imported, never typechecked (it is not in
    // tsconfig include). Linting it only adds noise the gate would have to
    // baseline away.
    ".design/**",
  ]),
  {
    files: ["lib/payments/escrow/generated/instructions/*.ts"],
    rules: {
      // Codama's discriminator-only instructions have no payload fields.
      // Keep those three generated input types intact; lint all other types.
      "@typescript-eslint/no-empty-object-type": ["error", {
        allowWithName: "^(Pause|Reclaim|RevokeOperator)InstructionDataInput$",
      }],
    },
  },
  // CDP hooks only work inside CDPHooksProvider, which mounts lazily and only
  // for signed-in users. Called anywhere else they throw at runtime and take
  // the whole page down (this cost us the editor once). TypeScript cannot catch
  // it — the hook's signature is identical whether or not a provider exists —
  // so the boundary is enforced here. Everything outside the provider tree goes
  // through lib/cdp-bridge.
  {
    files: ["**/*.{ts,tsx}"],
    ignores: ["providers/CdpProvider.tsx", "components/CdpWalletBridge.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@coinbase/cdp-hooks",
              message:
                "CDP hooks throw outside CdpProvider. Use lib/cdp-bridge instead (useCdpAddress / requestCdpSign / requestCdpKeyExport).",
            },
          ],
          // `paths` matches the bare specifier only, so
          // "@coinbase/cdp-hooks/dist/index.js" walked straight past the ban.
          patterns: [
            {
              group: ["@coinbase/cdp-hooks/*"],
              message:
                "Same ban as the bare import — a subpath is not a loophole. Use lib/cdp-bridge.",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
