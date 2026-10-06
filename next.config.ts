import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.resolve(__dirname),

  // A trial run (e.g. Turbopack on a second port) can point its build dir
  // elsewhere so it never collides with the live dev server's .next.
  distDir: process.env.NEXT_DIST_DIR || ".next",

  // ── Turbopack (Next 16's default bundler; much faster dev compiles) ──
  // Mirrors the webpack fallbacks below: node-only/optional modules resolve
  // to an empty stub in browser bundles. `npm run dev:webpack` keeps the old
  // webpack path as a fallback.
  turbopack: {
    resolveAlias: {
      "@stripe/crypto": { browser: "./lib/empty-module.ts" },
      "@farcaster/mini-app-solana": { browser: "./lib/empty-module.ts" },
      "pino-pretty": { browser: "./lib/empty-module.ts" },
      lokijs: { browser: "./lib/empty-module.ts" },
      encoding: { browser: "./lib/empty-module.ts" },
    },
  },


  // Webpack configuration
  webpack: (config, { isServer }) => {
    // Fix for Thirdweb ESM modules
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
        // Optional Privy features we don't use (Stripe fiat-crypto onramp,
        // Farcaster mini-app) — stub them so their absence isn't a warning.
        "@stripe/crypto": false,
        "@farcaster/mini-app-solana": false,
      };
    }

    // Documented fix for web3 SDKs (Privy/thirdweb): "Module not found: Can't
    // resolve 'encoding'/'pino-pretty'/'lokijs'".
    config.externals.push("pino-pretty", "lokijs", "encoding");
    
    // Handle ESM modules from Thirdweb - allow fullySpecified: false
    config.module = {
      ...config.module,
      rules: [
        ...(config.module?.rules || []),
        {
          test: /node_modules\/thirdweb\/.*\.m?js$/,
          resolve: {
            fullySpecified: false,
          },
        },
      ],
    };
    
    return config;
  },
  
  // Exclude test scripts and other non-production files from TypeScript checking
  typescript: {
    ignoreBuildErrors: false,
  },
  
  // Note: serverExternalPackages removed for thirdweb - it must be bundled
  // so it shares the same React instance as Next.js during SSR
};

export default nextConfig;
