/**
 * Event-related helpers extracted from mutations.ts.
 * Contains Zod schemas, recursive builders, and validators
 * used by event tools (add_event_block, add_event_to_sheet).
 */

import { z } from 'zod';
import type { Construct3ProjectReader } from '../construct3/project-reader.js';
import type { IdGenerator } from '../construct3/id-generator.js';
import type {
  Condition,
  Action,
  BlockEvent,
  StandardAction,
  ScriptAction,
  CommentAction,
  CommentEvent,
  ScriptEvent,
  C3Event,
} from '../construct3/types.js';
import { createBlockEvent, createCommentEvent } from '../construct3/templates.js';
import {
  isElseCondition,
  createElseCondition,
  isFunctionCall,
  collectFunctionSignatures,
  toPositionalArguments,
  checkFunctionCallArguments,
  createFunctionCallAction,
  LEGACY_CALL_KEYS,
  resolveCallName,
  resolveMappedFunctionName,
  mappedFunctionName,
  toScriptLines,
  functionsObjectName,
  DEFAULT_FUNCTIONS_OBJECT_NAME,
  FUNCTIONS_OBJECT_ACTION_IDS,
  type FunctionSignature,
} from '../construct3/event-shapes.js';
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

// Event shapes below follow editor-saved sheets (Construct 3 r449; issue #32):
// Else is a System "else" condition at index 0 (conditions after it make an
// else-if), OR blocks carry the block key "isOrBlock", function calls are
// { callFunction, sid, parameters: [positional] } without id/objectClass,
// script actions are { type: "script", language: "javascript", script: [lines] },
// and comment rows { type: "comment", text } may carry "text-color" and
// "background-color" ([r, g, b, a], each 0-1). Blocks hold block, comment and
// script sub-events; comment and script sub-events have the same keys as
// comment rows and script actions, with eventType instead of type.

/** Descriptions shared by add_event_block, its sub-events and update_event_block. */
export const EVENT_INPUT_DESCRIPTIONS = {
  conditions: 'AND-combined (OR-combined with isOrBlock). [] = an event with no conditions: it runs every tick at the top level, and whenever its parent runs as a sub-event.',
  isElse: 'Make this an else block: a System "else" condition is written as the first condition, the way Construct 3 saves Else. Conditions given here follow it and make an else-if. Place it after the block it is the else of (only comments may stand between them); Else cannot follow a triggered event (to branch inside a trigger, use sub-events of it).',
  isOrBlock: 'Make this an OR block: the event runs when any of its conditions is true (Construct 3 "Make \'Or\' block"). An OR block may hold several triggers.',
} as const;

// ─── Strict Input ───────────────────────────────────────────
//
// Event input objects refuse keys they do not know: a stripped key would drop
// its content without a word (a comment's text, a colour, a mistyped
// "params"). The one exception is "sid", which inputs copied from
// get_eventsheet_details or an editor-saved sheet carry: it is ignored, since
// every written event, condition and action gets a new SID. The arguments of
// add_event_block and update_event_block are strict as well: those tools are
// registered with a strict object schema (registerTool), since a raw shape
// given to server.tool() is wrapped in a stripping object by the MCP SDK.

/** Drop an input object's "sid" (see above); anything else is passed on unchanged. */
function withoutSid(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !Object.hasOwn(value, 'sid')) {
    return value;
  }
  const { sid: _ignored, ...rest } = value as Record<string, unknown>;
  return rest;
}

/** Error map of a strict input object: names the unknown keys and what the object accepts. */
export function unknownKeysErrorMap(what: string, accepted: string): z.ZodErrorMap {
  return (issue, ctx) => {
    if (issue.code === z.ZodIssueCode.unrecognized_keys) {
      const keys = issue.keys.map(k => JSON.stringify(k)).join(', ');
      return { message: `Unknown key(s) ${keys} in ${what}: they would not be written, so the call is refused. ${accepted}` };
    }
    return { message: ctx.defaultError };
  };
}

/** A colour of a comment, as the editor saves it: [r, g, b, a], each 0-1. */
export const commentColorSchema = z.array(z.number().min(0).max(1)).length(4)
  .describe('Colour as Construct 3 saves it: [red, green, blue, alpha], each 0-1');

/** The colour keys of comment events and comment rows, in the editor's key order. */
const COMMENT_COLOR_KEYS = ['text-color', 'background-color'] as const;

export interface CommentColors {
  'text-color'?: number[];
  'background-color'?: number[];
}

/** Condition schema shared by top-level and child events */
const conditionObjectSchema = z.object({
  id: z.string().describe('Condition ACE id (kebab-case, e.g., "on-start-of-layout", "on-collision-with-another-object")'),
  objectClass: z.string().describe('Object name, family name or "System"'),
  behaviorType: z.string().optional().describe(behaviorTypeDescription),
  'behavior-type': z.string().optional().describe(legacyBehaviorTypeDescription),
  parameters: boundedRecord()
    .refine(obj => JSON.stringify(obj).length <= 50_000, 'Parameters payload too large (max 50KB)')
    .optional().describe('Condition parameters as key-value pairs (max 100 keys, depth 6)'),
  isInverted: z.boolean().optional().describe('Negate the condition'),
  disabled: z.boolean().optional().describe('Disable this individual condition'),
  isOr: z.boolean().optional().describe('DEPRECATED: use the block\'s isOrBlock. Never written. If every condition after the first carries isOr, the block is written as an OR block; isOr on only some of them is refused (Construct 3 ORs whole events).'),
}, {
  errorMap: unknownKeysErrorMap('a condition', 'A condition has id, objectClass, behaviorType (or its deprecated alias "behavior-type"), parameters, isInverted, disabled and the deprecated isOr; a "sid" is ignored.'),
}).strict();

/** A condition input; a "sid" key is ignored (see Strict Input). */
export const conditionSchema = z.preprocess(withoutSid, conditionObjectSchema);

/**
 * What a function call accepts, in both input forms. The editor saves calls as
 * { callFunction, sid, disabled?, parameters? }: the keys of the older form
 * (LEGACY_CALL_KEYS: id, objectClass, behaviorType, "behavior-type") name
 * nothing a call needs and are dropped with a warning (buildAction), while a
 * breakpoint is refused, since no editor-saved call on record has one.
 */
const FUNCTION_CALL_KEYS =
  'A function call has callFunction, parameters and disabled; id, objectClass, behaviorType and "behavior-type" of the older call form are dropped with a warning, and a "sid" is ignored. ' +
  'A breakpoint on a function call is not supported (no editor-saved function call on record has one).';

/** Keys a function call is refused with in the older form, where the standard action schema would accept them. */
const REFUSED_CALL_KEYS = ['breakpoint'] as const;

/** Standard action schema (also the older function call form { id, objectClass, callFunction, parameters: {...} }) */
const standardActionObjectSchema = z.object({
  id: z.string().describe('Action ACE id (kebab-case, e.g., "set-instvar-value", "destroy")'),
  objectClass: z.string().describe('Object name, family name, "System", or "Functions" for the built-in Functions object ("set-function-return-value" = Set return value, "map-function", "map-function-default", "call-mapped-function")'),
  behaviorType: z.string().optional().describe(behaviorTypeDescription),
  'behavior-type': z.string().optional().describe(legacyBehaviorTypeDescription),
  parameters: boundedRecord()
    .refine(obj => JSON.stringify(obj).length <= 50_000, 'Parameters payload too large (max 50KB)')
    .optional().describe('Action parameters as key-value pairs (max 100 keys, depth 6)'),
  callFunction: z.string().optional().describe('DEPRECATED function call form; use { callFunction, parameters: [...] } without id/objectClass. Still accepted: written in the editor\'s shape, with parameters keyed "0", "1", … or by the function\'s parameter names turned into a positional array.'),
  disabled: z.boolean().optional().describe('Disable this individual action'),
  breakpoint: z.boolean().optional().describe('Debugger breakpoint on this action, as the editor saves it (written only when true)'),
}, {
  errorMap: unknownKeysErrorMap('an action', 'An action has id, objectClass, behaviorType (or its deprecated alias "behavior-type"), parameters, disabled and breakpoint, and in the older function call form callFunction; a "sid" is ignored. Function calls are { callFunction, parameters: [...] }, script actions { type: "script", script }, comment rows { type: "comment", text }.'),
}).strict();

/**
 * A plugin/behavior/System action, or a function call in the older form. A
 * call in that form refuses the keys no function call is written with
 * (REFUSED_CALL_KEYS), as the editor-shape call schema does.
 */
export const standardActionSchema = standardActionObjectSchema.superRefine((a, ctx) => {
  if (!isFunctionCall(a)) return;
  const refused = REFUSED_CALL_KEYS.filter(k => a[k] !== undefined);
  if (refused.length === 0) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: [refused[0]],
    message: `Key(s) ${refused.map(k => JSON.stringify(k)).join(', ')} in a function call: they would not be written, so the call is refused. ${FUNCTION_CALL_KEYS}`,
  });
});

/** A function call argument: an expression string, or true/false for a boolean parameter. */
export const functionCallArgumentSchema = z.union([z.string().max(10_000), z.number(), z.boolean()]);

const legacyCallKeyDescription = 'Older call form only: not written (the editor saves function calls without it); dropped with a warning';

/** Function call action, in the editor's shape (no id/objectClass); the older form's keys are dropped with a warning */
export const functionCallActionSchema = z.object({
  callFunction: z.string().min(1).max(200).describe('Name of the event function to call'),
  parameters: z.array(functionCallArgumentSchema).max(100).optional()
    .describe('Arguments in the order of the function\'s parameters: expressions as strings (e.g. "1", "\\"text\\"", "Player.X"; numbers are written as strings), true/false for boolean parameters'),
  disabled: z.boolean().optional().describe('Disable this individual action'),
  id: z.string().optional().describe(legacyCallKeyDescription),
  objectClass: z.string().optional().describe(legacyCallKeyDescription),
  behaviorType: z.string().optional().describe(legacyCallKeyDescription),
  'behavior-type': z.string().optional().describe(legacyCallKeyDescription),
}, {
  errorMap: unknownKeysErrorMap('a function call', FUNCTION_CALL_KEYS),
}).strict();

/** Script action schema */
export const scriptActionSchema = z.object({
  type: z.literal('script').describe('Script action type'),
  language: z.literal('javascript').optional().describe('Script language (default and only value: "javascript")'),
  script: z.union([z.string(), z.array(z.string())])
    .describe('Inline JavaScript: an array of lines, as Construct 3 saves it, or one string (split into lines)'),
  disabled: z.boolean().optional().describe('Disable this individual script action'),
}, {
  errorMap: unknownKeysErrorMap('a script action', 'A script action has type, language, script and disabled.'),
}).strict();

/** Comment row among a block's actions */
export const commentActionSchema = z.object({
  type: z.literal('comment').describe('Comment row among the actions'),
  text: z.string().max(10_000).describe('Comment text'),
  'text-color': commentColorSchema.optional(),
  'background-color': commentColorSchema.optional(),
}, {
  errorMap: unknownKeysErrorMap('a comment row', 'A comment row has type, text, text-color and background-color.'),
}).strict();

const ACTION_SHAPES =
  'An action is a plugin/behavior/System action { id, objectClass, behaviorType?, parameters?, disabled?, breakpoint? }, ' +
  'a function call { callFunction, parameters?: [...], disabled? }, a script action { type: "script", script, language?, disabled? } ' +
  'or a comment row { type: "comment", text, "text-color"?, "background-color"? } (colours as [red, green, blue, alpha], each 0-1).';

/** Union of standard, function call, script and comment actions; a "sid" key is ignored (see Strict Input). */
export const actionSchema = z.preprocess(withoutSid, z.union(
  [standardActionSchema, functionCallActionSchema, scriptActionSchema, commentActionSchema],
  {
    errorMap: (issue, ctx) => (issue.code === z.ZodIssueCode.invalid_union
      ? { message: `Not a valid action. ${ACTION_SHAPES} Why each shape does not fit is listed in unionErrors.` }
      : { message: ctx.defaultError }),
  },
));

export type ConditionInput = z.infer<typeof conditionSchema>;
export type ActionInput = z.infer<typeof actionSchema>;

// ─── Recursive Child Event Schema ───────────────────────────

/** A block sub-event (eventType omitted or "block"). */
export interface BlockChildInput {
  eventType?: 'block';
  conditions?: ConditionInput[];
  actions?: ActionInput[];
  disabled?: boolean;
  isElse?: boolean;
  isOrBlock?: boolean;
  children?: ChildEventInput[];
}

/** A comment sub-event, as the editor saves it. */
export interface CommentChildInput extends CommentColors {
  eventType: 'comment';
  text: string;
}

/** A script sub-event, as the editor saves it. */
export interface ScriptChildInput {
  eventType: 'script';
  language?: 'javascript';
  script: string | string[];
  disabled?: boolean;
}

/** A sub-event: a block, a comment or a script — the kinds editor-saved sheets put under blocks. */
export type ChildEventInput = BlockChildInput | CommentChildInput | ScriptChildInput;

/** True when a sub-event input is a block (eventType omitted or "block"). */
export function isBlockChild(child: ChildEventInput): child is BlockChildInput {
  return child.eventType === undefined || child.eventType === 'block';
}

const SUB_EVENT_SHAPES =
  'A sub-event is a block { conditions?, actions?, disabled?, isElse?, isOrBlock?, children? } (eventType omitted or "block"), ' +
  'a comment { eventType: "comment", text, "text-color"?, "background-color"? } or a script { eventType: "script", script, language?, disabled? }.';

/**
 * Why a sub-event of this eventType cannot be added, and what to use instead.
 * Editor-saved sheets hold blocks, comments and scripts under blocks; the
 * other kinds are not written as sub-events by add_event_block.
 */
export function unsupportedSubEventMessage(eventType: unknown): string {
  const refused = (what: string, instead: string) =>
    `${what} cannot be added as a sub-event with add_event_block; it would be lost, so the call is refused. ${SUB_EVENT_SHAPES} ${instead}`;
  switch (eventType) {
    case 'variable':
      return refused('An event variable', 'Inside an event it would be a local variable, which add_event_block does not add. add_event_to_sheet (eventType "variable") adds a variable only at the top level of a sheet, where it is a global variable, a different scope.');
    case 'group':
      return refused('A group', 'Groups are added with add_event_to_sheet (eventType "group"); add_event_block with groupPath adds blocks into one.');
    case 'function-block':
    case 'function':
      return refused('A function block', 'Functions are added with add_event_to_sheet (eventType "function").');
    case 'include':
      return refused('An include', 'Includes are added with add_event_to_sheet (eventType "include").');
    default:
      return `Unknown sub-event type ${JSON.stringify(eventType)}; it would be lost, so the call is refused. ${SUB_EVENT_SHAPES}`;
  }
}

/** A comment sub-event: { eventType: "comment", text, "text-color"?, "background-color"? } */
const commentChildSchema = z.object({
  eventType: z.literal('comment'),
  text: z.string().max(10_000).describe('Comment text'),
  'text-color': commentColorSchema.optional(),
  'background-color': commentColorSchema.optional(),
}, {
  errorMap: unknownKeysErrorMap('a comment sub-event', 'A comment sub-event has eventType, text, text-color and background-color.'),
}).strict();

/** A script sub-event: { eventType: "script", script, language?, disabled? } */
const scriptChildSchema = z.object({
  eventType: z.literal('script'),
  language: z.literal('javascript').optional().describe('Script language (default and only value: "javascript")'),
  script: z.union([z.string(), z.array(z.string())])
    .describe('Inline JavaScript: an array of lines, as Construct 3 saves it, or one string (split into lines)'),
  disabled: z.boolean().optional().describe('Disable this script sub-event'),
}, {
  errorMap: unknownKeysErrorMap('a script sub-event', 'A script sub-event has eventType, language, script and disabled.'),
}).strict();

/**
 * One sub-event: a block, a comment or a script, told apart by eventType (a
 * block may leave it out). Other event types and unknown keys are refused
 * rather than written as an empty block; a "sid" key is ignored.
 */
export const childEventSchema: z.ZodType<ChildEventInput, z.ZodTypeDef, unknown> = z.lazy(() => childEventUnion);

const blockChildSchema = z.object({
  eventType: z.literal('block').optional().describe('Optional for a block: "block". Comment and script sub-events carry eventType "comment" / "script"'),
  conditions: z.array(conditionSchema).optional().default([]).describe(EVENT_INPUT_DESCRIPTIONS.conditions),
  actions: z.array(actionSchema).optional().default([]),
  disabled: z.boolean().optional(),
  isElse: z.boolean().optional().describe(EVENT_INPUT_DESCRIPTIONS.isElse),
  isOrBlock: z.boolean().optional().describe(EVENT_INPUT_DESCRIPTIONS.isOrBlock),
  children: z.array(childEventSchema).optional().default([]),
}, {
  errorMap: unknownKeysErrorMap('a block sub-event', `A block sub-event has eventType, conditions, actions, disabled, isElse, isOrBlock and children; a "sid" is ignored. ${SUB_EVENT_SHAPES}`),
}).strict();

const childEventUnion = z.preprocess(withoutSid, z.discriminatedUnion(
  'eventType',
  [blockChildSchema, commentChildSchema, scriptChildSchema],
  {
    errorMap: (issue, ctx) => (issue.code === z.ZodIssueCode.invalid_union_discriminator
      ? { message: unsupportedSubEventMessage((ctx.data as Record<string, unknown> | undefined)?.eventType) }
      : { message: ctx.defaultError }),
  },
));

// ─── Safety Limits ──────────────────────────────────────────

// Editor-saved sheets nest sub-events up to 7 levels below a top-level block,
// with up to 74 events in one block tree.
export const MAX_NESTING_DEPTH = 10;
export const MAX_TOTAL_EVENTS = 200;
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
 * True when `target` (an event object of `events`, e.g. the one a SID lookup
 * returned) is a function block or lies inside one (as a sub-event at any
 * depth). Matched by identity, so events that share a SID cannot be mixed up.
 * Same traversal limits as findEventsBySid.
 */
export function isInFunctionBlock(
  events: Record<string, unknown>[],
  target: Record<string, unknown>,
): boolean {
  const stack: Array<{ events: Record<string, unknown>[]; inFunction: boolean; depth: number }> = [
    { events, inFunction: false, depth: 0 },
  ];
  let nodeCount = 0;
  while (stack.length > 0) {
    if (++nodeCount > MAX_SEARCH_NODES) return false;
    const { events: currentEvents, inFunction, depth } = stack.pop()!;
    if (depth > MAX_SEARCH_DEPTH) continue;
    for (const event of currentEvents) {
      const here = inFunction || event.eventType === 'function-block';
      if (event === target) return here;
      if (Array.isArray(event.children)) {
        stack.push({ events: event.children as Record<string, unknown>[], inFunction: here, depth: depth + 1 });
      }
    }
  }
  return false;
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

/** Why a group path did not resolve (see resolveGroupPath). */
export interface GroupPathProblem {
  kind: 'not-found' | 'ambiguous';
  /** The path segment that failed, trimmed */
  segment: string;
  /** Titles of the groups before it on the path (empty: the segment is looked up at the top level) */
  parents: string[];
  /** not-found: every group title at that level; ambiguous: the titles that match the segment */
  titles: string[];
}

export type GroupPathResolution =
  | { children: Record<string, unknown>[]; problem?: undefined }
  | { children?: undefined; problem: GroupPathProblem };

function groupTitle(e: Record<string, unknown>): string | undefined {
  return e.eventType === 'group' && typeof e.title === 'string' ? e.title : undefined;
}

/**
 * Traverse the event tree to find a group by title path (e.g. "Movement > Collision").
 * Segments are split at ">". Each segment first matches a group title at its level
 * exactly as typed (the first such group wins), its whitespace kept except one space
 * on each side of a ">", which belongs to the separator: "UI " and "Parent > UI " both
 * name the title "UI ", and "UI" or "Parent > UI" the title "UI". The editor also saves
 * titles with leading or trailing whitespace, so a segment without such a match falls
 * back to the groups whose trimmed title equals the trimmed segment: exactly one is
 * taken, several make the path ambiguous (so "HUD " next to "HUD" and " HUD" is refused
 * rather than silently taking one).
 * Two-pass: verify the full path resolves before mutating any data.
 */
export function resolveGroupPath(
  events: Record<string, unknown>[],
  groupPath: string,
): GroupPathResolution {
  const rawSegments = groupPath.split('>');

  // First pass: verify all segments resolve without mutating
  let current = events;
  const groups: Array<Record<string, unknown>> = [];
  const parents: string[] = [];
  for (let i = 0; i < rawSegments.length; i++) {
    const seg = rawSegments[i].trim();
    let typed = rawSegments[i];
    if (i > 0 && typed.startsWith(' ')) typed = typed.slice(1);
    if (i < rawSegments.length - 1 && typed.endsWith(' ')) typed = typed.slice(0, -1);
    const levelGroups = current.filter(e => groupTitle(e) !== undefined);
    let group = levelGroups.find(e => groupTitle(e) === typed);
    if (!group) {
      const loose = levelGroups.filter(e => groupTitle(e)!.trim() === seg);
      if (loose.length === 1) group = loose[0];
      else {
        return {
          problem: {
            kind: loose.length > 1 ? 'ambiguous' : 'not-found',
            segment: seg,
            parents: [...parents],
            titles: (loose.length > 1 ? loose : levelGroups).map(e => groupTitle(e)!),
          },
        };
      }
    }
    groups.push(group);
    parents.push(groupTitle(group)!);
    current = Array.isArray(group.children) ? group.children as Record<string, unknown>[] : [];
  }

  // Full path resolved — ensure all groups have children arrays
  for (const g of groups) {
    if (!Array.isArray(g.children)) g.children = [];
  }

  return { children: groups[groups.length - 1].children as Record<string, unknown>[] };
}

/** The children array of the group a title path names, or null when it does not resolve (see resolveGroupPath). */
export function findGroupByPath(
  events: Record<string, unknown>[],
  groupPath: string,
): Record<string, unknown>[] | null {
  return resolveGroupPath(events, groupPath).children ?? null;
}

/** Error text for a group path that did not resolve, naming the groups there (titles quoted, so outer whitespace shows). */
export function describeGroupPathProblem(problem: GroupPathProblem, groupPath: string, sheetName: string): string {
  const where = problem.parents.length === 0
    ? 'at the top level'
    : `inside group ${problem.parents.map(t => JSON.stringify(t)).join(' > ')}`;
  const quoted = problem.titles.map(t => JSON.stringify(t)).join(', ');
  if (problem.kind === 'ambiguous') {
    return `Group path "${groupPath}" is ambiguous in "${sheetName}": ${problem.titles.length} groups ${where} have the title ` +
      `"${problem.segment}" once leading/trailing whitespace is ignored: ${quoted}. ` +
      'Write that segment with the title\'s exact whitespace; one space on each side of ">" belongs to the separator ' +
      '(e.g. "UI " or "Parent > UI " for the title "UI ").';
  }
  const hint = problem.titles.length > 0
    ? `\nGroups ${where}: ${quoted}`
    : `\nNo groups ${where}${problem.parents.length === 0 ? ' of this event sheet' : ''}.`;
  return `Group path "${groupPath}" not found in "${sheetName}": no group titled "${problem.segment}" ${where}.${hint}`;
}

// ─── Behavior Key Resolution ────────────────────────────────

/** An objectClass reference (plus optional behavior) collected from tool input. */
export interface ObjectRef {
  objectClass: string;
  behaviorType?: string;
  /** True when the input used the deprecated "behavior-type" alias */
  usedLegacyKey?: boolean;
  /** ACE id of the condition/action (for the checks on the built-in Functions object) */
  aceId?: string;
  kind?: 'condition' | 'action';
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
function toObjectRef(
  ace: Readonly<Record<string, unknown>> & { objectClass: string },
  kind: 'condition' | 'action',
): ObjectRef {
  const { behaviorType, usedLegacyKey } = resolveBehaviorType(ace);
  const ref: ObjectRef = { objectClass: ace.objectClass, kind };
  if (typeof ace.id === 'string') ref.aceId = ace.id;
  if (behaviorType) ref.behaviorType = behaviorType;
  if (usedLegacyKey) ref.usedLegacyKey = true;
  return ref;
}

// ─── Object Class Validation ────────────────────────────────

const FUNCTIONS_ACTION_LIST = [...FUNCTIONS_OBJECT_ACTION_IDS].join(', ');

/**
 * Warnings for conditions/actions on the built-in Functions object that no
 * editor save on record has: conditions, unknown action ids, behaviors. Also
 * for its actions given on System, where editor saves never put them.
 * Unverified whether the editor refuses them, so they never block a write.
 */
function checkFunctionsObjectRefs(refs: ObjectRef[], functionsName: string): string[] {
  const warnings = new Set<string>();
  for (const ref of refs) {
    const id = ref.aceId ?? '?';
    if (ref.objectClass === functionsName) {
      if (ref.kind === 'condition') {
        warnings.add(`Condition "${id}" on "${functionsName}": the built-in Functions object has no conditions on record (its actions are ${FUNCTIONS_ACTION_LIST}). System conditions use objectClass "System".`);
      } else if (ref.kind === 'action' && !FUNCTIONS_OBJECT_ACTION_IDS.has(id)) {
        warnings.add(`Action "${id}" on "${functionsName}" is not a known action of the built-in Functions object (${FUNCTIONS_ACTION_LIST}). Other built-in actions use objectClass "System".`);
      }
      if (ref.behaviorType) {
        warnings.add(`behaviorType "${ref.behaviorType}" on "${functionsName}": the built-in Functions object has no behaviors — omit behaviorType.`);
      }
    } else if (ref.objectClass === 'System' && ref.kind === 'action' && FUNCTIONS_OBJECT_ACTION_IDS.has(id)) {
      warnings.add(`Action "${id}" on "System": Construct 3 saves it on the built-in Functions object (objectClass "${functionsName}"), not on System.`);
    }
  }
  return [...warnings];
}

/** Options of validateObjectClasses. */
export interface ObjectClassCheckOptions {
  /**
   * Whether the checked conditions/actions end up inside a function block (or
   * one of its sub-events). When false, "Set return value" gets a warning:
   * it sets the return value of the function its event runs in.
   */
  insideFunction?: boolean;
}

/** Validate objectClass references against project objects, families, "System"
 *  and the built-in Functions object (named by the project's functionsName).
 *  Unknown objectClass → error. Behavior problems → warnings only (never block a write). */
export async function validateObjectClasses(
  reader: Construct3ProjectReader,
  refs: ObjectRef[],
  options: ObjectClassCheckOptions = {},
): Promise<{ errors: string[]; warnings: string[] }> {
  const objects = await reader.listObjectTypes();
  // listFamilies() reads from an in-memory Map and never throws — no try/catch needed.
  const families = await reader.listFamilies();
  // The built-in Functions object is named by the project's functionsName. No
  // object type or family can share its name: the project would not load
  // (duplicate-object-name), so an objectClass of that name is always it.
  const functionsName = functionsObjectName(reader);
  const validClasses = new Set([...objects, ...families, 'System', functionsName]);

  const errors: string[] = [];
  const warnings: string[] = [];

  for (const ref of refs) {
    if (!validClasses.has(ref.objectClass)) {
      const suggestions = reader.findNearestName(ref.objectClass, 'objects');
      const hint = suggestions.length > 0
        ? ` Did you mean: ${suggestions.join(', ')}?`
        : '';
      const functionsHint = ref.objectClass === DEFAULT_FUNCTIONS_OBJECT_NAME
        ? ` This project names the built-in Functions object "${functionsName}" (functionsName in project.c3proj).`
        : '';
      errors.push(`Unknown objectClass "${ref.objectClass}".${hint}${functionsHint}`);
    }
  }

  warnings.push(...checkFunctionsObjectRefs(refs, functionsName));
  if (options.insideFunction === false
    && refs.some(r => r.objectClass === functionsName && r.kind === 'action' && r.aceId === 'set-function-return-value')) {
    warnings.push(
      `"set-function-return-value" (Set return value) sets the return value of the function its event runs in, but this event is not inside a function block. ` +
      'Every editor save on record uses it in a function block or one of its sub-events; add it there (update_event_block addActions on the function block or a sub-event).',
    );
  }

  // Soft-validate behaviors: warn when behaviorType names no behavior on the
  // object type or any family it belongs to (family behaviors are usable on
  // member objects in C3 events). The Functions object has none (checked above).
  const behaviorRefs = refs.filter(r => r.behaviorType && validClasses.has(r.objectClass) && r.objectClass !== functionsName);
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

  return createAceOriginResolver({
    objects,
    families,
    usedAddons: reader.getUsedAddons(),
    functionsName: functionsObjectName(reader),
  });
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
    refs.push(toObjectRef(c, 'condition'));
  }
  for (const a of actions) {
    // Function calls name no object: the legacy form's id/objectClass are dropped when written
    if (isFunctionCallInput(a)) continue;
    if ('objectClass' in a && typeof a.objectClass === 'string') {
      refs.push(toObjectRef(a as Record<string, unknown> & { objectClass: string }, 'action'));
    }
  }
  for (const child of children) {
    // Comment and script sub-events name no object
    if (!isBlockChild(child)) continue;
    collectObjectRefs(
      child.conditions ?? [],
      (child.actions ?? []) as Array<Record<string, unknown>>,
      child.children ?? [],
      refs,
      depth + 1,
    );
  }
}

// ─── Else / OR ──────────────────────────────────────────────

/**
 * Decide whether a block is an OR block. `isOrBlock` is the input; the
 * deprecated per-condition `isOr` flags (never written) are mapped onto it
 * when that is unambiguous: every condition after the first carries isOr (the
 * flag on the first one never had an effect). Construct 3 ORs a whole event, so
 * isOr on only some of the later conditions is refused.
 */
export function resolveOrBlock(
  isOrBlock: boolean | undefined,
  conditions: ReadonlyArray<{ isOr?: boolean }>,
  where: string,
  warnings: string[],
): boolean {
  const flags = conditions.map(c => c.isOr === true);
  if (!flags.some(Boolean)) return isOrBlock === true;

  if (isOrBlock === true) {
    warnings.push(`${where}: the deprecated per-condition isOr flag is not written; isOrBlock: true already makes this an OR block.`);
    return true;
  }
  const later = flags.slice(1);
  if (later.length > 0 && later.every(Boolean)) {
    if (isOrBlock === false) {
      throw new Error(`${where}: the conditions carry isOr, but isOrBlock is false. Use isOrBlock: true for an OR block and drop the deprecated isOr flags.`);
    }
    warnings.push(`${where}: the deprecated per-condition isOr flags were written as the block's isOrBlock: true, the flag Construct 3 reads. Pass isOrBlock: true instead.`);
    return true;
  }
  if (!later.some(Boolean)) {
    warnings.push(`${where}: isOr on the first condition has no effect (there is no condition before it) and was not written. Use isOrBlock: true to OR a block's conditions.`);
    return false;
  }
  throw new Error(
    `${where}: only some conditions carry isOr. Construct 3 ORs a whole event, not single conditions: ` +
    'set isOrBlock: true to OR all of the block\'s conditions, or move the alternatives into sub-events.',
  );
}

// ─── Condition / Action Builders ────────────────────────────

/** Build a condition in the editor's key order: id, objectClass, sid, disabled,
 *  behaviorType, parameters, isInverted. The deprecated `isOr` input is never
 *  written (see resolveOrBlock). */
export function buildCondition(c: ConditionInput, sid: number): Condition {
  const cond: Condition = {
    id: c.id,
    objectClass: c.objectClass,
    sid,
  };
  if (c.disabled) cond.disabled = true;
  const { behaviorType } = resolveBehaviorType(c);
  if (behaviorType) cond.behaviorType = behaviorType;
  if (c.parameters) cond.parameters = c.parameters;
  if (c.isInverted) cond.isInverted = true;
  return cond;
}

/** Build a plugin/behavior/System action in the editor's key order:
 *  id, objectClass, sid, disabled, breakpoint, behaviorType, parameters. */
export function buildStandardAction(a: z.infer<typeof standardActionSchema>, sid: number): StandardAction {
  const act: StandardAction = {
    id: a.id,
    objectClass: a.objectClass,
    sid,
  };
  if (a.disabled) act.disabled = true;
  if (a.breakpoint) act.breakpoint = true;
  const { behaviorType } = resolveBehaviorType(a);
  if (behaviorType) act.behaviorType = behaviorType;
  if (a.parameters) act.parameters = a.parameters;
  return act;
}

/**
 * Build a script action as the editor saves it: { type, language, script: [lines], disabled? }.
 * A string is split into lines (a trailing newline leaves a last empty line, as in editor saves).
 */
export function buildScriptAction(a: { script: string | string[]; disabled?: boolean }): ScriptAction {
  const act: ScriptAction = {
    type: 'script',
    language: 'javascript',
    script: toScriptLines(a.script),
  };
  if (a.disabled) act.disabled = true;
  return act;
}

/** Copy the comment colours of an input onto a comment event or row, in the editor's key order. */
function addCommentColors<T extends Record<string, unknown>>(target: T, input: CommentColors): T {
  for (const key of COMMENT_COLOR_KEYS) {
    const color = input[key];
    if (color !== undefined) (target as Record<string, unknown>)[key] = [...color];
  }
  return target;
}

/** Build a comment row as the editor saves it: { type, text, "text-color"?, "background-color"? }. */
export function buildCommentAction(a: { text: string } & CommentColors): CommentAction {
  return addCommentColors({ type: 'comment', text: a.text } as CommentAction, a);
}

/** Build a comment sub-event as the editor saves it: { eventType, text, "text-color"?, "background-color"? }. */
export function buildCommentEvent(c: CommentChildInput): CommentEvent {
  return addCommentColors(createCommentEvent(c.text), c);
}

/**
 * Build a script sub-event as the editor saves it: { eventType, language, script: [lines], disabled? }.
 * A string is split into lines, as for script actions.
 */
export function buildScriptEvent(s: ScriptChildInput): ScriptEvent {
  const event: ScriptEvent = {
    eventType: 'script',
    language: 'javascript',
    script: toScriptLines(s.script),
  };
  if (s.disabled) event.disabled = true;
  return event;
}

/** True when an action input or stored action is a function call. */
export const isFunctionCallInput = isFunctionCall;

/** Event functions of the project by lower-cased name, so a call spelled in another case still finds its function. */
export async function loadFunctionSignatures(reader: Construct3ProjectReader): Promise<Map<string, FunctionSignature>> {
  try {
    return collectFunctionSignatures((await reader.readAllEventSheets()).values());
  } catch {
    return new Map();
  }
}

/**
 * For a function map action of the Functions object ("Map function", "Map
 * function default"), check the function its "function" parameter names and
 * write the defined spelling (resolveMappedFunctionName). Other actions are
 * left alone. `signatures` loads the project's function signatures on demand.
 */
export async function resolveFunctionMapParameter(
  reader: Construct3ProjectReader,
  action: Record<string, unknown>,
  label: string,
  warnings: string[],
  signatures: () => Promise<Map<string, FunctionSignature>>,
): Promise<void> {
  const mapped = mappedFunctionName(action, functionsObjectName(reader));
  if (mapped === undefined) return;
  const spelled = resolveMappedFunctionName(mapped, (await signatures()).get(mapped.toLowerCase()), label, warnings);
  if (spelled !== mapped) action.parameters = { ...(action.parameters as Record<string, unknown>), function: spelled };
}

/** What building actions needs besides the input: SIDs, warnings and (lazily) function signatures. */
export interface ActionBuildContext {
  warnings: string[];
  functions?: Map<string, FunctionSignature>;
}

/**
 * Build one action from tool input in the editor's shape: plugin/behavior
 * actions, function calls ({ callFunction, sid, parameters: [...] }, also from
 * the legacy { id, objectClass, callFunction, parameters: {...} } input),
 * script actions and comment rows.
 */
export async function buildAction(
  reader: Construct3ProjectReader,
  idGen: IdGenerator,
  a: ActionInput,
  ctx: ActionBuildContext,
  where: string,
): Promise<Action> {
  if ('type' in a && a.type === 'script') return buildScriptAction(a);
  if ('type' in a && a.type === 'comment') return buildCommentAction(a);

  const rec = a as Record<string, unknown>;
  if (isFunctionCallInput(rec)) {
    const name = rec.callFunction as string;
    const label = `${where}, call to "${name}"`;
    ctx.functions ??= await loadFunctionSignatures(reader);
    const signature = ctx.functions.get(name.toLowerCase());
    const args = toPositionalArguments(rec.parameters, signature, label);
    ctx.warnings.push(...checkFunctionCallArguments(args, signature, name, label));
    const callName = resolveCallName(name, signature, label, ctx.warnings);
    const dropped = LEGACY_CALL_KEYS.filter(k => rec[k] !== undefined);
    if (dropped.length > 0) {
      ctx.warnings.push(`${label}: written in the editor's function call shape { callFunction, sid, parameters: [...] }; ${dropped.join('/')} ${dropped.length === 1 ? 'was' : 'were'} dropped. Pass { callFunction, parameters: [...] } in future calls.`);
    }
    const sid = await idGen.generateSid(reader);
    return createFunctionCallAction(callName, sid, args, rec.disabled === true);
  }

  const sid = await idGen.generateSid(reader);
  const action = buildStandardAction(a as z.infer<typeof standardActionSchema>, sid);
  await resolveFunctionMapParameter(reader, action as unknown as Record<string, unknown>, `${where}, "${action.id}"`, ctx.warnings, async () => {
    ctx.functions ??= await loadFunctionSignatures(reader);
    return ctx.functions;
  });
  return action;
}

// ─── Recursive Block Builder ────────────────────────────────

/** Tool input for one block event (top level or sub-event). */
export interface BlockInput {
  conditions: ConditionInput[];
  actions: ActionInput[];
  disabled?: boolean;
  isElse?: boolean;
  isOrBlock?: boolean;
  children: ChildEventInput[];
}

function locationLabel(depth: number): string {
  return depth === 1 ? 'Block' : `Sub-event at depth ${depth}`;
}

/** What building a block tree keeps track of: the event count (safety limit), warnings and function signatures. */
export interface BlockBuildCounter {
  count: number;
  warnings: string[];
  functions?: Map<string, FunctionSignature>;
}

/** Count one more event of the tree being built, enforcing the depth and size limits. */
function countEvent(depth: number, counter: BlockBuildCounter): void {
  if (depth > MAX_NESTING_DEPTH) {
    throw new Error(`Sub-event nesting exceeds maximum depth of ${MAX_NESTING_DEPTH}`);
  }
  counter.count++;
  if (counter.count > MAX_TOTAL_EVENTS) {
    throw new Error(`Total event count exceeds maximum of ${MAX_TOTAL_EVENTS}`);
  }
}

/**
 * Build one sub-event in the editor's shape: a block (recursively), a comment
 * or a script. Any other event type is refused (the input schema already
 * refuses it; this guards direct callers), never written as an empty block.
 */
async function buildChildEvent(
  reader: Construct3ProjectReader,
  idGen: IdGenerator,
  child: ChildEventInput,
  depth: number,
  counter: BlockBuildCounter,
): Promise<C3Event> {
  switch (child.eventType) {
    case 'comment':
      countEvent(depth, counter);
      return buildCommentEvent(child);
    case 'script':
      countEvent(depth, counter);
      return buildScriptEvent(child);
    case undefined:
    case 'block':
      return buildBlockEvent(
        reader,
        idGen,
        {
          conditions: child.conditions ?? [],
          actions: child.actions ?? [],
          disabled: child.disabled,
          isElse: child.isElse,
          isOrBlock: child.isOrBlock,
          children: child.children ?? [],
        },
        depth,
        counter,
      );
    default:
      throw new Error(unsupportedSubEventMessage((child as { eventType?: unknown }).eventType));
  }
}

/** Recursively build a block event with conditions, actions, and children.
 *  Returns the built block and increments the counter (for safety limit). */
export async function buildBlockEvent(
  reader: Construct3ProjectReader,
  idGen: IdGenerator,
  block: BlockInput,
  depth: number,
  counter: BlockBuildCounter,
): Promise<BlockEvent> {
  countEvent(depth, counter);

  // Cap conditions and actions per block to prevent SID amplification
  if (block.conditions.length > MAX_ITEMS_PER_BLOCK) {
    throw new Error(`Block has ${block.conditions.length} conditions (max ${MAX_ITEMS_PER_BLOCK})`);
  }
  if (block.actions.length > MAX_ITEMS_PER_BLOCK) {
    throw new Error(`Block has ${block.actions.length} actions (max ${MAX_ITEMS_PER_BLOCK})`);
  }

  const where = locationLabel(depth);

  // Else is the System "else" condition at index 0; conditions after it make an else-if.
  const hasElseCondition = isElseCondition(block.conditions[0]);
  const isElse = block.isElse === true || hasElseCondition;
  // A block holds one "else" condition, first. In an else block a further one
  // is a duplicate and is dropped; elsewhere it is written, with a warning.
  const conditions = block.conditions.filter((c, i) => {
    if (i === 0 || !isElseCondition(c)) return true;
    if (isElse) {
      const why = hasElseCondition ? 'the block already starts with one' : 'isElse: true writes it as the first condition';
      counter.warnings.push(`${where}: dropped the System "else" condition given as condition ${i}: ${why}, and Construct 3 saves Else once, as the first condition.`);
      return false;
    }
    counter.warnings.push(`${where}: the System "else" condition is condition ${i}. Construct 3 saves Else as the first condition of a block; use isElse: true or put it first.`);
    return true;
  });

  const isOrBlock = resolveOrBlock(block.isOrBlock, conditions, where, counter.warnings);
  if (isElse && isOrBlock) {
    counter.warnings.push(`${where}: an else block that is also an OR block. No editor-saved sheet on record combines the two, so check the event in Construct 3.`);
  }

  // Events without conditions are normal (the editor writes and loads them);
  // at the top level such a block runs every tick, which is worth a note.
  if (!isElse && conditions.length === 0 && depth === 1) {
    counter.warnings.push('Block has no conditions: it runs every tick (as a sub-event, an event without conditions runs whenever its parent runs).');
  }

  const blockSid = await idGen.generateSid(reader);

  // Build conditions with SIDs
  const builtConditions: Condition[] = [];
  if (block.isElse === true && !hasElseCondition) {
    builtConditions.push(createElseCondition(await idGen.generateSid(reader)));
  }
  for (const c of conditions) {
    const condSid = await idGen.generateSid(reader);
    builtConditions.push(buildCondition(c, condSid));
  }

  // Build actions (SIDs for all but script and comment rows, which the editor saves without one)
  const builtActions: Action[] = [];
  for (const a of block.actions) {
    builtActions.push(await buildAction(reader, idGen, a, counter, where));
  }

  // Recursively build children (blocks, comments, scripts). Where an else block
  // stands (after a block without a trigger) is checked on the whole sheet by the load-time gate.
  const builtChildren: C3Event[] = [];
  for (const child of block.children) {
    builtChildren.push(await buildChildEvent(reader, idGen, child, depth + 1, counter));
  }

  return createBlockEvent(blockSid, builtConditions, builtActions, {
    disabled: block.disabled,
    children: builtChildren,
    isOrBlock,
  });
}
