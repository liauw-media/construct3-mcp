/**
 * Per-instance instance variable values and effect entries on layout
 * instances.
 *
 * The editor stores a value for every instance variable of the object type
 * and of every family it belongs to on each of its layout instances, in
 * `instanceVariables` ({ name: value }), family variables first, then the
 * object's own; and an entry per effect of the object type and its families
 * in `effects` ({ name: { isEnabled, parameters } }). Checked against Scirra's
 * public example projects (github.com/Scirra/Construct-Example-Projects):
 * in winter-tree the family "Branches" declares five variables and the effect
 * "AdjustHSL", its member "Branch" none, and the Branch instance holds a value
 * for each of the five and an "AdjustHSL" entry; in meowgix the instances of
 * "PlayerProjectile" list the variables of its families before its own.
 * Variable definitions there carry no initial value, so a value added here is
 * the type's default: 0, "" or false.
 *
 * What the editor does with an instance that lacks a value, or holds one for
 * a variable its object no longer has, is not verified. The tools keep the
 * values in step with the definitions, as the editor saves them: an added
 * variable (on the object or a family, or a family the object joins) gets its
 * default on every instance, a removed one (or one of a family the object
 * leaves) loses its value, and a family effect's entries go with the family.
 */

/** An instance variable an object type's instances hold a value for. */
export interface InstanceVariableDef {
  name: string;
  /** "number", "string" or "boolean" as the editor saves it */
  type: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The instance variables of one object type or family (its instanceVariables), as name + type. */
export function instanceVariablesOf(owner: unknown): InstanceVariableDef[] {
  if (!isRecord(owner) || !Array.isArray(owner.instanceVariables)) return [];
  return owner.instanceVariables
    .filter((v): v is { name: string; type?: unknown } => isRecord(v) && typeof v.name === 'string')
    .map(v => ({ name: v.name, type: typeof v.type === 'string' ? v.type : 'number' }));
}

/** The effect names of one object type or family (its effectTypes). */
export function effectNamesOf(owner: unknown): string[] {
  if (!isRecord(owner) || !Array.isArray(owner.effectTypes)) return [];
  return owner.effectTypes
    .map(e => (isRecord(e) ? e.name : undefined))
    .filter((name): name is string => typeof name === 'string');
}

/** The families in `families` that list `objectName` as a member, in map order. */
function familiesOf(objectName: string, families: ReadonlyMap<string, unknown>): unknown[] {
  return [...families.values()].filter(f => isRecord(f) && Array.isArray(f.members) && f.members.includes(objectName));
}

/**
 * The instance variables whose values the editor stores on the instances of
 * `objectName`: those of every family that lists it as a member (families in
 * `families` order), then its own. A name seen twice is listed once.
 */
export function expectedInstanceVariables(
  objectName: string,
  objectType: unknown,
  families: ReadonlyMap<string, unknown>,
): InstanceVariableDef[] {
  const result: InstanceVariableDef[] = [];
  const seen = new Set<string>();
  for (const owner of [...familiesOf(objectName, families), objectType]) {
    for (const v of instanceVariablesOf(owner)) {
      if (seen.has(v.name)) continue;
      seen.add(v.name);
      result.push(v);
    }
  }
  return result;
}

/** The effect names the instances of `objectName` carry entries for: its families' and its own. */
export function expectedInstanceEffects(
  objectName: string,
  objectType: unknown,
  families: ReadonlyMap<string, unknown>,
): string[] {
  return [...new Set([...familiesOf(objectName, families), objectType].flatMap(effectNamesOf))];
}

/** The value a new instance variable gets on existing instances: 0, "" or false by its type. */
export function defaultInstanceVariableValue(type: string): number | string | boolean {
  if (type === 'string') return '';
  if (type === 'boolean') return false;
  return 0;
}

/** Whether `value` fits an instance variable of `type` (number, string, boolean). */
export function fitsInstanceVariableType(value: unknown, type: string): boolean {
  if (type === 'number' || type === 'string' || type === 'boolean') return typeof value === type;
  return true;
}

/**
 * Check instance variable values given for an instance of `objectName`
 * against the variables it has (`expected`): names it has no variable of
 * (`unknown`; a name that matches one only ignoring case is suggested in
 * `suggestions`) and values whose type differs from the variable's
 * (`mistyped`, as sentences).
 */
export function checkInstanceVariableValues(
  expected: InstanceVariableDef[],
  given: Record<string, unknown>,
): { unknown: string[]; suggestions: Map<string, string>; mistyped: string[] } {
  const byName = new Map(expected.map(v => [v.name, v]));
  const unknown: string[] = [];
  const suggestions = new Map<string, string>();
  const mistyped: string[] = [];
  for (const [name, value] of Object.entries(given)) {
    const def = byName.get(name);
    if (!def) {
      unknown.push(name);
      const other = expected.find(v => v.name.toLowerCase() === name.toLowerCase());
      if (other) suggestions.set(name, other.name);
      continue;
    }
    if (!fitsInstanceVariableType(value, def.type)) {
      mistyped.push(`"${name}" is a ${def.type} variable, got ${JSON.stringify(value)}`);
    }
  }
  return { unknown, suggestions, mistyped };
}

/**
 * Values for a new instance: the default of every expected variable, in the
 * editor's order, with the given values on top (given names that are not
 * expected are not added; check them with checkInstanceVariableValues first).
 */
export function buildInstanceVariableValues(
  expected: InstanceVariableDef[],
  given: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const v of expected) {
    values[v.name] = given && Object.hasOwn(given, v.name) ? given[v.name] : defaultInstanceVariableValue(v.type);
  }
  return values;
}

/**
 * Bring an existing instance's instance variable values in line after the
 * variables of its object type (or its family membership) changed: add the
 * default value for every expected variable it has no value for, and remove
 * the values named in `drop` that are no longer expected. Existing values
 * keep their value and their order; a new one goes right after the last
 * existing value that comes before it in `expected`, or else before the first
 * expected one, so a family variable lands before the object's own. Returns
 * the names added, and the names and values removed.
 */
export function syncInstanceVariables(
  instance: Record<string, unknown>,
  expected: InstanceVariableDef[],
  change: { drop?: Iterable<string> } = {},
): { modified: boolean; added: string[]; dropped: Array<{ name: string; value: unknown }> } {
  const entries = Object.entries(isRecord(instance.instanceVariables) ? instance.instanceVariables : {});
  const added: string[] = [];
  const dropped: Array<{ name: string; value: unknown }> = [];
  let modified = !isRecord(instance.instanceVariables);

  const rank = new Map(expected.map((v, i) => [v.name, i]));
  expected.forEach((v, r) => {
    if (entries.some(([n]) => n === v.name)) return;
    entries.splice(insertPosition(entries.map(([n]) => rank.get(n)), r), 0, [v.name, defaultInstanceVariableValue(v.type)]);
    added.push(v.name);
    modified = true;
  });
  for (const name of change.drop ?? []) {
    const i = entries.findIndex(([n]) => n === name);
    if (rank.has(name) || i === -1) continue;
    const [[, value]] = entries.splice(i, 1);
    dropped.push({ name, value });
    modified = true;
  }

  if (modified) instance.instanceVariables = Object.fromEntries(entries);
  return { modified, added, dropped };
}

/** Whether an instance variable value is a default one (0, "" or false), which a sync adds back as it was. */
export function isDefaultInstanceVariableValue(value: unknown): boolean {
  return value === 0 || value === '' || value === false;
}

/**
 * Remove the effect entries named in `drop` that are no longer expected
 * (`expected`: the effects the instance's object type and families still
 * have) from an instance's `effects`. Returns the names and entries removed.
 */
export function dropInstanceEffects(
  instance: Record<string, unknown>,
  drop: Iterable<string>,
  expected: readonly string[],
): Array<{ name: string; entry: unknown }> {
  const effects = instance.effects;
  if (!isRecord(effects)) return [];
  const dropped: Array<{ name: string; entry: unknown }> = [];
  for (const name of drop) {
    if (expected.includes(name) || !Object.hasOwn(effects, name)) continue;
    dropped.push({ name, entry: effects[name] });
    delete effects[name];
  }
  return dropped;
}

/**
 * Where a new entry of expected rank `rank` goes among entries whose ranks
 * are `ranks` (undefined: not expected): after the last one ranked lower,
 * else before the first expected one, else at the end.
 */
function insertPosition(ranks: Array<number | undefined>, rank: number): number {
  for (let i = ranks.length - 1; i >= 0; i--) {
    const r = ranks[i];
    if (r !== undefined && r < rank) return i + 1;
  }
  const firstExpected = ranks.findIndex(r => r !== undefined);
  return firstExpected === -1 ? ranks.length : firstExpected;
}
