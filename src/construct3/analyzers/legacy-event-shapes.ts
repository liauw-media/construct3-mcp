/**
 * Detection and repair of event shapes that differ from what the current
 * Construct 3 editor saves (issue #32):
 *
 * - block-level "isElse": the editor saves Else as a System "else" first condition;
 * - per-condition "isOr": the editor marks an OR block with the block key "isOrBlock";
 * - function calls with id/objectClass or keyed parameters: the editor saves
 *   { callFunction, sid, parameters: [positional] };
 * - scripts as one string or without "language": the editor saves
 *   { type: "script", language: "javascript", script: [lines] }.
 *
 * construct3-mcp 1.8.1 and earlier wrote all four. The editor never writes the
 * first three; whether it ignores them or refuses the project is not verified,
 * so they are reported as warnings. The script shape is what older Construct 3
 * releases saved, and converting it is harmless. A repair is made only where
 * the editor shape it produces is unambiguous; everything else is reported for
 * a decision by hand.
 */

import type { C3Event } from '../types.js';
import {
  createElseCondition,
  isElseCondition,
  isFunctionCall,
  isLegacyFunctionCall,
  isLegacyScript,
  rewriteFunctionCallInPlace,
  rewriteScriptInPlace,
  toPositionalArguments,
  type FunctionSignature,
} from '../event-shapes.js';
import { describeElsePlacementProblem, elsePlacementProblem, previousNonComment } from './load-rules.js';

const MAX_NODES = 100_000;
const MAX_DEPTH = 50;

export type LegacyEventShapeKind = 'isElse' | 'isOr' | 'function-call' | 'script';

export interface LegacyEventShapeHit {
  kind: LegacyEventShapeKind;
  /** JSON path from the sheet root, e.g. events[3].children[1] or events[0].actions[2] */
  path: string;
  /** SID of the block (isElse, isOr) or of the call action */
  sid?: number;
  /** What the repair does (fixable hits) or why it needs a decision by hand (manual hits) */
  detail: string;
  /**
   * True when the repair can change what the event does: the old key may have
   * had no effect, so an isElse block may have run like an ordinary block and
   * isOr conditions may have been AND-combined until now.
   */
  changesBehavior?: boolean;
}

/** Added to the detail of repairs that can change what an event does. */
const RETEST = 'Test the event in the game afterwards.';

export interface LegacyEventShapeScan {
  /** Hits with an unambiguous editor shape; converted in place with `apply` */
  fixable: LegacyEventShapeHit[];
  /** Hits that need a decision by hand; never modified */
  manual: LegacyEventShapeHit[];
  /** True when the node/depth limit stopped the scan */
  truncated: boolean;
}

export interface LegacyEventShapeScanOptions {
  /** Convert the fixable hits in place */
  apply?: boolean;
  /** SID for a new System "else" condition (needed with `apply`) */
  newSid?: () => Promise<number>;
  /** Event functions by lower-cased name, to map named call parameters to positions */
  functions?: Map<string, FunctionSignature>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sidOf(value: Record<string, unknown>): number | undefined {
  return typeof value.sid === 'number' ? value.sid : undefined;
}

/** Label for messages, e.g. `block events[2] (SID 12)`. */
export function describeLegacyEventShapeHit(hit: LegacyEventShapeHit): string {
  const what = hit.kind === 'isElse'
    ? 'block-level "isElse"'
    : hit.kind === 'isOr'
      ? 'per-condition "isOr"'
      : hit.kind === 'script'
        ? 'script in the old shape'
        : 'function call in the old shape';
  return `${what} at ${hit.path}${hit.sid !== undefined ? ` (SID ${hit.sid})` : ''}`;
}

/**
 * Scan an event tree for legacy event shapes. With `apply`, fixable hits are
 * converted in place:
 * - isElse: true on a block without conditions whose previous sibling (not
 *   counting comments) is a block without a trigger: a System "else"
 *   condition with a new SID is put first and the key dropped. When the block
 *   already starts with the else condition, or the key is not true, the key
 *   is just dropped. A block with conditions, or where Else cannot stand (see
 *   elsePlacementProblem), is reported instead.
 * - isOr: when every condition after the first carries isOr: true, the block
 *   becomes an OR block (isOrBlock: true). Keys that never had an effect (on
 *   the first condition only, false values, or in a block that is already an
 *   OR block) are dropped. isOr on only some later conditions is reported.
 * - function calls: id/objectClass/behavior keys are dropped and parameters
 *   become a positional array, when they are keyed "0".."n-1" or exactly by
 *   the function's parameter names. Other keyings are reported.
 * - script actions and script events: a script given as one string becomes
 *   an array of lines, and a missing "language" becomes "javascript". A
 *   script that is neither text nor lines is reported.
 * The else and OR repairs can change what an event does (changesBehavior).
 */
export async function scanLegacyEventShapes(
  events: C3Event[],
  options: LegacyEventShapeScanOptions = {},
): Promise<LegacyEventShapeScan> {
  const result: LegacyEventShapeScan = { fixable: [], manual: [], truncated: false };
  const stack: Array<{ list: unknown[]; path: string; depth: number }> = [{ list: events, path: '', depth: 0 }];
  let nodes = 0;

  while (stack.length > 0) {
    const { list, path, depth } = stack.pop()!;
    if (depth > MAX_DEPTH) {
      result.truncated = true;
      continue;
    }
    for (let i = 0; i < list.length; i++) {
      if (++nodes > MAX_NODES) {
        result.truncated = true;
        return result;
      }
      const event = list[i];
      if (!isRecord(event)) continue;
      const eventPath = path ? `${path}.children[${i}]` : `events[${i}]`;

      if ('isElse' in event) await scanIsElse(event, previousNonComment(list, i), eventPath, result, options);
      if (Array.isArray(event.conditions)) scanIsOr(event, eventPath, result, options);
      if (Array.isArray(event.actions)) scanCalls(event.actions, eventPath, result, options);
      if (Array.isArray(event.actions)) {
        event.actions.forEach((action, j) => {
          if (isRecord(action)) scanScript(action, `${eventPath}.actions[${j}]`, result, options);
        });
      }
      if (event.eventType === 'script') scanScript(event, eventPath, result, options);

      if (Array.isArray(event.children)) {
        stack.push({ list: event.children, path: eventPath, depth: depth + 1 });
      }
    }
  }
  return result;
}

async function scanIsElse(
  event: Record<string, unknown>,
  previous: unknown,
  path: string,
  result: LegacyEventShapeScan,
  options: LegacyEventShapeScanOptions,
): Promise<void> {
  const hit = { kind: 'isElse' as const, path, sid: sidOf(event) };
  const conditions = Array.isArray(event.conditions) ? event.conditions : undefined;

  if (event.isElse !== true) {
    result.fixable.push({ ...hit, detail: `drop "isElse": ${JSON.stringify(event.isElse)} (no effect)` });
    if (options.apply) delete event.isElse;
    return;
  }
  if (event.eventType !== 'block' || !conditions) {
    result.manual.push({ ...hit, detail: `a ${String(event.eventType)} event cannot be an else block; remove the "isElse" key` });
    return;
  }
  if (isElseCondition(conditions[0])) {
    result.fixable.push({ ...hit, detail: 'drop "isElse" (the block already starts with the System "else" condition)' });
    if (options.apply) delete event.isElse;
    return;
  }
  if (conditions.length > 0) {
    result.manual.push({
      ...hit,
      detail: `the block has ${conditions.length} condition(s): with a System "else" condition first it becomes an else-if that tests them. ` +
        'Decide by hand: update_event_block with isElse: true makes it an else-if, isElse: false keeps it an ordinary block',
    });
    return;
  }
  const placement = elsePlacementProblem(previous, []);
  if (placement) {
    const fix = placement.kind === 'no-block-before'
      ? 'Move it after the block it belongs to, or remove the "isElse" key'
      : 'Branch with sub-events under the triggered event instead (a block with the condition, then the else block), or remove the "isElse" key';
    result.manual.push({ ...hit, detail: `it cannot become an else block here: ${describeElsePlacementProblem(placement)}. ${fix}` });
    return;
  }
  result.fixable.push({
    ...hit,
    detail: 'put a System "else" condition first and drop "isElse". If Construct 3 ignored the key, the block ran like an ordinary ' +
      `block until now; as an else block it runs only when the block before it did not. ${RETEST}`,
    changesBehavior: true,
  });
  if (options.apply) {
    if (!options.newSid) throw new Error('scanLegacyEventShapes: apply needs newSid');
    conditions.unshift(createElseCondition(await options.newSid()));
    delete event.isElse;
  }
}

function scanIsOr(
  event: Record<string, unknown>,
  path: string,
  result: LegacyEventShapeScan,
  options: LegacyEventShapeScanOptions,
): void {
  const conditions = event.conditions as unknown[];
  const keyed = conditions.map(c => isRecord(c) && 'isOr' in c);
  if (!keyed.some(Boolean)) return;
  const flags = conditions.map(c => isRecord(c) && c.isOr === true);
  const hit = { kind: 'isOr' as const, path, sid: sidOf(event) };
  const dropKeys = () => {
    for (const c of conditions) if (isRecord(c)) delete c.isOr;
  };

  const later = flags.slice(1);
  if (event.isOrBlock === true) {
    result.fixable.push({ ...hit, detail: 'drop "isOr" (the block is already an OR block)' });
  } else if (later.length > 0 && later.every(Boolean)) {
    result.fixable.push({
      ...hit,
      detail: 'every condition after the first carries "isOr": make the block an OR block (isOrBlock: true) and drop "isOr". ' +
        'If Construct 3 ignored the key, the conditions were AND-combined until now; as an OR block the event runs when any of them is true. ' +
        RETEST,
      changesBehavior: true,
    });
    if (options.apply) {
      dropKeys();
      event.isOrBlock = true;
    }
    return;
  } else if (!later.some(Boolean)) {
    result.fixable.push({ ...hit, detail: 'drop "isOr" (only on the first condition, or false: it never had an effect)' });
  } else {
    result.manual.push({
      ...hit,
      detail: 'only some conditions carry "isOr", and Construct 3 ORs a whole event. Make it an OR block (update_event_block with isOrBlock: true), or split the alternatives into separate events',
    });
    return;
  }
  if (options.apply) dropKeys();
}

function scanCalls(
  actions: unknown[],
  path: string,
  result: LegacyEventShapeScan,
  options: LegacyEventShapeScanOptions,
): void {
  actions.forEach((action, i) => {
    if (!isRecord(action) || !isFunctionCall(action) || !isLegacyFunctionCall(action)) return;
    const name = action.callFunction as string;
    const hit = { kind: 'function-call' as const, path: `${path}.actions[${i}]`, sid: sidOf(action) };
    let args;
    try {
      args = toPositionalArguments(action.parameters, options.functions?.get(name.toLowerCase()), `call to "${name}"`);
    } catch (error) {
      result.manual.push({ ...hit, detail: error instanceof Error ? error.message : String(error) });
      return;
    }
    result.fixable.push({
      ...hit,
      detail: `rewrite the call to "${name}" as { callFunction, sid, parameters: [${args.length} argument(s)] } without id/objectClass`,
    });
    if (options.apply) rewriteFunctionCallInPlace(action, args);
  });
}

function scanScript(
  rec: Record<string, unknown>,
  path: string,
  result: LegacyEventShapeScan,
  options: LegacyEventShapeScanOptions,
): void {
  if (!isLegacyScript(rec)) return;
  const hit = { kind: 'script' as const, path };
  const { script } = rec;
  const isLines = Array.isArray(script) && script.every(line => typeof line === 'string');
  if (typeof script !== 'string' && !isLines) {
    result.manual.push({ ...hit, detail: 'the script is neither text nor a list of lines; rewrite it by hand as { type: "script", language: "javascript", script: [lines] }' });
    return;
  }
  const steps = [
    typeof script === 'string' ? 'store the code as a list of lines' : '',
    'language' in rec ? '' : 'add language "javascript"',
  ].filter(Boolean).join(' and ');
  result.fixable.push({ ...hit, detail: `${steps}, as Construct 3 saves scripts` });
  if (options.apply) rewriteScriptInPlace(rec);
}
