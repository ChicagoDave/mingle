/**
 * Shipped project templates — the bundle files under `templates/`
 * (P-5; ADR-0024 Decision 1: a template is a bundle file in the
 * repository, offered on New Project).
 *
 * Purpose: lists and loads `<templates dir>/*.json` — `TEMPLATES_DIR`
 * when set, else `templates/` under the working directory (the image
 * copies the directory to `/app/templates`). A file that does not
 * parse as a bundle is skipped from the listing rather than failing
 * the page; the suite validates every shipped file (rule 13a for the
 * data files). Legacy `ConfigurableTemplate.templates` with its
 * `TEMPLATE_ORDER`: the shipped order is fixed here, unknown files
 * follow alphabetically.
 *
 * Public interface: `listTemplates`, `loadTemplate`, `templatesDir`,
 * `TemplateSummary`.
 *
 * Owner context: infrastructure (filesystem) for Import/Export.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseBundle, type ProjectBundle } from "~/domain/import-export/bundle.server";

/** What the New Project page shows for a template. */
export interface TemplateSummary {
  /** The file's basename without `.json` — the value the form posts. */
  identifier: string;
  name: string;
  description: string | null;
}

/** Legacy TEMPLATE_ORDER, by file identifier; the rest sort by name. */
const TEMPLATE_ORDER = ["scrum", "agile", "kanban"];

/** The directory the templates are read from. */
export function templatesDir(): string {
  return process.env.TEMPLATES_DIR || join(process.cwd(), "templates");
}

function templateFiles(): string[] {
  const dir = templatesDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort((a, b) => {
      const ia = TEMPLATE_ORDER.indexOf(basename(a, ".json"));
      const ib = TEMPLATE_ORDER.indexOf(basename(b, ".json"));
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      return a.localeCompare(b);
    });
}

/**
 * Loads one shipped template by identifier.
 *
 * @returns the parsed bundle, or null when no such file exists or it does not parse
 */
export function loadTemplate(identifier: string): ProjectBundle | null {
  if (!/^[a-z0-9_-]+$/i.test(identifier)) return null;
  const file = join(templatesDir(), `${identifier}.json`);
  if (!existsSync(file)) return null;
  const parsed = parseBundle(readFileSync(file, "utf8"));
  return parsed.ok ? parsed.value : null;
}

/** The shipped templates, in display order. */
export function listTemplates(): TemplateSummary[] {
  return templateFiles().flatMap((file) => {
    const identifier = basename(file, ".json");
    const bundle = loadTemplate(identifier);
    return bundle ? [{ identifier, name: bundle.source.name, description: bundle.source.description }] : [];
  });
}
