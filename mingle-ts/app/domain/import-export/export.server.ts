/**
 * Import/Export — project export (Phase 28; legacy
 * ProjectTemplateExporter).
 *
 * Purpose: renders a project's configuration as a `ProjectBundle` —
 * card types, properties, trees, aggregates, transitions and
 * variables, every cross-reference resolved to a name — and, only when
 * asked (`includeContent`, ADR-0024 Decision 3), its content: card
 * defaults, team favorites with tabs and WIP limits, cards with their
 * settable values, and pages. Identity never travels: a user default
 * other than `(current user)`, a card's user values, and WIP limits on
 * user lanes are dropped. A read with an authorization gate, not a
 * command: it changes nothing and emits no event (legacy raised an
 * export-progress request; here the document is built synchronously).
 *
 * Public interface: `exportProject`.
 *
 * Owner context: Import/Export (depends inward on Card Management,
 * Card Trees and Projects for their tables and read models).
 */
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { cardDefaults } from "~/db/schema/card-defaults";
import { cards, cardTypes } from "~/db/schema/cards";
import { favorites } from "~/db/schema/favorites";
import { pages } from "~/db/schema/pages";
import { projects, projectVariables } from "~/db/schema/projects";
import { cardPropertyValues, enumerationValues, propertyDefinitions, type PropertyDefinitionRow } from "~/db/schema/properties";
import { favoriteViewParams, wipLimitsOf } from "~/domain/cards/favorites.server";
import { treeCardTypes, treeConfigurations } from "~/db/schema/trees";
import { loadTransitions } from "~/domain/cards/transitions.server";
import { type CommandResult, reject } from "~/domain/command.server";
import { authorizeProjectAction, PrivilegeLevel } from "~/domain/identity/authorization.server";
import {
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
  type BundleAggregate,
  type BundleCard,
  type BundleCardDefaults,
  type BundleFavorite,
  type BundlePage,
  type BundlePrerequisite,
  type BundleProperty,
  type BundlePropertyKind,
  type BundleTree,
  type ProjectBundle,
} from "~/domain/import-export/bundle.server";
import {
  CURRENT_USER_MARKER,
  type AGGREGATE_TYPES,
  type CardViewStyle,
  type ProjectVariableDataType,
  type TransitionActionInputMode,
} from "~/shared/wire-types";

export interface ExportProjectInput {
  projectId: number;
  actorUserId: number;
  /** Injectable clock for the `exportedAt` stamp. */
  now?: Date;
  /** Also emit card defaults, favorites, cards and pages (default false — configuration only). */
  includeContent?: boolean;
}

/** Property kinds whose card values travel: directly settable and identity-free. */
const PORTABLE_VALUE_KINDS: ReadonlySet<string> = new Set(["text", "number", "date", "enumerated"]);

/** The content sections of a project (ADR-0024 Decision 3 — only on request). */
function contentSections(
  db: BetterSQLite3Database,
  projectId: number,
  typeName: Map<number, string>,
  definitions: PropertyDefinitionRow[],
): Pick<ProjectBundle, "cardDefaults" | "favorites" | "cards" | "pages"> {
  const definitionById = new Map(definitions.map((d) => [d.id, d]));
  const definitionByName = new Map(definitions.map((d) => [d.name.toLowerCase(), d]));

  const defaultsByType = new Map<number, Record<string, string>>();
  for (const row of db.select().from(cardDefaults).where(eq(cardDefaults.projectId, projectId)).orderBy(asc(cardDefaults.id)).all()) {
    const definition = definitionById.get(row.propertyDefinitionId);
    if (!definition) continue;
    if (definition.kind === "user" && row.value !== CURRENT_USER_MARKER) continue;
    const values = defaultsByType.get(row.cardTypeId) ?? {};
    values[definition.name] = row.value;
    defaultsByType.set(row.cardTypeId, values);
  }
  const bundledDefaults: BundleCardDefaults[] = [...typeName.entries()]
    .filter(([id]) => defaultsByType.has(id))
    .map(([id, name]) => ({ cardType: name, values: defaultsByType.get(id)! }));

  const bundledFavorites: BundleFavorite[] = db
    .select()
    .from(favorites)
    .where(and(eq(favorites.projectId, projectId), isNull(favorites.userId), eq(favorites.kind, "card_view")))
    .orderBy(asc(favorites.name))
    .all()
    .map((row) => {
      const params = favoriteViewParams(row);
      const laneKind = definitionByName.get(params.groupBy.toLowerCase())?.kind;
      const favorite: BundleFavorite = {
        name: row.name,
        style: params.style as CardViewStyle,
        filters: params.filters,
        columns: params.columns,
        groupBy: params.groupBy,
        tabView: row.tabView,
        wipLimits: laneKind === "user" ? {} : wipLimitsOf(row),
      };
      if (params.mql) favorite.mql = params.mql;
      return favorite;
    });

  const cardRows = db.select().from(cards).where(eq(cards.projectId, projectId)).orderBy(asc(cards.number)).all();
  const valueRows = cardRows.length
    ? db.select().from(cardPropertyValues).where(inArray(cardPropertyValues.cardId, cardRows.map((c) => c.id))).orderBy(asc(cardPropertyValues.id)).all()
    : [];
  const bundledCards: BundleCard[] = cardRows.map((card) => {
    const values: Record<string, string> = {};
    for (const value of valueRows.filter((v) => v.cardId === card.id)) {
      const definition = definitionById.get(value.propertyDefinitionId);
      if (definition && PORTABLE_VALUE_KINDS.has(definition.kind)) values[definition.name] = value.value;
    }
    const bundled: BundleCard = { name: card.name, cardType: typeName.get(card.cardTypeId) ?? "", number: card.number, values };
    if (card.description !== null) bundled.description = card.description;
    return bundled;
  });

  const bundledPages: BundlePage[] = db
    .select({ name: pages.name, content: pages.content })
    .from(pages)
    .where(eq(pages.projectId, projectId))
    .orderBy(asc(pages.name))
    .all();

  return { cardDefaults: bundledDefaults, favorites: bundledFavorites, cards: bundledCards, pages: bundledPages };
}

/** Variable data types whose values name an installation-local row and so do not travel. */
const NON_PORTABLE_VARIABLE_TYPES: ReadonlySet<string> = new Set(["UserType", "CardType"]);

/**
 * Builds the project's bundle.
 *
 * @returns the bundle, or a rejection when the project is unknown or
 *   the actor is below project administrator
 */
export function exportProject(db: BetterSQLite3Database, input: ExportProjectInput): CommandResult<ProjectBundle> {
  const project = db.select().from(projects).where(eq(projects.id, input.projectId)).get();
  if (!project) return reject("project", "does not exist");
  const denied = authorizeProjectAction(db, input.actorUserId, project.id, PrivilegeLevel.PROJECT_ADMIN);
  if (denied) return denied;

  const types = db
    .select({ id: cardTypes.id, name: cardTypes.name })
    .from(cardTypes)
    .where(eq(cardTypes.projectId, project.id))
    .orderBy(asc(cardTypes.position))
    .all();
  const typeName = new Map(types.map((t) => [t.id, t.name]));

  const definitions = db
    .select()
    .from(propertyDefinitions)
    .where(eq(propertyDefinitions.projectId, project.id))
    .orderBy(asc(propertyDefinitions.position))
    .all();
  const definitionName = new Map(definitions.map((d) => [d.id, d.name]));
  const definitionIds = definitions.map((d) => d.id);
  const values = definitionIds.length
    ? db
        .select()
        .from(enumerationValues)
        .where(inArray(enumerationValues.propertyDefinitionId, definitionIds))
        .orderBy(asc(enumerationValues.position))
        .all()
    : [];

  const properties: BundleProperty[] = definitions
    .filter((d) => d.kind !== "tree_relationship" && d.kind !== "aggregate")
    .map((d) => {
      const property: BundleProperty = { name: d.name, kind: d.kind as BundlePropertyKind, transitionOnly: d.transitionOnly };
      if (d.kind === "enumerated")
        property.values = values.filter((v) => v.propertyDefinitionId === d.id).map((v) => v.value);
      if (d.kind === "formula") {
        property.formula = d.formula ?? "";
        property.nullIsZero = d.nullIsZero;
      }
      return property;
    });

  const treeRows = db
    .select()
    .from(treeConfigurations)
    .where(eq(treeConfigurations.projectId, project.id))
    .orderBy(asc(treeConfigurations.name))
    .all();
  const treeName = new Map(treeRows.map((t) => [t.id, t.name]));
  const levels = treeRows.length
    ? db
        .select()
        .from(treeCardTypes)
        .where(inArray(treeCardTypes.treeConfigurationId, treeRows.map((t) => t.id)))
        .orderBy(asc(treeCardTypes.position))
        .all()
    : [];
  const trees: BundleTree[] = treeRows.map((tree) => ({
    name: tree.name,
    description: tree.description,
    levels: levels
      .filter((l) => l.treeConfigurationId === tree.id)
      .map((l) => {
        const relationship = definitions.find(
          (d) => d.kind === "tree_relationship" && d.treeConfigurationId === tree.id && d.validCardTypeId === l.cardTypeId,
        );
        return relationship ? { cardType: typeName.get(l.cardTypeId)!, relationshipName: relationship.name } : { cardType: typeName.get(l.cardTypeId)! };
      }),
  }));

  const aggregates: BundleAggregate[] = definitions
    .filter((d) => d.kind === "aggregate")
    .map((d) => {
      const aggregate: BundleAggregate = {
        name: d.name,
        tree: treeName.get(d.treeConfigurationId!)!,
        holderCardType: typeName.get(d.aggregateCardTypeId!)!,
        aggregateType: d.aggregateType as (typeof AGGREGATE_TYPES)[number],
      };
      if (d.aggregateTargetId !== null) aggregate.targetProperty = definitionName.get(d.aggregateTargetId)!;
      if (d.aggregateScopeCardTypeId !== null) aggregate.scopeCardType = typeName.get(d.aggregateScopeCardTypeId)!;
      if (d.aggregateCondition) aggregate.condition = d.aggregateCondition;
      return aggregate;
    });

  const transitions = loadTransitions(db, project.id).map(({ transition, prerequisites, actions }) => {
    const bundled: ProjectBundle["transitions"][number] = {
      name: transition.name,
      prerequisites: prerequisites.flatMap((p): BundlePrerequisite[] => {
        if (p.kind === "has_specific_value")
          return [{ kind: "has_specific_value", property: definitionName.get(p.propertyDefinitionId!)!, value: p.value }];
        if (p.kind === "has_set_value") return [{ kind: "has_set_value", property: definitionName.get(p.propertyDefinitionId!)! }];
        return []; // is_user / in_group: identity does not travel
      }),
      actions: actions.map((a) => ({
        property: definitionName.get(a.propertyDefinitionId)!,
        inputMode: a.inputMode as TransitionActionInputMode,
        value: a.value,
      })),
    };
    if (transition.cardTypeId !== null) bundled.cardType = typeName.get(transition.cardTypeId)!;
    return bundled;
  });

  const variables = db
    .select({ name: projectVariables.name, dataType: projectVariables.dataType, value: projectVariables.value })
    .from(projectVariables)
    .where(eq(projectVariables.projectId, project.id))
    .orderBy(asc(projectVariables.name))
    .all()
    .map((v) => ({
      name: v.name,
      dataType: v.dataType as ProjectVariableDataType,
      value: NON_PORTABLE_VARIABLE_TYPES.has(v.dataType) ? null : v.value,
    }));

  return {
    ok: true,
    value: {
      format: BUNDLE_FORMAT,
      version: BUNDLE_VERSION,
      exportedAt: (input.now ?? new Date()).toISOString(),
      source: { name: project.name, identifier: project.identifier, description: project.description },
      cardTypes: types.map((t) => t.name),
      properties,
      trees,
      aggregates,
      transitions,
      variables,
      ...(input.includeContent
        ? contentSections(db, project.id, typeName, definitions)
        : { cardDefaults: [], favorites: [], cards: [], pages: [] }),
    },
  };
}
