/**
 * Detection and repair of the legacy "behavior-type" key on event
 * conditions/actions (issue #16).
 *
 * Construct 3 stores the behavior an ACE belongs to under the camelCase key
 * "behaviorType", a sibling of id/objectClass/sid/parameters, holding the
 * behavior's *name* as defined on the object type or one of its families
 * (verified against Scirra/Construct-Example-Projects fire-bars and other
 * public C3 folder projects). Older construct3-mcp versions wrote
 * "behavior-type" instead; as reported in issue #16 (r501), the editor does
 * not read that key, looks the ACE up on the base plugin and refuses to open
 * the project ("missing action id ..."). An ACE that also carries a valid
 * "behaviorType" is resolved through that key, so a leftover "behavior-type"
 * next to it is dead data rather than a load failure.
 */

import type { C3Event } from '../types.js';
import type { BehaviorCheck } from './behavior-refs.js';

/** Key Construct 3 reads for behavior conditions/actions. */
export const BEHAVIOR_TYPE_KEY = 'behaviorType';
/** Key written by construct3-mcp before the issue #16 fix. Not read by C3. */
export const LEGACY_BEHAVIOR_TYPE_KEY = 'behavior-type';

const MAX_NODES = 100_000;
const MAX_DEPTH = 50;

/** One condition/action carrying the legacy key. */
export interface LegacyBehaviorKeyHit {
  kind: 'condition' | 'action';
  /** ACE id, e.g. "simulate-control" */
  id?: string;
  objectClass?: string;
  sid?: number;
  /** Value of the legacy "behavior-type" key */
  legacyValue: unknown;
  /** Value of "behaviorType" if the ACE already has one */
  behaviorType?: unknown;
  /** Set on fixable hits whose behavior could not be checked (e.g. unreadable object type file) */
  warning?: string;
}

export interface LegacyBehaviorKeyConflict extends LegacyBehaviorKeyHit {
  reason: string;
}

export interface LegacyBehaviorKeyScan {
  /** ACEs whose legacy key can be (or was) rewritten to behaviorType */
  fixable: LegacyBehaviorKeyHit[];
  /** ACEs whose legacy value names no behavior on the objectClass (only with `resolve`); never modified */
  unresolved: LegacyBehaviorKeyConflict[];
  /** ACEs that need a human decision (conflicting or invalid values); never modified */
  conflicts: LegacyBehaviorKeyConflict[];
  /** True when the node/depth limit stopped the scan, so ACEs may have been missed */
  truncated: boolean;
}

export interface LegacyBehaviorKeyScanOptions {
  /** Rewrite fixable ACEs in place */
  apply?: boolean;
  /**
   * Checks that a legacy value names a behavior on the ACE's objectClass
   * before it is renamed. Without it every well-formed value is fixable.
   * Values that are ruled out ('missing') are reported as unresolved and left
   * alone — renaming them would only swap one load error for another.
   */
  resolve?: (objectClass: string, behaviorName: string) => BehaviorCheck;
}

/**
 * Scan an event tree for conditions/actions that carry the legacy
 * "behavior-type" key. With `apply: true` the fixable ones are rewritten in
 * place: the key is renamed to "behaviorType" at the same position (so the
 * key order matches what C3 writes), or dropped when an identical
 * "behaviorType" already exists. Unresolved values and conflicts are
 * reported and left untouched.
 *
 * Script actions ({ type: "script", script: string | string[] }) never carry
 * a behavior key and are skipped regardless of the script's shape.
 */
export function scanLegacyBehaviorKeys(
  events: C3Event[],
  options: LegacyBehaviorKeyScanOptions = {},
): LegacyBehaviorKeyScan {
  const result = emptyScan();
  const stack: Array<{ event: unknown; depth: number }> = [];
  for (let i = events.length - 1; i >= 0; i--) {
    stack.push({ event: events[i], depth: 0 });
  }
  let nodeCount = 0;

  while (stack.length > 0) {
    if (nodeCount++ > MAX_NODES) {
      result.truncated = true;
      break;
    }
    const { event, depth } = stack.pop()!;
    if (!isRecord(event)) continue;
    if (depth > MAX_DEPTH) {
      result.truncated = true;
      continue;
    }

    scanAceList(event.conditions, 'condition', result, options);
    scanAceList(event.actions, 'action', result, options);

    if (Array.isArray(event.children)) {
      for (let i = event.children.length - 1; i >= 0; i--) {
        stack.push({ event: event.children[i], depth: depth + 1 });
      }
    }
  }

  return result;
}

/** Same as scanLegacyBehaviorKeys, for a flat list of conditions or actions. */
export function scanLegacyBehaviorKeysInAces(
  aces: unknown[],
  kind: 'condition' | 'action',
  options: LegacyBehaviorKeyScanOptions = {},
): LegacyBehaviorKeyScan {
  const result = emptyScan();
  scanAceList(aces, kind, result, options);
  return result;
}

/** True when the value can name a behavior (a non-empty string). */
export function isBehaviorName(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/**
 * True when the ACE holds a behavior name only under the legacy key and has
 * no usable "behaviorType" — the issue #16 shape Construct 3 cannot load.
 */
export function hasOnlyLegacyBehaviorName(hit: LegacyBehaviorKeyHit): boolean {
  return isBehaviorName(hit.legacyValue) && !isBehaviorName(hit.behaviorType);
}

/** Short human-readable label for a hit, e.g. `action "flash" on "Car" (SID 12)`. */
export function describeLegacyHit(hit: LegacyBehaviorKeyHit): string {
  return `${hit.kind} "${hit.id ?? '?'}" on "${hit.objectClass ?? '?'}"${hit.sid !== undefined ? ` (SID ${hit.sid})` : ''}`;
}

function emptyScan(): LegacyBehaviorKeyScan {
  return { fixable: [], unresolved: [], conflicts: [], truncated: false };
}

function scanAceList(
  list: unknown,
  kind: 'condition' | 'action',
  result: LegacyBehaviorKeyScan,
  options: LegacyBehaviorKeyScanOptions,
): void {
  if (!Array.isArray(list)) return;
  for (const ace of list) {
    if (!isRecord(ace) || !(LEGACY_BEHAVIOR_TYPE_KEY in ace)) continue;

    const hit: LegacyBehaviorKeyHit = {
      kind,
      id: typeof ace.id === 'string' ? ace.id : undefined,
      objectClass: typeof ace.objectClass === 'string' ? ace.objectClass : undefined,
      sid: typeof ace.sid === 'number' ? ace.sid : undefined,
      legacyValue: ace[LEGACY_BEHAVIOR_TYPE_KEY],
    };
    const hasCurrent = BEHAVIOR_TYPE_KEY in ace;
    const current = ace[BEHAVIOR_TYPE_KEY];
    if (hasCurrent) hit.behaviorType = current;

    const legacy = ace[LEGACY_BEHAVIOR_TYPE_KEY];
    if (!isBehaviorName(legacy)) {
      const used = isBehaviorName(current) ? `; "${BEHAVIOR_TYPE_KEY}" ${show(current)} is what Construct 3 uses` : '';
      result.conflicts.push({ ...hit, reason: `"${LEGACY_BEHAVIOR_TYPE_KEY}" holds ${show(legacy)}, not a behavior name${used}` });
      continue;
    }
    if (hasCurrent && current !== legacy) {
      result.conflicts.push({
        ...hit,
        reason: `"${BEHAVIOR_TYPE_KEY}" ${show(current)} and "${LEGACY_BEHAVIOR_TYPE_KEY}" ${show(legacy)} disagree`,
      });
      continue;
    }

    // Renaming activates a behavior lookup in C3, so check the name first.
    // (Dropping a duplicate of an existing behaviorType changes nothing C3 reads.)
    if (!hasCurrent && options.resolve) {
      const check: BehaviorCheck = hit.objectClass === undefined
        ? { status: 'missing', message: 'the condition/action has no objectClass' }
        : options.resolve(hit.objectClass, legacy);
      if (check.status === 'missing') {
        result.unresolved.push({ ...hit, reason: check.message });
        continue;
      }
      if (check.status === 'unverified') hit.warning = check.message;
    }

    result.fixable.push(hit);
    if (options.apply) renameLegacyKeyInPlace(ace);
  }
}

/** Rename the legacy key in place, keeping the object's key order. */
function renameLegacyKeyInPlace(ace: Record<string, unknown>): void {
  const entries = Object.entries(ace);
  const hasCurrent = BEHAVIOR_TYPE_KEY in ace;
  for (const key of Object.keys(ace)) delete ace[key];
  for (const [key, value] of entries) {
    if (key === LEGACY_BEHAVIOR_TYPE_KEY) {
      if (!hasCurrent) ace[BEHAVIOR_TYPE_KEY] = value;
    } else {
      ace[key] = value;
    }
  }
}

function show(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
