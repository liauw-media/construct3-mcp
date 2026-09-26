/**
 * Resolution of behaviorType references on event conditions/actions.
 *
 * Construct 3 resolves a behavior condition/action by the behavior's *name*
 * (BehaviorType.name, not its behaviorId) on the ACE's objectClass: the
 * object type's own behaviorTypes plus those of every family it belongs to.
 * A family objectClass has only the family's own behaviors. Verified against
 * public C3 folder projects (mapsandapps/construct-3-games battlelands:
 * objectClass "Enemy" + behaviorType "Tween" where Tween sits on the Entities
 * family; behaviorId "EightDir" is referenced by its name "8Direction").
 *
 * Pure and synchronous: callers load the object types / families they need
 * and pass them in, so both the tools (per-object reads) and the integrity
 * analyzer (bulk reads) can share it.
 */

import type { BehaviorType } from '../types.js';

/** Project data needed to resolve behavior references. */
export interface BehaviorLookupData {
  /** All object type names in the project (readable or not) */
  objectNames: ReadonlySet<string>;
  /** All family names in the project (readable or not) */
  familyNames: ReadonlySet<string>;
  /** Object types that could be read; a listed name missing here is unreadable */
  objectTypes: ReadonlyMap<string, unknown>;
  /** Families that could be read; a listed name missing here is unreadable */
  families: ReadonlyMap<string, unknown>;
}

/**
 * Outcome of a behavior lookup:
 * - ok: the behavior exists on the objectClass (or one of its families)
 * - unverified: a file needed for the check could not be read
 * - missing: the project data rules the behavior out
 */
export type BehaviorCheck =
  | { status: 'ok' }
  | { status: 'unverified'; message: string }
  | { status: 'missing'; message: string };

/** Check that `behaviorType` names a behavior available on `objectClass`. */
export function checkBehaviorName(
  objectClass: string,
  behaviorType: string,
  data: BehaviorLookupData,
): BehaviorCheck {
  if (objectClass === 'System') {
    return {
      status: 'missing',
      message: `behaviorType "${behaviorType}" on "System": System has no behaviors — omit behaviorType for System conditions/actions.`,
    };
  }

  let available: BehaviorType[];
  let where: string;
  let unreadableFamilies = 0;
  if (data.objectNames.has(objectClass)) {
    const obj = data.objectTypes.get(objectClass);
    if (!isRecord(obj)) {
      return {
        status: 'unverified',
        message: `behaviorType "${behaviorType}" on "${objectClass}" could not be verified (object type file unreadable).`,
      };
    }
    available = [...behaviorsOf(obj)];
    for (const name of data.familyNames) {
      const family = data.families.get(name);
      if (!isRecord(family)) {
        unreadableFamilies++;
        continue;
      }
      if (Array.isArray(family.members) && family.members.includes(objectClass)) {
        available.push(...behaviorsOf(family));
      }
    }
    where = `"${objectClass}" or its families`;
  } else if (data.familyNames.has(objectClass)) {
    const family = data.families.get(objectClass);
    if (!isRecord(family)) {
      return {
        status: 'unverified',
        message: `behaviorType "${behaviorType}" on family "${objectClass}" could not be verified (family file unreadable).`,
      };
    }
    available = behaviorsOf(family);
    where = `family "${objectClass}"`;
  } else {
    return {
      status: 'missing',
      message: `behaviorType "${behaviorType}" on "${objectClass}": "${objectClass}" is not an object type or family in this project.`,
    };
  }

  if (available.some(b => b.name === behaviorType)) return { status: 'ok' };

  if (unreadableFamilies > 0) {
    // The behavior may sit on a family we could not read — do not claim it is missing.
    return {
      status: 'unverified',
      message: `behaviorType "${behaviorType}" on "${objectClass}" could not be verified: it is not on ${where}, ` +
        `but ${unreadableFamilies} family file(s) could not be read.`,
    };
  }

  const names = [...new Set(available.map(b => b.name))];
  let hint = '';
  const byId = available.find(b => b.behaviorId === behaviorType);
  const byCase = available.find(b => b.name.toLowerCase() === behaviorType.toLowerCase());
  if (byId) {
    hint = ` Did you mean the behavior name "${byId.name}"? ("${behaviorType}" is its behaviorId; events use the name.)`;
  } else if (byCase) {
    hint = ` Did you mean "${byCase.name}"?`;
  }
  return {
    status: 'missing',
    message: `behaviorType "${behaviorType}" does not match any behavior on ${where} ` +
      `(available: ${names.length > 0 ? names.join(', ') : 'none'}). ` +
      `Construct 3 resolves behavior conditions/actions by behavior name.${hint}`,
  };
}

function behaviorsOf(entity: Record<string, unknown>): BehaviorType[] {
  const list = entity.behaviorTypes;
  if (!Array.isArray(list)) return [];
  return list.filter((b): b is BehaviorType => isRecord(b) && typeof b.name === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
