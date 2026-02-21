/**
 * Event-related helpers extracted from mutations.ts.
 * Contains Zod schemas, recursive builders, and validators
 * used by event tools (add_event_block, add_event_to_sheet).
 */

import { z } from 'zod';
import type { Construct3ProjectReader } from '../construct3/project-reader.js';
import type { IdGenerator } from '../construct3/id-generator.js';
import type { Condition, Action, BlockEvent } from '../construct3/types.js';
import { createBlockEvent } from '../construct3/templates.js';

// ─── Zod Schemas ────────────────────────────────────────────

/** Condition schema shared by top-level and child events */
export const conditionSchema = z.object({
  id: z.string().describe('Condition ACE id (kebab-case, e.g., "on-start-of-layout", "on-collision-with-another-object")'),
  objectClass: z.string().describe('Object name or "System"'),
  'behavior-type': z.string().optional().describe('Behavior type (e.g., "Platform", "8Direction")'),
  parameters: z.record(z.unknown())
    .refine(obj => JSON.stringify(obj).length <= 50_000, 'Parameters payload too large (max 50KB)')
    .optional().describe('Condition parameters as key-value pairs'),
  isInverted: z.boolean().optional().describe('Negate the condition'),
  isOr: z.boolean().optional().describe('OR-combine with previous condition (default: AND)'),
});

/** Standard action schema */
export const standardActionSchema = z.object({
  id: z.string().describe('Action ACE id (kebab-case, e.g., "set-instvar-value", "destroy")'),
  objectClass: z.string().describe('Object name or "System"'),
  'behavior-type': z.string().optional().describe('Behavior type'),
  parameters: z.record(z.unknown())
    .refine(obj => JSON.stringify(obj).length <= 50_000, 'Parameters payload too large (max 50KB)')
    .optional().describe('Action parameters as key-value pairs'),
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

// ─── Object Class Validation ────────────────────────────────

/** Validate objectClass references against project objects, families, and "System". */
export async function validateObjectClasses(
  reader: Construct3ProjectReader,
  refs: Array<{ objectClass: string; 'behavior-type'?: string }>,
): Promise<{ errors: string[]; warnings: string[] }> {
  const objects = await reader.listObjectTypes();
  let families: string[] = [];
  try {
    families = await reader.listFamilies();
  } catch {
    // families may not exist in all projects
  }
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
    if (ref['behavior-type']) {
      // Soft validate: warn but allow (behavior may come from families or third-party plugins)
      warnings.push(`Behavior-type "${ref['behavior-type']}" on "${ref.objectClass}" was not validated — ensure it exists on the object or its families.`);
    }
  }

  return { errors, warnings };
}

// ─── Object Reference Collection ────────────────────────────

/** Collect all objectClass references from a block and all its descendants.
 *  Depth-limited to match buildBlockEvent's MAX_NESTING_DEPTH guard. */
export function collectObjectRefs(
  conditions: Array<{ objectClass: string; 'behavior-type'?: string }>,
  actions: Array<Record<string, unknown>>,
  children: ChildEventInput[],
  refs: Array<{ objectClass: string; 'behavior-type'?: string }>,
  depth = 0,
): void {
  if (depth > MAX_NESTING_DEPTH) {
    throw new Error(`collectObjectRefs nesting exceeds maximum depth of ${MAX_NESTING_DEPTH}`);
  }
  for (const c of conditions) {
    refs.push({ objectClass: c.objectClass, 'behavior-type': c['behavior-type'] });
  }
  for (const a of actions) {
    if ('objectClass' in a && typeof a.objectClass === 'string') {
      refs.push({ objectClass: a.objectClass, 'behavior-type': a['behavior-type'] as string | undefined });
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
    const cond: Condition = {
      id: c.id,
      objectClass: c.objectClass,
      sid: condSid,
    };
    if (c['behavior-type']) cond['behavior-type'] = c['behavior-type'];
    if (c.parameters) cond.parameters = c.parameters;
    if (c.isInverted) cond.isInverted = true;
    if (c.isOr) cond.isOr = true;
    builtConditions.push(cond);
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
      const act: Action = {
        id: a.id,
        objectClass: a.objectClass,
        sid: actSid,
      };
      if (a['behavior-type']) act['behavior-type'] = a['behavior-type'];
      if (a.parameters) act.parameters = a.parameters;
      if (a.callFunction) act.callFunction = a.callFunction;
      if (a.disabled) act.disabled = true;
      builtActions.push(act);
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
