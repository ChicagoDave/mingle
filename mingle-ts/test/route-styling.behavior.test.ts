/**
 * Form-page parity guard (P-17, Phase 2).
 *
 * Purpose: fails the suite if any page route module under app/routes/
 * renders a page without styling — the state every one of the thirteen
 * routes P-17 names was in before Phase 2. A page route is a `.tsx`
 * module with a default (component) export; the `.ts` resource routes
 * (JSON, feeds, downloads, webhooks) have nothing to style and are not
 * in scope. "Styled" means the module imports a stylesheet under
 * app/styles/ or carries at least one `className` attribute — the two
 * ways every harvested page in this port declares its legacy look.
 *
 * Owner context: Frontend UI verification.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const routesDir = join(import.meta.dirname, "..", "app", "routes");

describe("every page route carries its legacy styling", () => {
  const pageModules = readdirSync(routesDir)
    .filter((file) => file.endsWith(".tsx"))
    .map((file) => ({ file, source: readFileSync(join(routesDir, file), "utf8") }))
    .filter(({ source }) => /export default function/.test(source));

  it("finds the page route modules", () => {
    expect(pageModules.length).toBeGreaterThan(30);
  });

  it("finds no page route rendering without a stylesheet import or class attribute", () => {
    const unstyled = pageModules
      .filter(({ source }) => !/from "\.\.\/styles\/[\w-]+\.css"|import "\.\.\/styles\/[\w-]+\.css"|className=/.test(source))
      .map(({ file }) => file);
    expect(unstyled).toEqual([]);
  });

  it("keeps the thirteen P-17 routes on the harvested form primitives", () => {
    const p17 = [
      "login.tsx",
      "register.tsx",
      "projects.tsx",
      "projects.new.tsx",
      "projects.settings.tsx",
      "projects.team.tsx",
      "projects.groups.tsx",
      "projects.transitions.tsx",
      "projects.integrations.tsx",
      "projects.cards.new.tsx",
      "profile.tsx",
      "admin.authentication.tsx",
    ];
    const missing = p17.filter((file) => {
      const source = readFileSync(join(routesDir, file), "utf8");
      const harvested = /from "~\/components\/forms"|import "\.\.\/styles\/[\w-]+\.css"/.test(source);
      return !harvested || /fontFamily: "sans-serif"/.test(source);
    });
    expect(missing).toEqual([]);
  });
});
