/**
 * Macro registry wiring — registers the built-in macros and builds the
 * expander `renderPageContent` takes (Phase 17).
 *
 * Purpose: the single import that turns macro support on. Importing
 * this module registers every built-in macro and, through
 * macros-charts, the SVG elements charts are permitted to emit. Routes
 * import `pageMacroExpansion` and nothing else from the macro layer,
 * so no route ever touches the registry directly.
 *
 * Registration happens once per process, at import, and is idempotent:
 * `registerMacro` replaces by name, so a re-import cannot double a
 * macro or leave two versions racing.
 *
 * Public interface: `pageMacroExpansion`, `installBuiltInMacros`.
 *
 * Owner context: Wiki & Content.
 */
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type {
  ContentNode,
  MacroExpansion,
} from "~/domain/pages/content.server";
import { expandMacros, registerMacro } from "~/domain/pages/macros.server";
import { tableMacro, valueMacro } from "~/domain/pages/macros-cards.server";
import { pieChartMacro } from "~/domain/pages/macros-charts.server";
import { dailyHistoryChartMacro } from "~/domain/pages/macros-history.server";
import {
  dataSeriesChartMacro,
  stackedBarChartMacro,
} from "~/domain/pages/macros-series-charts.server";

let installed = false;

/**
 * Registers the built-in macros, once per process.
 *
 * @returns nothing; safe to call repeatedly
 */
export function installBuiltInMacros(): void {
  if (installed) return;
  registerMacro(tableMacro);
  registerMacro(valueMacro);
  registerMacro(pieChartMacro);
  registerMacro(dailyHistoryChartMacro);
  registerMacro(stackedBarChartMacro);
  registerMacro(dataSeriesChartMacro);
  installed = true;
}

/** What the expander needs to run a page's macros. */
export interface PageMacroContext {
  projectIdentifier: string;
  projectId: number;
  db: BetterSQLite3Database;
  currentUserId: number | null;
}

/**
 * Builds the macro expander for one page render.
 *
 * @param context - the project being rendered and who is viewing
 * @returns an expander to pass as `renderPageContent`'s third argument
 */
export function pageMacroExpansion(context: PageMacroContext): MacroExpansion {
  installBuiltInMacros();
  return (nodes: ContentNode[], produced: WeakSet<ContentNode>) =>
    expandMacros(nodes, context, produced);
}
