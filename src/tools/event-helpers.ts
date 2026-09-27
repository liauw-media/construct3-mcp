/**
 * Event-related helpers extracted from mutations.ts.
 * Contains Zod schemas, recursive builders, and validators
 * used by event tools (add_event_block, add_event_to_sheet).
 */

import { z } from 'zod';
import type { Construct3ProjectReader } from '../construct3/project-reader.js';
import type { IdGenerator } from '../construct3/id-generator.js';
import type { Condition, Action, BlockEvent, StandardAction, C3Event } from '../construct3/types.js';
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
import { buildEventOutline, summarizeNode, type OutlineNode } from '../construct3/analyzers/event-outline.js';
import {
  checkEventLoadRules,
  collectTriggerObjectClasses,
  createAceOriginResolver,
  formatLoadRuleIssue,
  loadRuleErrorMessage,
  newLoadRuleIssues,
  systemOnlyAceOrigin,
  type AceOriginResolver,
} from '../construct3/analyzers/load-rules.js';

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
  isOr: z.boolean().optional().describe('Legacy flag, written as given. It does NOT make a Construct 3 OR: C3 ORs a whole event (an OR block), which these tools cannot create, and conditions stay AND-combined. Do not use it to combine triggers: put each trigger in its own event.'),
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

/** An event found by SID, with its place in the sheet. */
export interface SidMatch extends FindResult {
  /** JSON path from the sheet root, in the format locate_event returns, e.g. events[3].children[1] */
  path: string;
  /** Nesting depth (0 = top level) */
  depth: number;
}

/**
 * Visit every event of the tree in document order (depth-first, each event's
 * children right after it — the editor's display order) with its path.
 * Iterative stack-based traversal (no recursion) with safety guards.
 */
function walkEvents(
  events: Record<string, unknown>[],
  visit: (node: SidMatch) => void,
): void {
  const stack: Array<{ parentArray: Record<string, unknown>[]; index: number; path: string; depth: number }> = [];
  const pushChildren = (list: Record<string, unknown>[], parentPath: string, depth: number) => {
    for (let i = list.length - 1; i >= 0; i--) {
      const path = parentPath ? `${parentPath}.children[${i}]` : `events[${i}]`;
      stack.push({ parentArray: list, index: i, path, depth });
    }
  };
  pushChildren(events, '', 0);
  let nodeCount = 0;

  while (stack.length > 0) {
    if (++nodeCount > MAX_SEARCH_NODES) {
      throw new Error(`SID search exceeded ${MAX_SEARCH_NODES} nodes`);
    }
    const { parentArray, index, path, depth } = stack.pop()!;
    const event = parentArray[index];
    if (typeof event !== 'object' || event === null) continue;
    visit({ event, parentArray, index, path, depth });
    // Recurse into children (groups, blocks, function-blocks)
    if (Array.isArray(event.children) && depth < MAX_SEARCH_DEPTH) {
      pushChildren(event.children as Record<string, unknown>[], path, depth + 1);
    }
  }
}

/**
 * Find every event with the given SID anywhere in the event tree, in document
 * order. Event SIDs are not guaranteed to be unique: editor-saved sheets can
 * hold two events with the same SID, so callers that act on one event must use
 * resolveEventBySid, which refuses an ambiguous SID.
 * Each match carries its parent array and index for safe splice operations.
 */
export function findEventsBySid(
  events: Record<string, unknown>[],
  targetSid: number,
): SidMatch[] {
  const matches: SidMatch[] = [];
  walkEvents(events, node => {
    if (node.event.sid === targetSid) matches.push(node);
  });
  return matches;
}

/** The SIDs of the given events and all their sub-events. */
export function collectEventSids(events: Record<string, unknown>[]): Set<number> {
  const sids = new Set<number>();
  walkEvents(events, ({ event }) => {
    if (typeof event.sid === 'number') sids.add(event.sid);
  });
  return sids;
}

/**
 * The SIDs from `sids` that more than one event of the sheet has, each with
 * the paths of those events in document order. The SID-based tools refuse
 * these SIDs in this sheet unless an eventPath picks one.
 */
export function eventSidsMatchingSeveral(
  events: Record<string, unknown>[],
  sids: ReadonlySet<number>,
): Map<number, string[]> {
  const paths = new Map<number, string[]>();
  walkEvents(events, ({ event, path }) => {
    if (typeof event.sid !== 'number' || !sids.has(event.sid)) return;
    const list = paths.get(event.sid);
    if (list) list.push(path);
    else paths.set(event.sid, [path]);
  });
  for (const [sid, list] of paths) {
    if (list.length < 2) paths.delete(sid);
  }
  return paths;
}

/**
 * Parse an event path such as "events[3].children[1]" (the format locate_event
 * returns) into its indices, e.g. [3, 1]. Returns null for anything else,
 * including paths to a condition or action.
 */
export function parseEventPath(path: string): number[] | null {
  const match = /^events\[(\d{1,9})\]((?:\.children\[\d{1,9}\])*)$/.exec(path.replace(/\s+/g, ''));
  if (!match) return null;
  const indices = [Number(match[1])];
  for (const child of match[2].matchAll(/\[(\d+)\]/g)) indices.push(Number(child[1]));
  return indices;
}

/** Format indices from parseEventPath back into an event path. */
function formatEventPath(indices: number[]): string {
  return indices.map((n, i) => (i === 0 ? `events[${n}]` : `.children[${n}]`)).join('');
}

/** The event at a parsed event path, or undefined when the path leads nowhere. */
function eventAtPath(events: Record<string, unknown>[], indices: number[]): Record<string, unknown> | undefined {
  let list: unknown = events;
  let event: unknown;
  for (const index of indices) {
    if (!Array.isArray(list)) return undefined;
    event = list[index];
    if (typeof event !== 'object' || event === null) return undefined;
    list = (event as Record<string, unknown>).children;
  }
  return event as Record<string, unknown>;
}

/** Candidates listed in an ambiguous-SID error; the rest are counted. */
const MAX_LISTED_SID_MATCHES = 20;

/** "events[3].children[1]" → "events[3]"; null for a top-level path. */
function parentPathOf(path: string): string | null {
  const cut = path.lastIndexOf('.children[');
  return cut === -1 ? null : path.slice(0, cut);
}

/**
 * One line per match for an ambiguous-SID error: its path, editor event
 * number, enclosing group/function or parent event, and a one-line summary.
 */
function describeSidMatches(
  sheetName: string,
  events: Record<string, unknown>[],
  matches: SidMatch[],
): string[] {
  // The outline supplies event numbers, enclosing groups/functions and summaries
  const nodes = new Map<string, OutlineNode>();
  try {
    for (const node of buildEventOutline(sheetName, events).nodes) nodes.set(node.path, node);
  } catch {
    // Without an outline each match is described by its type and counts only
  }

  const lines = matches.slice(0, MAX_LISTED_SID_MATCHES).map(m => {
    const node = nodes.get(m.path);
    const eventType = String(m.event.eventType);
    if (!node) {
      const conds = Array.isArray(m.event.conditions) ? m.event.conditions.length : 0;
      const acts = Array.isArray(m.event.actions) ? m.event.actions.length : 0;
      const disabled = m.event.disabled === true ? ', disabled' : '';
      return `  - eventPath "${m.path}": ${eventType}, ${conds} condition(s), ${acts} action(s)${disabled}`;
    }

    const where: string[] = [];
    if (node.enclosingGroups.length > 0) {
      where.push(`in group ${node.enclosingGroups.map(g => `"${g}"`).join(' > ')}`);
    }
    if (node.enclosingFunction !== undefined) {
      // The nearest function-like ancestor says whether it is a function or a custom action
      let ancestor = parentPathOf(m.path);
      let kind: string | undefined;
      while (ancestor !== null && kind === undefined) {
        const k = nodes.get(ancestor)?.kind;
        if (k === 'function' || k === 'custom-ace') kind = k;
        ancestor = parentPathOf(ancestor);
      }
      where.push(kind === 'custom-ace'
        ? `in custom action ${node.enclosingFunction}`
        : `in function "${node.enclosingFunction}"`);
    }
    const parentPath = parentPathOf(m.path);
    const parent = parentPath === null ? undefined : nodes.get(parentPath);
    if (parent && parent.kind !== 'group' && parent.kind !== 'function' && parent.kind !== 'custom-ace') {
      where.push(parent.number !== null ? `sub-event of event ${parent.number}` : `inside ${parent.eventType} ${parent.path}`);
    }
    if (where.length === 0) where.push('top level');

    const number = node.number !== null ? `event ${node.number}` : `${eventType} (no event number)`;
    return `  - eventPath "${m.path}": ${number}, ${where.join(', ')}: ${summarizeNode(node)}`;
  });
  if (matches.length > lines.length) {
    lines.push(`  ... and ${matches.length - lines.length} more`);
  }
  return lines;
}

/** The error for a SID that matches no event in the sheet, with a summary of its top-level events. */
function sidNotFoundMessage(events: Record<string, unknown>[], sid: number, sheetName: string): string {
  return (
    `Event with SID ${sid} not found in sheet "${sheetName}".\n\n` +
    `Sheet "${sheetName}" contains ${events.length} top-level events:\n${summarizeEvents(events)}\n\n` +
    `Use get_eventsheet_details to see the full event tree with SIDs.`
  );
}

/** The error for a SID shared by several events: lists them and says how to pick one. */
export function ambiguousSidMessage(
  sheetName: string,
  events: Record<string, unknown>[],
  sid: number,
  matches: SidMatch[],
  options: { action: string; argument: string; scope?: string },
): string {
  const scope = options.scope ? `${options.scope} ` : '';
  return (
    `SID ${sid} matches ${matches.length} ${scope}events in sheet "${sheetName}"; refusing to guess which one to ${options.action}.\n` +
    `${describeSidMatches(sheetName, events, matches).join('\n')}\n` +
    `Call again with ${options.argument} set to the path of the event you mean (locate_event gives the path for an editor event number). ` +
    'Editor-saved sheets can contain duplicate event SIDs; giving all but one of these events a new unique SID removes the ambiguity.'
  );
}

/**
 * Resolve the one event a SID-addressed tool acts on. A SID that matches no
 * event, or several events without an eventPath to pick one, is an error, as
 * is an eventPath that does not point at an event with this SID. Nothing is
 * changed, so tools can return the error before any write.
 */
export function resolveEventBySid(
  events: Record<string, unknown>[],
  sid: number,
  options: { sheetName: string; action: string; eventPath?: string },
): { match: SidMatch } | { error: string } {
  const { sheetName, eventPath } = options;
  let wanted: string | undefined;
  if (eventPath !== undefined) {
    const indices = parseEventPath(eventPath);
    if (!indices) {
      return { error: `eventPath "${eventPath}" is not an event path. Use the form events[3] or events[3].children[1], as locate_event and SID errors list it.` };
    }
    wanted = formatEventPath(indices);
  }

  const matches = findEventsBySid(events, sid);
  if (matches.length === 0) return { error: sidNotFoundMessage(events, sid, sheetName) };

  if (wanted !== undefined) {
    const match = matches.find(m => m.path === wanted);
    if (match) return { match };
    const other = eventAtPath(events, parseEventPath(wanted)!);
    const target = other
      ? `it points at a ${String(other.eventType)}${typeof other.sid === 'number' ? ` with SID ${other.sid}` : ' without a SID'}`
      : 'no event exists at that path';
    return {
      error:
        `eventPath "${eventPath}" does not point at an event with SID ${sid} in sheet "${sheetName}" (${target}). ` +
        `${matches.length === 1 ? 'The event with this SID is' : `The ${matches.length} events with this SID are`}:\n` +
        describeSidMatches(sheetName, events, matches).join('\n'),
    };
  }

  if (matches.length > 1) {
    return { error: ambiguousSidMessage(sheetName, events, sid, matches, { action: options.action, argument: 'eventPath' }) };
  }
  return { match: matches[0] };
}

/** Schema of the eventPath argument that picks one of several events sharing a SID. */
export const eventPathSchema = z.string().max(500).optional().describe(
  'Only needed when the SID matches more than one event in the sheet (the call is then refused with a list of candidates): ' +
  'the JSON path of the event you mean, e.g. "events[3].children[1]", as listed in that error or returned by locate_event. ' +
  'It must point at an event with this SID.',
);

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

// ─── Editor Load-Time Rules (pre-write gate) ────────────────

/** Deep copy of a sheet's events, taken before a mutation for checkLoadRulesBeforeWrite. */
export function snapshotEvents(events: C3Event[]): C3Event[] {
  return JSON.parse(JSON.stringify(events)) as C3Event[];
}

/** Build an ACE origin resolver, reading only the object types that trigger-like conditions use. */
async function loadAceOriginResolver(
  reader: Construct3ProjectReader,
  eventLists: C3Event[][],
): Promise<AceOriginResolver> {
  const names = new Set<string>();
  for (const events of eventLists) {
    for (const name of collectTriggerObjectClasses(events)) names.add(name);
  }

  const objects = new Map<string, Record<string, unknown>>();
  let families = new Map<string, Record<string, unknown>>();
  if (names.size > 0) {
    const objectNames = new Set(await reader.listObjectTypes());
    for (const name of names) {
      if (!objectNames.has(name)) continue;
      try {
        objects.set(name, await reader.readObjectType(name) as Record<string, unknown>);
      } catch {
        // Unreadable object: its ACEs resolve as 'unknown' (warnings only)
      }
    }
    try {
      families = await reader.readAllFamilies();
    } catch {
      // No families available: family behaviors resolve as 'unknown'
    }
  }

  return createAceOriginResolver({ objects, families, usedAddons: reader.getUsedAddons() });
}

/**
 * Check the editor load-time rules (expression syntax, empty expressions,
 * trigger placement) for a pending event sheet write. Only issues the write
 * introduces are reported, so edits to a sheet with pre-existing problems
 * still go through. Errors must block the write; warnings go in the result.
 */
export async function checkLoadRulesBeforeWrite(
  reader: Construct3ProjectReader,
  sheetName: string,
  beforeEvents: C3Event[],
  afterEvents: C3Event[],
): Promise<{ errors: string[]; warnings: string[] }> {
  const sheet = `eventSheets/${sheetName}`;

  // Which issues exist does not depend on ACE origin, only their severity does,
  // so a sheet that is clean after the write needs no object type reads.
  if (checkEventLoadRules(afterEvents, { sheet, aceOrigin: systemOnlyAceOrigin }).length === 0) {
    return { errors: [], warnings: [] };
  }

  // Otherwise compare with real origins: an edit can raise the severity of an
  // issue that already existed (e.g. a nested trigger gets a built-in root).
  const aceOrigin = await loadAceOriginResolver(reader, [beforeEvents, afterEvents]);
  const issues = newLoadRuleIssues(
    checkEventLoadRules(beforeEvents, { sheet, aceOrigin }),
    checkEventLoadRules(afterEvents, { sheet, aceOrigin }),
  );
  return {
    errors: issues.filter(i => i.severity === 'error').map(formatLoadRuleIssue),
    warnings: issues.filter(i => i.severity === 'warning').map(formatLoadRuleIssue),
  };
}

/**
 * An issue key that no longer names its sheet, so issues can be matched across
 * sheets. Events without a SID are keyed by location (checkEventLoadRules); for
 * them the leading groups are dropped as well, since a moved event may land in
 * a group. Groups are transparent to the rules, so this loses nothing the
 * rules depend on.
 */
function sheetIndependentKey(key: string, sheet: string): string {
  const ruleEnd = key.indexOf('|') + 1;
  let rest = key.slice(ruleEnd);
  if (!rest.startsWith(`${sheet}|`)) return key;
  rest = rest.slice(sheet.length + 1);

  const locationPrefix = `~${sheet}`;
  if (rest.startsWith(`${locationPrefix} > `)) {
    let location = rest.slice(locationPrefix.length);
    while (location.startsWith(' > group "')) {
      const next = location.indexOf(' > ', 3);
      if (next === -1) break;
      location = location.slice(next);
    }
    rest = `~${location}`;
  }
  return `${key.slice(0, ruleEnd)}|${rest}`;
}

/**
 * The load-time gate for a write that changes two sheets at once
 * (move_events_between_sheets). Both sheets are compared together, with keys
 * that ignore the sheet: an event moved from one sheet to the other keeps its
 * issues, so relocating an event that already breaks a rule is allowed, while
 * copying it adds a second instance of the issue and is reported as new.
 * Moved events are top-level events in the source and land at the top level or
 * in a group chain starting at the top level of the target, so their trigger
 * ancestry does not change. Errors must block the write; warnings go in the result.
 */
export async function checkLoadRulesBeforeSheetPairWrite(
  reader: Construct3ProjectReader,
  sheets: Array<{ name: string; before: C3Event[]; after: C3Event[] }>,
): Promise<{ errors: string[]; warnings: string[] }> {
  const label = (name: string) => `eventSheets/${name}`;

  // As in checkLoadRulesBeforeWrite: clean sheets after the write need no origin lookups.
  if (sheets.every(s => checkEventLoadRules(s.after, { sheet: label(s.name), aceOrigin: systemOnlyAceOrigin }).length === 0)) {
    return { errors: [], warnings: [] };
  }

  const aceOrigin = await loadAceOriginResolver(reader, sheets.flatMap(s => [s.before, s.after]));
  const collect = (state: 'before' | 'after') => sheets.flatMap(s => {
    const sheet = label(s.name);
    return checkEventLoadRules(s[state], { sheet, aceOrigin })
      .map(issue => ({ ...issue, key: sheetIndependentKey(issue.key, sheet) }));
  });
  const issues = newLoadRuleIssues(collect('before'), collect('after'));
  return {
    errors: issues.filter(i => i.severity === 'error').map(formatLoadRuleIssue),
    warnings: issues.filter(i => i.severity === 'warning').map(formatLoadRuleIssue),
  };
}

/** Error text for a write blocked by checkLoadRulesBeforeWrite. */
export { loadRuleErrorMessage };

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
