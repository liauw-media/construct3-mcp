/**
 * Per-instance behavior entries on layout instances.
 *
 * The editor stores one entry per behavior on every instance of an object
 * type, shaped { properties: { ...every property value } } (defaults
 * included), for the object's own behaviors and those of every family it
 * belongs to. Family behaviors come first, then the object's own, each in
 * behaviorTypes order. Verified against Scirra's public example projects
 * (github.com/Scirra/Construct-Example-Projects): 13,461 of 13,461 instances
 * of objects with behaviors carry an entry for each one, all 186 instances
 * with both kinds list the family entries first, and every entry has the
 * { properties } shape.
 *
 * A property missing from an entry is filled in with its default when the
 * editor opens the project: Scirra's examples saved by older releases carry
 * entries without properties that later releases added (69 Pin entries are
 * { properties: {} }, from before Pin had "destroy"), and the example
 * browser opens them in current releases. So a behavior without known
 * defaults (third-party addons) gets the minimal entry { properties: {} }.
 * Whether the editor also accepts an instance with no entry at all is not
 * verified, which is why every behavior gets an entry, why a sync adds the
 * entries an instance lacks (older versions of these tools wrote instances
 * without them), and why validate_project reports instances that lack one.
 */

import type { Construct3ProjectReader } from './project-reader.js';
import { forEachLayoutInstance } from './layers.js';
import {
  BEHAVIOR_INSTANCE_DEFAULTS,
  KNOWN_SCIRRA_BEHAVIORS,
  createBehaviorInstanceEntry,
} from './templates.js';

/** A behavior that the instances of an object type carry an entry for. */
export interface InstanceBehavior {
  /** Behavior name (the entry key) */
  name: string;
  behaviorId: string;
}

/** Families of the project for expectedInstanceBehaviors; an empty map when they cannot be read. */
export async function readFamiliesForInstances(
  reader: Pick<Construct3ProjectReader, 'readAllFamilies'>,
): Promise<ReadonlyMap<string, unknown>> {
  try {
    return await reader.readAllFamilies();
  } catch {
    return new Map();
  }
}

/**
 * The behaviors whose entries the editor stores on the instances of
 * `objectName`, in the editor's order: the behaviors of every family that
 * lists the object as a member (families in `families` order, which is the
 * project order), then the object's own behaviors. A name seen twice is
 * listed once.
 */
export function expectedInstanceBehaviors(
  objectName: string,
  objectType: unknown,
  families: ReadonlyMap<string, unknown>,
): InstanceBehavior[] {
  const result: InstanceBehavior[] = [];
  const seen = new Set<string>();
  const addFrom = (owner: unknown) => {
    for (const b of behaviorTypesOf(owner)) {
      if (seen.has(b.name)) continue;
      seen.add(b.name);
      result.push(b);
    }
  };
  for (const family of families.values()) {
    if (isRecord(family) && Array.isArray(family.members) && family.members.includes(objectName)) {
      addFrom(family);
    }
  }
  addFrom(objectType);
  return result;
}

/**
 * Behaviors dict for a new instance: one entry per expected behavior with the
 * built-in defaults, the caller's values merged on top. A caller value may be
 * in the editor shape { properties: {...} } (as get_layout_details returns
 * it) or flat { prop: value }; both are stored in the editor shape. Caller
 * entries for other names are kept after the expected ones, with a warning.
 */
export function buildInstanceBehaviors(
  objectName: string,
  expected: InstanceBehavior[],
  given: Record<string, unknown> | undefined,
): { behaviors: Record<string, unknown>; warnings: string[] } {
  const behaviors: Record<string, unknown> = {};
  const warnings: string[] = [];
  const unknownDefaults: InstanceBehavior[] = [];

  for (const b of expected) {
    const { entry, known } = createBehaviorInstanceEntry(b.behaviorId);
    if (given && Object.hasOwn(given, b.name)) {
      const custom = toEntry(given[b.name]);
      const props = custom.properties as Record<string, unknown>;
      const defined = BEHAVIOR_INSTANCE_DEFAULTS[b.behaviorId];
      const undefinedProps = known ? Object.keys(props).filter(p => !Object.hasOwn(defined, p)) : [];
      if (undefinedProps.length > 0) {
        const list = Object.keys(defined).join(', ') || '(none)';
        warnings.push(`Behavior "${b.name}" (${b.behaviorId}) has no ${plural(undefinedProps.length, 'property', 'properties')} ${quoteList(undefinedProps)} in Construct 3 r449 (later releases add a few); its properties are: ${list}. Written as given.`);
      }
      // The default's type is the property's type (check → boolean, combo → string, ...)
      const mistyped = known
        ? Object.entries(props).filter(([p, v]) => Object.hasOwn(defined, p) && typeof v !== typeof defined[p])
        : [];
      if (mistyped.length > 0) {
        const list = mistyped
          .map(([p, v]) => `"${p}" should be a ${typeof defined[p]} (default ${JSON.stringify(defined[p])}), got ${JSON.stringify(v)}`)
          .join('; ');
        warnings.push(`Behavior "${b.name}" (${b.behaviorId}): ${list}. Written as given.`);
      }
      behaviors[b.name] = { ...custom, properties: { ...entry.properties, ...props } };
    } else {
      behaviors[b.name] = entry;
      if (!known) unknownDefaults.push(b);
    }
  }

  if (given) {
    const expectedNames = new Set(expected.map(b => b.name));
    for (const [name, value] of Object.entries(given)) {
      if (expectedNames.has(name)) continue;
      warnings.push(`Behavior "${name}" is not defined on "${objectName}" or its families. Defined behaviors: ${[...expectedNames].join(', ') || '(none)'}. The entry was written as given.`);
      behaviors[name] = toEntry(value);
    }
  }

  if (unknownDefaults.length > 0) warnings.push(unknownDefaultsWarning(unknownDefaults));
  return { behaviors, warnings };
}

/**
 * Bring an existing instance's behavior entries in line after the behaviors
 * of its object type (or its family membership) changed: add a default entry
 * for each name in `add` that is expected but missing, and remove the entries
 * named in `drop` that are no longer expected. Existing entries keep their
 * values and their order (how the editor orders the behaviors of several
 * families is not verified, so an editor-saved order is never changed). A new
 * entry goes right after the last existing entry that comes before it in
 * `expected`, or else before the first expected entry; so a family behavior
 * lands before the object's own and an own behavior after them. `added` lists
 * the names that got a new entry, in the order they were added.
 */
export function syncInstanceBehaviors(
  instance: Record<string, unknown>,
  expected: InstanceBehavior[],
  change: { add?: Iterable<string>; drop?: Iterable<string> },
): { modified: boolean; added: string[]; unknownDefaults: InstanceBehavior[] } {
  const entries = Object.entries(isRecord(instance.behaviors) ? instance.behaviors : {});
  const added: string[] = [];
  const unknownDefaults: InstanceBehavior[] = [];
  let modified = !isRecord(instance.behaviors);

  const rank = new Map(expected.map((b, i) => [b.name, i]));
  const has = (name: string) => entries.some(([n]) => n === name);
  for (const name of change.add ?? []) {
    const r = rank.get(name);
    if (r === undefined || has(name)) continue;
    const b = expected[r];
    const { entry, known } = createBehaviorInstanceEntry(b.behaviorId);
    entries.splice(insertPosition(entries.map(([n]) => rank.get(n)), r), 0, [name, entry]);
    added.push(name);
    if (!known) unknownDefaults.push(b);
    modified = true;
  }
  for (const name of change.drop ?? []) {
    const i = entries.findIndex(([n]) => n === name);
    if (rank.has(name) || i === -1) continue;
    entries.splice(i, 1);
    modified = true;
  }

  if (modified) instance.behaviors = Object.fromEntries(entries);
  return { modified, added, unknownDefaults };
}

/** Instances of one object type in one layout that lack behavior entries. */
export interface MissingBehaviorEntries {
  layout: string;
  objectType: string;
  /** UIDs of the instances that lack an entry (instances without a numeric uid are left out) */
  uids: number[];
  /** How many instances lack an entry */
  instances: number;
  /** The behaviors some of these instances have no entry for, in the editor's order */
  missing: string[];
}

/**
 * Layout instances that have no entry for a behavior of their object type or
 * of its families (see expectedInstanceBehaviors), per layout and object
 * type. Instances of unknown object types are skipped; an instance without a
 * behaviors dict lacks every entry.
 */
export function findMissingBehaviorEntries(
  layouts: ReadonlyMap<string, unknown>,
  objects: ReadonlyMap<string, unknown>,
  families: ReadonlyMap<string, unknown>,
): MissingBehaviorEntries[] {
  const expectedByType = new Map<string, InstanceBehavior[]>();
  const expectedFor = (type: string): InstanceBehavior[] => {
    let expected = expectedByType.get(type);
    if (!expected) {
      expected = expectedInstanceBehaviors(type, objects.get(type), families);
      expectedByType.set(type, expected);
    }
    return expected;
  };

  const result: MissingBehaviorEntries[] = [];
  for (const [layoutName, layout] of layouts) {
    const byType = new Map<string, { uids: number[]; instances: number; missing: Set<string> }>();
    forEachLayoutInstance(layout, instance => {
      const type = instance.type;
      if (typeof type !== 'string' || !objects.has(type)) return;
      const behaviors = isRecord(instance.behaviors) ? instance.behaviors : {};
      const missing = expectedFor(type).filter(b => !Object.hasOwn(behaviors, b.name));
      if (missing.length === 0) return;
      let group = byType.get(type);
      if (!group) {
        group = { uids: [], instances: 0, missing: new Set() };
        byType.set(type, group);
      }
      group.instances++;
      if (typeof instance.uid === 'number') group.uids.push(instance.uid);
      for (const b of missing) group.missing.add(b.name);
    });
    for (const [objectType, group] of byType) {
      const missing = expectedFor(objectType).map(b => b.name).filter(name => group.missing.has(name));
      result.push({ layout: layoutName, objectType, uids: group.uids, instances: group.instances, missing });
    }
  }
  return result;
}

/**
 * Where a new entry of expected rank `rank` goes among entries whose ranks
 * are `ranks` (undefined: not expected): after the last one ranked lower,
 * else before the first expected one, else first.
 */
function insertPosition(ranks: Array<number | undefined>, rank: number): number {
  for (let i = ranks.length - 1; i >= 0; i--) {
    const r = ranks[i];
    if (r !== undefined && r < rank) return i + 1;
  }
  const firstExpected = ranks.findIndex(r => r !== undefined);
  return firstExpected === -1 ? 0 : firstExpected;
}

/**
 * Warning for behaviors that got an empty entry because their defaults are
 * not known. The keys of BEHAVIOR_INSTANCE_DEFAULTS are every behaviorId the
 * r449 editor defines, so an id that differs from one only in case, or that
 * KNOWN_SCIRRA_BEHAVIORS lists without the editor defining it, is pointed out:
 * no addon with that id exists, so nothing would fill in its properties.
 */
export function unknownDefaultsWarning(behaviors: InstanceBehavior[]): string {
  const seen = new Set<string>();
  const unique = behaviors.filter(b => !seen.has(b.name) && seen.add(b.name));
  const list = unique.map(b => `"${b.name}" (${b.behaviorId})`).join(', ');
  const hints = [...new Set(unique.map(b => b.behaviorId))]
    .map(builtInIdHint)
    .filter((h): h is string => h !== undefined);
  return `No built-in defaults known for behavior ${list}: wrote the entry as { properties: {} }. `
    + 'For a third-party addon, Construct 3 fills in missing properties with the addon\'s defaults when it opens the project.'
    + (hints.length > 0 ? ` ${hints.join(' ')}` : '');
}

/** Hint for a behaviorId that looks like a built-in one but is not an id the r449 editor defines. */
function builtInIdHint(behaviorId: string): string | undefined {
  const lower = behaviorId.toLowerCase();
  const match = Object.keys(BEHAVIOR_INSTANCE_DEFAULTS).find(id => id.toLowerCase() === lower);
  if (match) {
    return `Behavior ids are case-sensitive: the Construct 3 r449 editor's built-in behavior is "${match}", not "${behaviorId}".`;
  }
  if (Object.hasOwn(KNOWN_SCIRRA_BEHAVIORS, behaviorId)) {
    return `"${behaviorId}" is not a behavior id the Construct 3 r449 editor defines; check the behaviorId.`;
  }
  return undefined;
}

/** Caller value → editor shape { properties: {...}, ...other keys }. */
function toEntry(value: unknown): Record<string, unknown> {
  if (isRecord(value) && isRecord(value.properties)) return { ...value, properties: { ...value.properties } };
  return { properties: isRecord(value) ? { ...value } : {} };
}

/** The behaviors of one object type or family (its behaviorTypes), as name + behaviorId. */
export function behaviorTypesOf(owner: unknown): InstanceBehavior[] {
  if (!isRecord(owner) || !Array.isArray(owner.behaviorTypes)) return [];
  return owner.behaviorTypes
    .filter((b): b is { name: string; behaviorId: string } =>
      isRecord(b) && typeof b.name === 'string' && typeof b.behaviorId === 'string')
    .map(b => ({ name: b.name, behaviorId: b.behaviorId }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function quoteList(items: string[]): string {
  return items.map(i => `"${i}"`).join(', ');
}
