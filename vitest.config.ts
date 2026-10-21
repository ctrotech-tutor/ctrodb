import { readFileSync } from "node:fs"
import { defineConfig } from "vitest/config"

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string
}

/**
 * Two test environments, deliberately:
 *
 * - `unit`     — browser-like. `tests/setup.ts` installs `fake-indexeddb`, so
 *                both adapters are exercised.
 * - `node-pure` — no IndexedDB globals at all. This is what catches accidental
 *                dependencies on browser APIs in the core (e.g. `IDBKeyRange`),
 *                which used to make indexed queries and the sync engine fail
 *                on Node while the main suite stayed green.
 */
export default defineConfig({
  define: { __CTRODB_VERSION__: JSON.stringify(pkg.version) },
  test: {
    // Measured at 90.4 / 82.4 / 90.1 / 92.8 when the thresholds were added;
    // they sit just below that so ordinary refactors do not fail CI, while a
    // real coverage regression does.
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/react.ts", "src/types.ts"],
      thresholds: {
        statements: 89,
        branches: 81,
        functions: 89,
        lines: 91,
      },
    },
    projects: [
      {
        test: {
          name: "unit",
          globals: true,
          environment: "node",
          setupFiles: ["./tests/setup.ts"],
          include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
          exclude: ["tests/node/**", "tests/benchmarks/**"],
          benchmark: { include: ["tests/benchmarks/**/*.bench.ts"] },
        },
      },
      {
        test: {
          name: "node-pure",
          globals: true,
          environment: "node",
          setupFiles: [],
          include: ["tests/node/**/*.test.ts"],
          benchmark: { include: [] },
        },
      },
    ],
  },
})
