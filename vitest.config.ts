import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * Three projects, because they need three different worlds:
 *
 *   unit         pure logic (money, errors, config parsing) — no DOM, no database
 *   ui           React primitives — jsdom
 *   integration  real PostgreSQL, real migrations, one throwaway database per test
 *
 * `npm test` runs all three. `npm run test:integration` runs only the slow one.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    projects: [
      {
        plugins: [tsconfigPaths()],
        test: {
          name: "unit",
          globals: true,
          environment: "node",
          include: ["src/**/*.test.ts", "tests/unit/**/*.test.ts"],
        },
      },
      {
        plugins: [tsconfigPaths(), react()],
        test: {
          name: "ui",
          globals: true,
          environment: "jsdom",
          include: ["src/**/*.test.tsx", "tests/ui/**/*.test.tsx"],
          setupFiles: ["./tests/setup/dom.ts"],
        },
      },
      {
        plugins: [tsconfigPaths()],
        test: {
          name: "integration",
          globals: true,
          environment: "node",
          include: ["tests/integration/**/*.test.ts"],
          globalSetup: ["./tests/harness/global-setup.ts"],
          // Cloning a template database costs a few hundred milliseconds, and
          // some suites deliberately provoke lock waits.
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
