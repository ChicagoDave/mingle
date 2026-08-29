/**
 * LDAP group sync — the directory's groups as the authority for mapped
 * Mingle groups (P-6).
 *
 * Purpose: a site admin maps LDAP group DNs to Mingle project groups
 * beside the LDAP settings (`<group DN> => <project>/<group name>`, one
 * per line). On every LDAP sign-in the strategy asks the directory
 * which mapped groups hold the user and this module reconciles:
 * holding a mapped LDAP group means membership of the project team
 * (added as a full member when absent — a group member must be a team
 * member, as the UI requires) and of the Mingle group; no longer
 * holding it removes the user from that Mingle group only — team
 * membership is never removed by sync, so a person dropped from a
 * directory group keeps their cards and history. Mappings naming an
 * unknown project or group are skipped, never created.
 *
 * Invariants: reconciliation is idempotent — a second sign-in with the
 * same directory groups writes nothing; every write happens in one
 * transaction with one LdapGroupsReconciled event; no membership
 * command is bypassed for anything other than what the directory
 * asserted.
 *
 * Public interface: `parseLdapGroupMappings`, `ldapGroupsHolding`,
 * `reconcileLdapGroups`, `LdapGroupMapping`.
 *
 * Owner context: Identity & Access.
 */
import { and, eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { groupMemberships, groups, teamMemberships } from "~/db/schema/membership";
import { projects } from "~/db/schema/projects";
import { emitEvent } from "~/domain/events.server";
import type { LdapSettings } from "~/domain/identity/auth-configuration.server";
import { escapeFilterValue, type LdapDirectory } from "~/domain/identity/ldap-strategy.server";
import { DEFAULT_PROJECT_ROLE } from "~/shared/wire-types";

/** One line of the mappings setting, parsed. */
export interface LdapGroupMapping {
  groupDn: string;
  projectIdentifier: string;
  groupName: string;
}

const MAPPING_LINE = /^(.+?)\s*=>\s*([A-Za-z0-9_]+)\s*\/\s*(.+?)\s*$/;

/**
 * Parses the mappings text: one `<group DN> => <project>/<group>` per
 * line, blank lines and `#` comments ignored.
 *
 * @param text - the stored setting
 * @returns the mappings, and one error per malformed line
 */
export function parseLdapGroupMappings(text: string): { mappings: LdapGroupMapping[]; errors: string[] } {
  const mappings: LdapGroupMapping[] = [];
  const errors: string[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const match = MAPPING_LINE.exec(line);
    if (!match) {
      errors.push(`line ${index + 1} must read "<group DN> => <project identifier>/<group name>"`);
      return;
    }
    mappings.push({ groupDn: match[1].trim(), projectIdentifier: match[2].toLowerCase(), groupName: match[3] });
  });
  return { mappings, errors };
}

/**
 * Asks the directory which mapped groups name the user's DN as a
 * member — the legacy group check's filter, once per mapping.
 *
 * @param directory - an open, bound directory connection
 * @param settings - for the group object class and member attribute (defaults: any class, `member`)
 * @param mappings - the parsed mappings
 * @param userDn - the signed-in user's entry DN
 * @returns the DNs of the mapped groups that hold the user, normalized as written in the mapping
 */
export async function ldapGroupsHolding(
  directory: LdapDirectory,
  settings: LdapSettings,
  mappings: LdapGroupMapping[],
  userDn: string,
): Promise<Set<string>> {
  const memberAttribute = settings.groupAttribute || "member";
  const classFilter = settings.groupObjectClass ? `(objectClass=${escapeFilterValue(settings.groupObjectClass)})` : "";
  const holding = new Set<string>();
  for (const mapping of mappings) {
    if (holding.has(mapping.groupDn)) continue;
    let entries;
    try {
      entries = await directory.search(mapping.groupDn, `(&${classFilter}(${memberAttribute}=${escapeFilterValue(userDn)}))`, [memberAttribute]);
    } catch {
      // A mapped group that does not exist in the directory holds nobody.
      continue;
    }
    if (entries.length > 0) holding.add(mapping.groupDn);
  }
  return holding;
}

export interface ReconcileLdapGroupsInput {
  userId: number;
  mappings: LdapGroupMapping[];
  /** The mapped group DNs the directory says the user holds. */
  holding: Set<string>;
}

/** What a reconciliation changed. */
export interface LdapGroupsReconciliation {
  addedToTeams: number[];
  addedToGroups: number[];
  removedFromGroups: number[];
}

/**
 * ReconcileLdapGroups — makes the user's mapped Mingle group
 * memberships match the directory.
 *
 * DOES: for each mapping whose project and group exist — when the
 * directory holds the user: inserts the `team_memberships` row (role
 * DEFAULT_PROJECT_ROLE) if absent and the `group_memberships` row if
 * absent; when it does not: deletes the `group_memberships` row if
 * present. Appends one LdapGroupsReconciled event carrying the ids
 * changed when anything changed; writes nothing and emits nothing when
 * the state already matches. One transaction.
 * REJECTS: never — an unknown project or group in a mapping is skipped.
 *
 * @returns what changed
 */
export function reconcileLdapGroups(db: BetterSQLite3Database, input: ReconcileLdapGroupsInput): LdapGroupsReconciliation {
  return db.transaction((tx) => {
    const outcome: LdapGroupsReconciliation = { addedToTeams: [], addedToGroups: [], removedFromGroups: [] };
    const seen = new Set<string>();
    for (const mapping of input.mappings) {
      const key = `${mapping.projectIdentifier}/${mapping.groupName.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const project = tx.select({ id: projects.id }).from(projects).where(eq(projects.identifier, mapping.projectIdentifier)).get();
      if (!project) continue;
      const group = tx
        .select({ id: groups.id })
        .from(groups)
        .where(and(eq(groups.projectId, project.id), sql`lower(${groups.name}) = ${mapping.groupName.toLowerCase()}`))
        .get();
      if (!group) continue;
      const inGroup = tx
        .select({ id: groupMemberships.id })
        .from(groupMemberships)
        .where(and(eq(groupMemberships.groupId, group.id), eq(groupMemberships.userId, input.userId)))
        .get();
      if (input.holding.has(mapping.groupDn)) {
        const onTeam = tx
          .select({ id: teamMemberships.id })
          .from(teamMemberships)
          .where(and(eq(teamMemberships.projectId, project.id), eq(teamMemberships.userId, input.userId)))
          .get();
        if (!onTeam) {
          tx.insert(teamMemberships).values({ projectId: project.id, userId: input.userId, role: DEFAULT_PROJECT_ROLE }).run();
          outcome.addedToTeams.push(project.id);
        }
        if (!inGroup) {
          tx.insert(groupMemberships).values({ groupId: group.id, userId: input.userId }).run();
          outcome.addedToGroups.push(group.id);
        }
      } else if (inGroup) {
        tx.delete(groupMemberships).where(eq(groupMemberships.id, inGroup.id)).run();
        outcome.removedFromGroups.push(group.id);
      }
    }
    if (outcome.addedToTeams.length + outcome.addedToGroups.length + outcome.removedFromGroups.length > 0) {
      emitEvent(tx, {
        type: "LdapGroupsReconciled",
        aggregateType: "User",
        aggregateId: input.userId,
        payload: { ...outcome },
        actorUserId: input.userId,
      });
    }
    return outcome;
  });
}
