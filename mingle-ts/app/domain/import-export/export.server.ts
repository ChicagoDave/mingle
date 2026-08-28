/**
 * Import/Export — project export (Phase 28; legacy
 * ProjectTemplateExporter).
 *
 * Purpose: renders a project's configuration as a `ProjectBundle` —
 * card types, properties, trees, aggregates, transitions and
 * variables, every cross-reference resolved to a name. A read with an
 * authorization gate, not a command: it changes nothing and emits no
 * event (legacy raised an export-progress request; here the document
 * is built synchronously).
 *
 * Public interface: `exportProject`.
 *
 * Owner context: Import/Export (depends inward on Card Management,
 * Card Trees and Projects for their tables and read models).
 */
import { asc, eq, inArray } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { cardTypes } from "~/db/schema/cards";
import { projects, projectVariables } from "~/db/schema/projects";
import { enumerationValues, propertyDefinitions } from "~/db/schema/properties";
import { treeCardTypes, treeConfigurations } from "~/db/schema/trees";
import { loadTransitions } from "~/domain/cards/transitions.server";
import { type CommandResult, reject } from "~/domain/command.server";
import { authorizeProjectAction, PrivilegeLevel } from "~/domain/identity/authorization.server";
import {
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
  type BundleAggregate,
  type BundlePrerequisite,
  type BundleProperty,
  type BundlePropertyKind,
  type BundleTree,
  type ProjectBundle,
} from "~/domain/import-export/bundle.server";
import type { AGGREGATE_TYPES, ProjectVariableDataType, TransitionActionInputMode } from "~/shared/wire-types";

export interface ExportProjectInput {
  projectId: number;
  actorUserId: number;
  /** Injectable clock for the `exportedAt` stamp. */
  now?: Date;
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
    },
  };
}
