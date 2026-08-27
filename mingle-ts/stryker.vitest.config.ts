/**
 * Vitest configuration used only by Stryker mutation runs.
 *
 * Purpose: the mutation harness must run exactly the suites that can
 * pass unattended. It extends the normal test config and drops
 * `test/healthz.real.test.ts`, whose precondition is a live compose
 * stack on port 3000 (rule 13a real-path test) — under Stryker every
 * mutant would inherit that failure and be reported as "killed" by an
 * environment error rather than by an assertion.
 *
 * The base import is deliberately extensionless: `tsc` rejects a `.ts`
 * import specifier unless `allowImportingTsExtensions` is on, and Vite
 * only warns about it under its future native config loader. Type
 * correctness wins; the warning is cosmetic.
 *
 * Public interface: the default export consumed by Stryker's
 * vitest-runner via `vitest.configFile` in `stryker.config.json`.
 * Owner context: infrastructure (test tooling).
 */
import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "./vitest.config";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      exclude: ["**/node_modules/**", "**/dist/**", "test/healthz.real.test.ts"],
    },
  }),
);
