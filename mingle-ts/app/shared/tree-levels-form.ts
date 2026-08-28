/**
 * Tree levels form encoding — how the define and reconfigure forms
 * post a tree's chain of card types (Phase 23).
 *
 * Purpose: both tree routes render the same level rows and parse the
 * same fields (`level_type_<i>`, `relationship_name_<i>`), so the
 * field names and the parse live once, here, and cannot drift.
 * Runtime-neutral: FormData only, no Node or DOM types (rule 8b).
 *
 * Public interface: `MAX_TREE_LEVELS`, `levelFieldNames`,
 * `levelsFromForm`.
 *
 * Owner context: Card Trees (wire encoding).
 */

/** How many levels the forms offer (legacy's form grew dynamically). */
export const MAX_TREE_LEVELS = 5;

/** The field names of one level row. */
export function levelFieldNames(index: number): { type: string; relationship: string } {
  return { type: `level_type_${index}`, relationship: `relationship_name_${index}` };
}

/** One posted level: the card type and the relationship name cards below it carry. */
export interface PostedTreeLevel {
  cardTypeId: number;
  relationshipName: string;
}

/**
 * The levels a form posted, in row order, skipping rows with no type.
 *
 * @param form - the posted form
 */
export function levelsFromForm(form: FormData): PostedTreeLevel[] {
  const levels: PostedTreeLevel[] = [];
  for (let i = 0; i < MAX_TREE_LEVELS; i++) {
    const names = levelFieldNames(i);
    const cardTypeId = Number(form.get(names.type));
    if (!Number.isSafeInteger(cardTypeId) || cardTypeId <= 0) continue;
    levels.push({ cardTypeId, relationshipName: String(form.get(names.relationship) ?? "") });
  }
  return levels;
}
