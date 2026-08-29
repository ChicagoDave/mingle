/**
 * Vitest configuration — the test-time Vite config.
 *
 * Purpose: tests must not load the React Router dev plugin. That plugin
 * injects a dev-server preamble into every module it transforms, which
 * has no counterpart under Vitest and fails any test that imports a
 * component ("can't detect preamble"). This config keeps the two things
 * tests DO need from the app config — tsconfig path aliases so `~/`
 * resolves — and leaves the router plugin out.
 *
 * Public interface: the default export consumed by the vitest CLI.
 * Owner context: infrastructure (test tooling).
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    // Node is right for the domain suites; the component suites opt
    // into jsdom per file with a `@vitest-environment jsdom` docblock.
    environment: "node",
  },
});
