/**
 * Event-related helpers extracted from mutations.ts.
 * Contains Zod schemas, recursive builders, and validators
 * used by event tools (add_event_block, add_event_to_sheet).
 */

import { z } from 'zod';
import type { Construct3ProjectReader } from '../construct3/project-reader.js';
import type { IdGenerator } from '../construct3/id-generator.js';
import type { Condition, Action, BlockEvent, StandardAction } from '../construct3/types.js';
import { createBlockEvent } from '../construct3/templates.js';
import { checkBehaviorName } from '../construct3/analyzers/behavior-refs.js';
import type { BehaviorLookupData } from '../construct3/analyzers/behavior-refs.js';
import {
  BEHAVIOR_TYPE_KEY,
  LEGACY_BEHAVIOR_TYPE_KEY,
  isBehaviorName,
  describeLegacyHit,
  scanLegacyBehaviorKeysInAces,
} from '../construct3/analyzers/legacy-behavior-keys.js';
import { boundedRecord } from './shared.js';

// ─── Zod Schemas ────────────────────────────────────────────

// Behavior ACEs: C3 stores the behavior under camelCase "behaviorType" (the
// behavior's name on the object type or one of its families). The kebab-case
// "behavior-type" is accepted as a deprecated input alias only — it is never
// written, because C3 ignores it and fails to open the project (issue #16).
const behaviorTypeDescription =
  'Behavior name for behavior conditions/actions, as defined on the object type or one of its families ' +
  '(e.g., "Platform", "8Direction"). Omit for plugin and System ACEs.';
const legacyBehaviorTypeDescription =
  'DEPRECATED alias for behaviorType — still accepted, but written as behaviorType. Use behaviorType.';

/** Condition schema shared by top-level and child events */
export const conditionSchema = z.object({
  id: z.string().describe('Condition ACE id (kebab-case, e.g., "on-start-of-layout", "on-collision-with-another-object")'),
  objectClass: z.string().describe('Object name or "System"'),
  behaviorType: z.string().optional().describe(behaviorTypeDescription),
  'behavior-type': z.string().optional().describe(legacyBehaviorTypeDescription),
  parameters: boundedRecord()
    .refine(obj => JSON.stringify(obj).length <= 50_000, 'Parameters payload too large (max 50KB)')
    .optional().describe('Condition parameters as key-value pairs (max 100 keys, depth 6)'),
  isInverted: z.boolean().optional().describe('Negate the condition'),
  isOr: z.boolean().optional().describe('OR-combine with previous condition (default: AND)'),
});

/** Standard action schema */
export const standardActionSchema = z.object({
  id: z.string().describe('Action ACE id (kebab-case, e.g., "set-instvar-value", "destroy")'),
  objectClass: z.string().describe('Object name or "System"'),
  behaviorType: z.string().optional().describe(behaviorTypeDescription),
  'behavior-type': z.string().optional().describe(legacyBehaviorTypeDescription),
  parameters: boundedRecord()
    .refine(obj => JSON.stringify(obj).length <= 50_000, 'Parameters payload too large (max 50KB)')
    .optional().describe('Action parameters as key-value pairs (max 100 keys, depth 6)'),
  callFunction: z.string().optional().describe('For function call actions'),
  disabled: z.boolean().optional().describe('Disable this individual action'),
});

/** Script action schema */
export const scriptActionSchema = z.object({
  type: z.literal('script').describe('Script action type'),
  script: z.string().describe('Inline JavaScript code'),
  disabled: z.boolean().optional().describe('Disable this individual script action'),
});

/** Union of standard and script actions */
export const actionSchema = z.union([standardActionSchema, scriptActionSchema]);

// ─── Recursive Child Event Schema ───────────────────────────

export interface ChildEventInput {
  conditions?: Array<z.infer<typeof conditionSchema>>;
  actions?: Array<z.infer<typeof standardActionSchema> | z.infer<typeof scriptActionSchema>>;
  disabled?: boolean;
  isElse?: boolean;
  children?: ChildEventInput[];
}

export const childEventSchema: z.ZodType<ChildEventInput> = z.lazy(() => z.object({
  conditions: z.array(conditionSchema).optional().default([]),
  actions: z.array(actionSchema).optional().default([]),
  disabled: z.boolean().optional(),
  isElse: z.boolean().optional(),
  children: z.array(childEventSchema).optional().default([]),
}));

// ─── Safety Limits ──────────────────────────────────────────

export const MAX_NESTING_DEPTH = 5;
export const MAX_TOTAL_EVENTS = 50;
export const MAX_ITEMS_PER_BLOCK = 100;

// Limits for SID-search traversal (matching index-builder.ts)
export const MAX_SEARCH_NODES = 100_000;
export const MAX_SEARCH_DEPTH = 50;

// ─── SID-Based Event Finder ─────────────────────────────────

export interface FindResult {
  event: Record<string, unknown>;
  parentArray: Record<string, unknown>[];
  index: number;
}

/**
 * Find an event by SID anywhere in the event tree.
 * Iterative stack-based traversal (no recursion) with safety guards.
 * Returns the event, its parent array, and index for safe splice operations.
 */
export function findEventBySid(
  events: Record<string, unknown>[],
  targetSid: number,
): FindResult | null {
  const stack: Array<{ events: Record<string, unknown>[]; depth: number }> = [
    { events, depth: 0 },
  ];
  let nodeCount = 0;

  while (stack.length > 0) {
    if (++nodeCount > MAX_SEARCH_NODES) {
      throw new Error(`SID search exceeded ${MAX_SEARCH_NODES} nodes`);
    }
    const { events: currentEvents, depth } = stack.pop()!;
    if (depth > MAX_SEARCH_DEPTH) continue;

    for (let i = 0; i < currentEvents.length; i++) {
      const event = currentEvents[i];
      if (event.sid === targetSid) {
        return { event, parentArray: currentEvents, index: i };
      }
      // Recurse into children (groups, blocks, function-blocks)
      if (Array.isArray(event.children)) {
        stack.push({
          events: event.children as Record<string, unknown>[],
          depth: depth + 1,
        });
      }
    }
  }
  return null;
}

/**
 * Count all descendant events inside an event (groups, blocks with children).
 * Iterative to match safety pattern.
 */
export function countDescendants(event: Record<string, unknown>): number {
  let count = 0;
  const stack: Array<Record<string, unknown>[]> = [];
  if (Array.isArray(event.children)) {
    stack.push(event.children as Record<string, unknown>[]);
  }

  while (stack.length > 0) {
    const children = stack.pop()!;
    for (const child of children) {
      count++;
      if (Array.isArray(child.children)) {
        stack.push(child.children as Record<string, unknown>[]);
      }
    }
  }
  return count;
}

/**
 * Build a navigable summary of top-level events in a sheet (for error messages).
 * Truncated to maxItems to keep error messages manageable.
 */
export function summarizeEvents(
  events: Record<string, unknown>[],
  maxItems = 10,
): string {
  const lines: string[] = [];
  const total = events.length;

  for (let i = 0; i < Math.min(total, maxItems); i++) {
    const e = events[i];
    const type = e.eventType as string;
    switch (type) {
      case 'block': {
        const sid = e.sid as number;
        const conds = (e.conditions as unknown[] | undefined)?.length ?? 0;
        const acts = (e.actions as unknown[] | undefined)?.length ?? 0;
        lines.push(`  - block (SID ${sid}): ${conds} condition(s), ${acts} action(s)`);
        break;
      }
      case 'group': {
        const title = e.title as string;
        const sid = e.sid as number;
        const childCount = Array.isArray(e.children) ? (e.children as unknown[]).length : 0;
        lines.push(`  - group "${title}" (SID ${sid}): ${childCount} children`);
        break;
      }
      case 'function-block': {
        const name = e.functionName as string;
        const sid = e.sid as number;
        lines.push(`  - function "${name}" (SID ${sid})`);
        break;
      }
      case 'variable': {
        const name = e.name as string;
        const sid = e.sid as number;
        lines.push(`  - variable "${name}" (SID ${sid})`);
        break;
      }
      case 'include':
        lines.push(`  - include: "${e.includeSheet as string}"`);
        break;
      case 'comment':
        lines.push(`  - comment: "${(e.text as string).slice(0, 50)}"`);
        break;
      default:
        lines.push(`  - ${type}`);
    }
  }

  if (total > maxItems) {
    lines.push(`  ... (${total - maxItems} more)`);
  }

  return lines.join('\n');
}

// ─── Group Path Traversal ───────────────────────────────────

/** Traverse event tree to find a group by title path (e.g., "Movement > Collision").
 *  Two-pass: verify the full path resolves before mutating any data. */
export function findGroupByPath(
  events: Record<string, unknown>[],
  groupPath: string,
): Record<string, unknown>[] | null {
  const segments = groupPath.split('>').map(s => s.trim());

  // First pass: verify all segments resolve without mutating
  let current = events;
  const groups: Array<Record<string, unknown>> = [];
  for (const seg of segments) {
    const group = current.find(
      (e) => e.eventType === 'group' && e.title === seg,
    ) as Record<string, unknown> | undefined;
    if (!group) return null;
    groups.push(group);
    current = Array.isArray(group.children) ? group.children as Record<string, unknown>[] : [];
  }

  // Full path resolved — ensure all groups have children arrays
  for (const g of groups) {
    if (!Array.isArray(g.children)) g.children = [];
  }

  return groups[groups.length - 1].children as Record<string, unknown>[];
}

// ─── Behavior Key Resolution ────────────────────────────────

/** An objectClass reference (plus optional behavior) collected from tool input. */
export interface ObjectRef {
  objectClass: string;
  behaviorType?: string;
  /** True when the input used the deprecated "behavior-type" alias */
  usedLegacyKey?: boolean;
}

/**
 * Resolve the behavior of a condition/action input. "behaviorType" is the
 * canonical key; the deprecated "behavior-type" alias is normalized to it.
 * Throws when both keys are given with different values.
 */
export function resolveBehaviorType(
  ace: Readonly<Record<string, unknown>>,
): { behaviorType?: string; usedLegacyKey: boolean } {
  // Empty values mean "no behavior" for either key (nothing is written for them).
  const current = isBehaviorName(ace[BEHAVIOR_TYPE_KEY]) ? ace[BEHAVIOR_TYPE_KEY] : undefined;
  const legacy = isBehaviorName(ace[LEGACY_BEHAVIOR_TYPE_KEY]) ? ace[LEGACY_BEHAVIOR_TYPE_KEY] : undefined;
  if (current !== undefined && legacy !== undefined && current !== legacy) {
    const label = typeof ace.id === 'string' ? `"${ace.id}" on "${String(ace.objectClass)}"` : `"${String(ace.objectClass)}"`;
    throw new Error(
      `Conflicting behavior keys for ${label}: behaviorType "${current}" vs deprecated ` +
      `"behavior-type" "${legacy}". Pass only behaviorType.`,
    );
  }
  return {
    behaviorType: current ?? legacy,
    usedLegacyKey: legacy !== undefined,
  };
}

/** Build an ObjectRef from a condition/action input. */
function toObjectRef(ace: Readonly<Record<string, unknown>> & { objectClass: string }): ObjectRef {
  const { behaviorType, usedLegacyKey } = resolveBehaviorType(ace);
  const ref: ObjectRef = { objectClass: ace.objectClass };
  if (behaviorType) ref.behaviorType = behaviorType;
  if (usedLegacyKey) ref.usedLegacyKey = true;
  return ref;
}

// ─── Object Class Validation ────────────────────────────────

/** Validate objectClass references against project objects, families, and "System".
 *  Unknown objectClass → error. Behavior problems → warnings only (never block a write). */
export async function validateObjectClasses(
  reader: Construct3ProjectReader,
  refs: ObjectRef[],
): Promise<{ errors: string[]; warnings: string[] }> {
  const objects = await reader.listObjectTypes();
  // listFamilies() reads from an in-memory Map and never throws — no try/catch needed.
  const families = await reader.listFamilies();
  const validClasses = new Set([...objects, ...families, 'System']);

  const errors: string[] = [];
  const warnings: string[] = [];

  for (const ref of refs) {
    if (!validClasses.has(ref.objectClass)) {
      const suggestions = reader.findNearestName(ref.objectClass, 'objects');
      const hint = suggestions.length > 0
        ? ` Did you mean: ${suggestions.join(', ')}?`
        : '';
      errors.push(`Unknown objectClass "${ref.objectClass}".${hint}`);
    }
  }

  // Soft-validate behaviors: warn when behaviorType names no behavior on the
  // object type or any family it belongs to (family behaviors are usable on
  // member objects in C3 events).
  const behaviorRefs = refs.filter(r => r.behaviorType && validClasses.has(r.objectClass));
  if (behaviorRefs.length > 0) {
    const lookup = await loadBehaviorLookup(reader, behaviorRefs.map(r => r.objectClass));
    const checked = new Set<string>();
    for (const ref of behaviorRefs) {
      const key = `${ref.objectClass}\u0000${ref.behaviorType}`;
      if (checked.has(key)) continue;
      checked.add(key);
      const check = checkBehaviorName(ref.objectClass, ref.behaviorType!, lookup);
      if (check.status !== 'ok') warnings.push(check.message);
    }
  }

  if (refs.some(r => r.usedLegacyKey)) {
    warnings.push('Input used the deprecated "behavior-type" key; it was written as "behaviorType" (the key Construct 3 reads). Use "behaviorType" in future calls.');
  }

  return { errors, warnings };
}

/**
 * Load what checkBehaviorName needs: object type/family names, all readable
 * families, and the object types named in `objectClasses` (unreadable ones
 * are left out and reported as "could not be verified").
 */
export async function loadBehaviorLookup(
  reader: Construct3ProjectReader,
  objectClasses: Iterable<string>,
): Promise<BehaviorLookupData> {
  const objectNames = new Set(await reader.listObjectTypes());
  const familyNames = new Set(await reader.listFamilies());
  let families: Map<string, Record<string, unknown>>;
  try {
    families = await reader.readAllFamilies();
  } catch {
    families = new Map();
  }
  const objectTypes = new Map<string, unknown>();
  for (const name of new Set(objectClasses)) {
    if (!objectNames.has(name)) continue;
    try {
      objectTypes.set(name, await reader.readObjectType(name));
    } catch {
      // Unreadable object type: checkBehaviorName reports it as unverified
    }
  }
  return { objectNames, familyNames, objectTypes, families };
}

// ─── Legacy Key Normalization ───────────────────────────────

/**
 * Normalize the legacy "behavior-type" key on existing conditions/actions
 * that a tool edits and writes back (issue #16), with the same rules as
 * fix_legacy_behavior_keys: a name that resolves to a behavior on the object
 * (or cannot be checked) is renamed to "behaviorType" in place; unresolved
 * names and conflicting values are left alone. Returns one warning per
 * affected condition/action, so the change is never silent.
 */
export async function normalizeLegacyBehaviorKeys(
  reader: Construct3ProjectReader,
  aces: Array<{ ace: Record<string, unknown>; kind: 'condition' | 'action' }>,
): Promise<string[]> {
  const legacy = aces.filter(a => typeof a.ace === 'object' && a.ace !== null && LEGACY_BEHAVIOR_TYPE_KEY in a.ace);
  if (legacy.length === 0) return [];

  const lookup = await loadBehaviorLookup(
    reader,
    legacy.map(a => a.ace.objectClass).filter((c): c is string => typeof c === 'string'),
  );
  const resolve = (objectClass: string, behaviorName: string) => checkBehaviorName(objectClass, behaviorName, lookup);

  const warnings: string[] = [];
  for (const kind of ['condition', 'action'] as const) {
    const list = legacy.filter(a => a.kind === kind).map(a => a.ace);
    if (list.length === 0) continue;
    const scan = scanLegacyBehaviorKeysInAces(list, kind, { apply: true, resolve });
    for (const hit of scan.fixable) {
      const what = hit.behaviorType !== undefined
        ? `Dropped the leftover "behavior-type" key (same value as "behaviorType") on ${describeLegacyHit(hit)}.`
        : `Renamed the legacy "behavior-type" key to "behaviorType" on ${describeLegacyHit(hit)} — Construct 3 only reads "behaviorType".`;
      warnings.push(hit.warning ? `${what} ${hit.warning}` : what);
    }
    for (const hit of [...scan.unresolved, ...scan.conflicts]) {
      warnings.push(
        `${describeLegacyHit(hit)} still carries the legacy "behavior-type" key and was left as is: ${hit.reason}. ` +
        'Set "behaviorType" to the behavior\'s name by hand and remove "behavior-type".',
      );
    }
  }
  warnings.push('Other conditions/actions in this project may carry the legacy "behavior-type" key too — run fix_legacy_behavior_keys to find them.');
  return warnings;
}

// ─── Object Reference Collection ────────────────────────────

/** Collect all objectClass references from a block and all its descendants.
 *  Depth-limited to match buildBlockEvent's MAX_NESTING_DEPTH guard.
 *  Throws on conflicting behaviorType / "behavior-type" values. */
export function collectObjectRefs(
  conditions: Array<Readonly<Record<string, unknown>> & { objectClass: string }>,
  actions: Array<Record<string, unknown>>,
  children: ChildEventInput[],
  refs: ObjectRef[],
  depth = 0,
): void {
  if (depth > MAX_NESTING_DEPTH) {
    throw new Error(`collectObjectRefs nesting exceeds maximum depth of ${MAX_NESTING_DEPTH}`);
  }
  for (const c of conditions) {
    refs.push(toObjectRef(c));
  }
  for (const a of actions) {
    if ('objectClass' in a && typeof a.objectClass === 'string') {
      refs.push(toObjectRef(a as Record<string, unknown> & { objectClass: string }));
    }
  }
  for (const child of children) {
    collectObjectRefs(
      child.conditions ?? [],
      (child.actions ?? []) as Array<Record<string, unknown>>,
      child.children ?? [],
      refs,
      depth + 1,
    );
  }
}

// ─── Condition / Action Builders ────────────────────────────

/** Build a condition. The keys C3 defines follow its on-disk order:
 *  id, objectClass, sid, behaviorType, parameters, isInverted.
 *  `isOr` is this server's own flag, not a C3 key (real sheets mark OR
 *  blocks with `isOrBlock` on the block); its encoding is tracked separately. */
export function buildCondition(c: z.infer<typeof conditionSchema>, sid: number): Condition {
  const cond: Condition = {
    id: c.id,
    objectClass: c.objectClass,
    sid,
  };
  const { behaviorType } = resolveBehaviorType(c);
  if (behaviorType) cond.behaviorType = behaviorType;
  if (c.parameters) cond.parameters = c.parameters;
  if (c.isInverted) cond.isInverted = true;
  if (c.isOr) cond.isOr = true;
  return cond;
}

/** Build a standard (non-script) action in C3's on-disk shape. */
export function buildStandardAction(a: z.infer<typeof standardActionSchema>, sid: number): StandardAction {
  const act: StandardAction = {
    id: a.id,
    objectClass: a.objectClass,
    sid,
  };
  const { behaviorType } = resolveBehaviorType(a);
  if (behaviorType) act.behaviorType = behaviorType;
  if (a.parameters) act.parameters = a.parameters;
  if (a.callFunction) act.callFunction = a.callFunction;
  if (a.disabled) act.disabled = true;
  return act;
}

// ─── Recursive Block Builder ────────────────────────────────

/** Recursively build a block event with conditions, actions, and children.
 *  Returns the built block and increments the counter (for safety limit). */
export async function buildBlockEvent(
  reader: Construct3ProjectReader,
  idGen: IdGenerator,
  block: {
    conditions: Array<z.infer<typeof conditionSchema>>;
    actions: Array<z.infer<typeof standardActionSchema> | z.infer<typeof scriptActionSchema>>;
    disabled?: boolean;
    isElse?: boolean;
    children: ChildEventInput[];
  },
  depth: number,
  counter: { count: number; warnings: string[] },
): Promise<BlockEvent> {
  if (depth > MAX_NESTING_DEPTH) {
    throw new Error(`Sub-event nesting exceeds maximum depth of ${MAX_NESTING_DEPTH}`);
  }
  counter.count++;
  if (counter.count > MAX_TOTAL_EVENTS) {
    throw new Error(`Total event count exceeds maximum of ${MAX_TOTAL_EVENTS}`);
  }

  // Validate: non-else blocks must have at least one condition
  if (!block.isElse && block.conditions.length === 0) {
    throw new Error(`Non-else event block at depth ${depth} has no conditions. Add conditions or set isElse: true.`);
  }

  // Cap conditions and actions per block to prevent SID amplification
  if (block.conditions.length > MAX_ITEMS_PER_BLOCK) {
    throw new Error(`Block has ${block.conditions.length} conditions (max ${MAX_ITEMS_PER_BLOCK})`);
  }
  if (block.actions.length > MAX_ITEMS_PER_BLOCK) {
    throw new Error(`Block has ${block.actions.length} actions (max ${MAX_ITEMS_PER_BLOCK})`);
  }

  // Warn: isElse blocks with conditions (C3 ignores them)
  if (block.isElse && block.conditions.length > 0) {
    counter.warnings.push(`Else block at depth ${depth} has ${block.conditions.length} condition(s) — C3 ignores conditions on else blocks.`);
  }

  // Warn: isOr on the first condition is meaningless
  if (block.conditions.length > 0 && block.conditions[0].isOr) {
    counter.warnings.push(`First condition at depth ${depth} has isOr: true — this is ignored by C3 (no previous condition to OR with).`);
  }

  const blockSid = await idGen.generateSid(reader);

  // Build conditions with SIDs
  const builtConditions: Condition[] = [];
  for (const c of block.conditions) {
    const condSid = await idGen.generateSid(reader);
    builtConditions.push(buildCondition(c, condSid));
  }

  // Build actions with SIDs (or as script actions)
  const builtActions: Action[] = [];
  for (const a of block.actions) {
    if ('type' in a && a.type === 'script') {
      const scriptAct: Action = {
        type: 'script' as const,
        script: a.script,
      };
      if (a.disabled) scriptAct.disabled = true;
      builtActions.push(scriptAct);
    } else if ('id' in a) {
      const actSid = await idGen.generateSid(reader);
      builtActions.push(buildStandardAction(a, actSid));
    }
  }

  // Recursively build children
  const builtChildren: BlockEvent[] = [];
  for (const child of block.children) {
    const childBlock = await buildBlockEvent(
      reader,
      idGen,
      {
        conditions: child.conditions ?? [],
        actions: child.actions ?? [],
        disabled: child.disabled,
        isElse: child.isElse,
        children: child.children ?? [],
      },
      depth + 1,
      counter,
    );
    builtChildren.push(childBlock);
  }

  return createBlockEvent(
    blockSid,
    builtConditions,
    builtActions,
    block.disabled || undefined,
    builtChildren.length > 0 ? builtChildren : undefined,
    block.isElse || undefined,
  );
}
