/**
 * API reference drift guard (P-4, Phase 6).
 *
 * Purpose: docs/api-v1.md documents every `/api/v1` route in a table
 * whose first column is the path exactly as app/routes.ts declares it
 * and whose second column lists its methods. This suite fails when the
 * two disagree in either direction — a route added to routes.ts
 * without a row, a row whose path no longer exists, or a documented
 * method the module cannot serve (GET needs an exported `loader`; any
 * other method needs an exported `action` whose source names the
 * method). It reads source files, not the running app, so it runs in
 * the plain behavioral suite.
 *
 * Owner context: Public API verification.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const routesSource = readFileSync(join(root, "app", "routes.ts"), "utf8");
const docSource = readFileSync(join(root, "docs", "api-v1.md"), "utf8");

/** Every `route("api/v1/...", "routes/<module>")` in app/routes.ts, path → module file. */
function declaredApiRoutes(): Map<string, string> {
  const declared = new Map<string, string>();
  const pattern = /route\(\s*"(api\/v1\/[^"]+)",\s*"(routes\/[^"]+)"/g;
  for (const match of routesSource.matchAll(pattern)) declared.set(`/${match[1]}`, match[2]);
  return declared;
}

/** Every row of the doc's route table, path → methods. */
function documentedApiRoutes(): Map<string, string[]> {
  const documented = new Map<string, string[]>();
  const row = /^\| `(\/api\/v1\/[^`]+)` \| ([A-Z, ]+) \|/gm;
  for (const match of docSource.matchAll(row)) {
    documented.set(match[1], match[2].split(",").map((method) => method.trim()));
  }
  return documented;
}

describe("docs/api-v1.md matches app/routes.ts", () => {
  const declared = declaredApiRoutes();
  const documented = documentedApiRoutes();

  it("documents every declared /api/v1 route and no other", () => {
    expect([...documented.keys()].sort()).toEqual([...declared.keys()].sort());
    expect(declared.size).toBeGreaterThan(10);
  });

  it("documents only methods each route module can serve", () => {
    const problems: string[] = [];
    for (const [path, methods] of documented) {
      const moduleFile = declared.get(path);
      if (!moduleFile) continue; // reported by the previous test
      const source = readFileSync(join(root, "app", moduleFile), "utf8");
      const hasLoader = /export async function loader/.test(source);
      const hasAction = /export async function action/.test(source);
      for (const method of methods) {
        if (method === "GET") {
          if (!hasLoader) problems.push(`${path}: GET documented but no loader`);
        } else if (!hasAction || !source.includes(`"${method}"`)) {
          problems.push(`${path}: ${method} documented but the module does not handle it`);
        }
      }
      if (hasAction) {
        for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
          if (source.includes(`"${method}"`) && !methods.includes(method))
            problems.push(`${path}: module handles ${method} but the doc does not list it`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
