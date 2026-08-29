/**
 * Import/Export — project import (Phase 28; legacy ProjectImporter for
 * templates).
 *
 * Purpose: reconstructs a project from a `ProjectBundle` by running the
 * same commands an administrator would run by hand, in dependency
 * order — CreateProject, DefineCardType, DefinePropertyDefinition
 * (plain kinds, then formulas, whose inputs must already exist),
 * DefineTree, DefineAggregateProperty, DefineTransition,
 * DefineProjectVariable — then the version-2 content sections
 * (ADR-0024 Decision 6): SaveFavorite / MakeFavoriteTab /
 * SetLaneWipLimit, ImportCards (the seed cards as a pre-built table,
 * so they take the CSV path's versions), SetCardDefaults, and
 * CreatePage last, after every configuration section, with
 * `{{template:today±N}}` tokens expanded to dates first (Decision 5)
 * — on one transaction, so a bundle that fails
 * any rule leaves nothing behind and the errors name the offending
 * entry. No business logic is duplicated here: every invariant the
 * commands enforce holds for imported configuration exactly as for
 * hand-entered configuration. `(current user)` resolves to the actor,
 * who joins the new project's team when a seed card or default names
 * them (legacy ProjectCreator `add_member(User.current)`), since a
 * user value must name a member.
 *
 * Commands → events:
 *   ImportProject → ProjectImported (after the events of every command it ran)
 *
 * Public interface: `importProject`.
 *
 * Owner context: Import/Export.
 */
import { and, eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { cardTypes } from "~/db/schema/cards";
import { propertyDefinitions } from "~/db/schema/properties";
import { defineCardType } from "~/domain/cards/commands.server";
import { isCurrentUserMarker, setCardDefaults } from "~/domain/cards/card-defaults.server";
import { makeFavoriteTab, saveFavorite, setLaneWipLimit } from "~/domain/cards/favorites.server";
import { importCards } from "~/domain/import-export/card-import.server";
import { createPage } from "~/domain/pages/commands.server";
import { addTeamMember } from "~/domain/identity/membership.server";
import { teamMemberships } from "~/db/schema/membership";
import { defineAggregateProperty, definePropertyDefinition } from "~/domain/cards/properties.server";
import { defineTransition, type TransitionPrerequisiteInput } from "~/domain/cards/transitions.server";
import type { CommandResult } from "~/domain/command.server";
import { emitEvent } from "~/domain/events.server";
import { expandTemplateTokens, type ProjectBundle } from "~/domain/import-export/bundle.server";
import { createProject, defineProjectVariable } from "~/domain/projects/commands.server";
import { defineTree } from "~/domain/trees/commands.server";
import type { FieldErrors } from "~/shared/wire-types";

export interface ImportProjectInput {
  bundle: ProjectBundle;
  /** Overrides the bundle's source name; blank means keep it. */
  name?: string | null;
  /** Overrides the bundle's source identifier; blank means keep it. */
  identifier?: string | null;
  actorUserId: number;
  /** The instantiation date the page tokens resolve against; defaults to now. */
  now?: Date;
}

/** What an import created. */
export interface ImportOutcome {
  projectId: number;
  identifier: string;
  counts: {
    cardTypes: number;
    properties: number;
    trees: number;
    aggregates: number;
    transitions: number;
    variables: number;
    favorites: number;
    cards: number;
    cardDefaults: number;
    pages: number;
  };
}

/** Carries a command's rejection out of the transaction so it rolls back. */
class ImportRejected extends Error {
  constructor(readonly errors: FieldErrors) {
    super("import rejected");
  }
}

/** Unwraps a command result, prefixing its field errors with the bundle path on rejection. */
function must<T>(result: CommandResult<T>, path: string): T {
  if (result.ok) return result.value;
  const errors: FieldErrors = {};
  for (const [field, messages] of Object.entries(result.errors)) errors[`${path}.${field}`] = messages;
  throw new ImportRejected(errors);
}

/** Resolves a bundle name against what has been created so far, or rejects naming the path. */
function resolve(map: Map<string, number>, name: string, path: string, what: string): number {
  const id = map.get(name.toLowerCase());
  if (id === undefined) throw new ImportRejected({ [path]: [`refers to an unknown ${what} "${name}"`] });
  return id;
}

/**
 * ImportProject — creates a project from a bundle.
 *
 * DOES: creates the project (name/identifier from the bundle unless
 * overridden), then defines every card type not already present (the
 * default "Card" type comes with the project), every plain property
 * in order, every formula, every tree, every aggregate, every
 * transition and every variable through their commands — each
 * appending its own event and rows — then the content sections in
 * order: favorites (saved, promoted to tabs, WIP limits set), seed
 * cards through ImportCards (a create version plus a values version
 * each, as a CSV row gets), card defaults, and pages with their
 * template tokens expanded against `now` — and finally appends a
 * ProjectImported event with the counts; all on one transaction.
 * WHEN: the actor may create projects (site administrator) and every
 * entry satisfies the rules of the command that creates it, with every
 * cross-reference naming something the bundle defined earlier.
 * BECAUSE: an import is an administrator entering configuration
 * quickly, not a back door around the configuration rules.
 * REJECTS WHEN: any command rejects or a reference is unresolved —
 * errors keyed by the bundle path (e.g. `transitions[1].actions[0]`),
 * and the transaction rolls back so no project exists.
 */
export function importProject(db: BetterSQLite3Database, input: ImportProjectInput): CommandResult<ImportOutcome> {
  const { bundle, actorUserId } = input;
  const name = input.name?.trim() || bundle.source.name;
  const identifier = input.identifier?.trim() || bundle.source.identifier;

  try {
    return db.transaction((tx) => {
      const project = must(
        createProject(tx, { name, identifier, description: bundle.source.description, actorUserId }),
        "project",
      );
      const projectId = project.id;
      const scoped = { projectId, actorUserId };

      const typeIds = new Map<string, number>();
      // CreateProject seeds the default card type; a bundle that lists it reuses it.
      const seeded = defaultCardTypes(tx, projectId);
      for (const [typeName, id] of seeded) typeIds.set(typeName.toLowerCase(), id);
      let cardTypeCount = 0;
      bundle.cardTypes.forEach((typeName, index) => {
        if (typeIds.has(typeName.toLowerCase())) return;
        const row = must(defineCardType(tx, { ...scoped, name: typeName }), `cardTypes[${index}]`);
        typeIds.set(typeName.toLowerCase(), row.id);
        cardTypeCount += 1;
      });

      const propertyIds = new Map<string, number>();
      const defineProperty = (property: ProjectBundle["properties"][number], index: number) => {
        const row = must(
          definePropertyDefinition(tx, {
            ...scoped,
            name: property.name,
            kind: property.kind,
            values: property.kind === "enumerated" ? property.values ?? [] : undefined,
            formula: property.kind === "formula" ? property.formula ?? null : undefined,
            nullIsZero: property.kind === "formula" ? property.nullIsZero ?? false : undefined,
            transitionOnly: property.transitionOnly,
          }),
          `properties[${index}]`,
        );
        propertyIds.set(property.name.toLowerCase(), row.id);
      };
      bundle.properties.forEach((property, index) => {
        if (property.kind !== "formula") defineProperty(property, index);
      });
      bundle.properties.forEach((property, index) => {
        if (property.kind === "formula") defineProperty(property, index);
      });

      const treeIds = new Map<string, number>();
      bundle.trees.forEach((tree, index) => {
        const path = `trees[${index}]`;
        const row = must(
          defineTree(tx, {
            ...scoped,
            name: tree.name,
            description: tree.description,
            levels: tree.levels.map((level, levelIndex) => ({
              cardTypeId: resolve(typeIds, level.cardType, `${path}.levels[${levelIndex}].cardType`, "card type"),
              relationshipName: level.relationshipName ?? null,
            })),
          }),
          path,
        );
        treeIds.set(tree.name.toLowerCase(), row.id);
        for (const level of tree.levels)
          if (level.relationshipName) propertyIds.set(level.relationshipName.toLowerCase(), relationshipId(tx, row.id, level.relationshipName));
      });

      bundle.aggregates.forEach((aggregate, index) => {
        const path = `aggregates[${index}]`;
        const row = must(
          defineAggregateProperty(tx, {
            ...scoped,
            name: aggregate.name,
            treeId: resolve(treeIds, aggregate.tree, `${path}.tree`, "tree"),
            aggregateCardTypeId: resolve(typeIds, aggregate.holderCardType, `${path}.holderCardType`, "card type"),
            aggregateType: aggregate.aggregateType,
            targetPropertyDefinitionId:
              aggregate.targetProperty === undefined
                ? null
                : resolve(propertyIds, aggregate.targetProperty, `${path}.targetProperty`, "property"),
            scopeCardTypeId:
              aggregate.scopeCardType === undefined
                ? null
                : resolve(typeIds, aggregate.scopeCardType, `${path}.scopeCardType`, "card type"),
            condition: aggregate.condition ?? null,
          }),
          path,
        );
        propertyIds.set(aggregate.name.toLowerCase(), row.id);
      });

      bundle.transitions.forEach((transition, index) => {
        const path = `transitions[${index}]`;
        must(
          defineTransition(tx, {
            ...scoped,
            name: transition.name,
            cardTypeId:
              transition.cardType === undefined ? null : resolve(typeIds, transition.cardType, `${path}.cardType`, "card type"),
            prerequisites: transition.prerequisites.map((p, pIndex): TransitionPrerequisiteInput => {
              const propertyDefinitionId = resolve(propertyIds, p.property, `${path}.prerequisites[${pIndex}].property`, "property");
              return p.kind === "has_specific_value"
                ? { kind: "has_specific_value", propertyDefinitionId, value: p.value }
                : { kind: "has_set_value", propertyDefinitionId };
            }),
            actions: transition.actions.map((a, aIndex) => ({
              propertyDefinitionId: resolve(propertyIds, a.property, `${path}.actions[${aIndex}].property`, "property"),
              inputMode: a.inputMode,
              value: a.value ?? null,
            })),
          }),
          path,
        );
      });

      bundle.variables.forEach((variable, index) => {
        must(
          defineProjectVariable(tx, { ...scoped, name: variable.name, dataType: variable.dataType, value: variable.value }),
          `variables[${index}]`,
        );
      });

      // ── Content (version 2) ──
      const namesCurrentUser = [...bundle.cards, ...bundle.cardDefaults].some((entry) => Object.values(entry.values).some(isCurrentUserMarker));
      const alreadyMember = tx
        .select({ id: teamMemberships.id })
        .from(teamMemberships)
        .where(and(eq(teamMemberships.projectId, projectId), eq(teamMemberships.userId, actorUserId)))
        .get();
      if (namesCurrentUser && !alreadyMember) must(addTeamMember(tx, { ...scoped, userId: actorUserId }), "project");

      bundle.favorites.forEach((favorite, index) => {
        const path = `favorites[${index}]`;
        const row = must(
          saveFavorite(tx, {
            ...scoped,
            name: favorite.name,
            style: favorite.style,
            filters: favorite.filters,
            columns: favorite.columns,
            groupBy: favorite.groupBy,
            mql: favorite.mql ?? "",
            personal: false,
          }),
          path,
        );
        if (favorite.tabView) must(makeFavoriteTab(tx, { ...scoped, favoriteId: row.id }), path);
        for (const [lane, limit] of Object.entries(favorite.wipLimits))
          must(setLaneWipLimit(tx, { ...scoped, favoriteId: row.id, laneValue: lane, limit }), `${path}.wipLimits.${lane}`);
      });

      if (bundle.cards.length > 0) {
        // Seed cards become one table for ImportCards: one column per
        // property any card names, resolved before the import so an
        // unknown name is an error rather than an ignored column.
        const kinds = new Map(
          tx.select({ name: propertyDefinitions.name, kind: propertyDefinitions.kind }).from(propertyDefinitions).where(eq(propertyDefinitions.projectId, projectId)).all()
            .map((row) => [row.name.toLowerCase(), row.kind]),
        );
        const columns = new Map<string, string>();
        bundle.cards.forEach((card, index) => {
          for (const property of Object.keys(card.values)) {
            resolve(propertyIds, property, `cards[${index}].values.${property}`, "property");
            if (!columns.has(property.toLowerCase())) columns.set(property.toLowerCase(), property);
          }
          resolve(typeIds, card.cardType, `cards[${index}].cardType`, "card type");
        });
        const propertyColumns = [...columns.entries()];
        const header = ["Number", "Name", "Description", "Type", ...propertyColumns.map(([, name]) => name)];
        const rows = bundle.cards.map((card) => [
          card.number === undefined ? "" : String(card.number),
          card.name,
          card.description ?? "",
          card.cardType,
          ...propertyColumns.map(([key]) => {
            const entry = Object.entries(card.values).find(([name]) => name.toLowerCase() === key);
            if (!entry) return "";
            return kinds.get(key) === "user" && isCurrentUserMarker(entry[1]) ? String(actorUserId) : entry[1];
          }),
        ]);
        must(importCards(tx, { ...scoped, table: { delimiter: ",", header, rows } }), "cards");
      }

      bundle.cardDefaults.forEach((entry, index) => {
        const path = `cardDefaults[${index}]`;
        must(
          setCardDefaults(tx, { ...scoped, cardTypeId: resolve(typeIds, entry.cardType, `${path}.cardType`, "card type"), defaults: entry.values }),
          path,
        );
      });

      const now = input.now ?? new Date();
      bundle.pages.forEach((page, index) => {
        must(
          createPage(tx, { ...scoped, name: page.name, content: page.content === null ? null : expandTemplateTokens(page.content, now) }),
          `pages[${index}]`,
        );
      });

      const counts = {
        cardTypes: cardTypeCount,
        properties: bundle.properties.length,
        trees: bundle.trees.length,
        aggregates: bundle.aggregates.length,
        transitions: bundle.transitions.length,
        variables: bundle.variables.length,
        favorites: bundle.favorites.length,
        cards: bundle.cards.length,
        cardDefaults: bundle.cardDefaults.length,
        pages: bundle.pages.length,
      };
      emitEvent(tx, {
        type: "ProjectImported",
        aggregateType: "Project",
        aggregateId: projectId,
        payload: { identifier: project.identifier, source: bundle.source.identifier, exportedAt: bundle.exportedAt, counts },
        actorUserId,
      });
      return { ok: true, value: { projectId, identifier: project.identifier, counts } };
    });
  } catch (error) {
    if (error instanceof ImportRejected) return { ok: false, errors: error.errors };
    throw error;
  }
}

/** The card types a freshly created project already has, by name. */
function defaultCardTypes(tx: BetterSQLite3Database, projectId: number): [string, number][] {
  return tx
    .select({ id: cardTypes.id, name: cardTypes.name })
    .from(cardTypes)
    .where(eq(cardTypes.projectId, projectId))
    .all()
    .map((row) => [row.name, row.id]);
}

/** The id of the relationship property DefineTree created for a level. */
function relationshipId(tx: BetterSQLite3Database, treeId: number, relationshipName: string): number {
  return tx
    .select({ id: propertyDefinitions.id })
    .from(propertyDefinitions)
    .where(and(eq(propertyDefinitions.treeConfigurationId, treeId), sql`lower(${propertyDefinitions.name}) = ${relationshipName.toLowerCase()}`))
    .get()!.id;
}
