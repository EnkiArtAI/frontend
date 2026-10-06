import { defineConfig } from 'vitest/config';

export default defineConfig({
  // This is a pure Node API backend — no CSS ever ships from here. `test.css:
  // false` alone doesn't stop it: Vite resolves the PostCSS config at the
  // server/root level regardless, via postcss-load-config's own directory
  // walk, which climbs past backend/ into the parent frontend/ project and
  // fails loading its postcss.config.mjs (needs @tailwindcss/postcss, not
  // installed here on purpose — this is an isolated backend/node_modules).
  // An inline, empty postcss config short-circuits that filesystem search.
  css: { postcss: { plugins: [] } },
  test: {
    css: false,
    environment: 'node',
    globals: true,
    setupFiles: ['./__tests__/setup.ts'],
    include: ['**/__tests__/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    coverage: {
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', '__tests__/setup.ts', 'scripts/'],
      thresholds: {
        global: {
          branches: 70,
          functions: 80,
          lines: 80,
          statements: 80
        }
      }
    }
  },
  resolve: {
    // '@/...' inside backend/ files (encryption.ts, the image adapters) means
    // the root frontend project's alias, not a backend-local one — that's how
    // the real Next.js app resolves them (root tsconfig.json maps '@/lib/*' to
    // './lib/*' and includes backend/**/*). Pointing '@' at backend/ itself,
    // as this used to do, left '@/lib/crypto' etc. unresolvable — latent until
    // a test imports one of those files without mocking it.
    alias: {
      '@': new URL('../', import.meta.url).pathname
    }
  }
});
