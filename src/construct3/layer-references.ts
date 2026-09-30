/**
 * Event sheet expressions that name a layer.
 *
 * Layers are named in events by string expressions: a condition's or
 * action's "layer" parameter (System Create object, Set layer visible, Sprite
 * Move to layer, ...) takes a layer name or number, and the editor saves a
 * name as a quoted string (`"layer": "\"HUD\""`); layer expressions take one
 * too (`LayerScale("HUD")`). The editor looks layer names up ignoring case
 * (see layers.ts). Renaming a layer leaves such strings naming a layer that
 * no longer exists, and a layer parameter is not tied to a layout: it names
 * a layer of whatever layout runs the event sheet.
 *
 * A "layer" parameter whose whole expression is one string literal naming
 * the layer is a sure reference (`definite`). A string literal naming it
 * anywhere else (another parameter, part of a longer expression, a function
 * call argument, a script) may name the layer or something else of the same
 * name (an animation, a text), so it is only reported.
 */

import type { EventSheet } from './types.js';
import { nameKey } from './names.js';

/** A condition, action or script that names a layer in a string. */
export interface LayerNameUse {
  eventSheet: string;
  /** JSON path of the event, e.g. "events[3].children[1]" */
  eventPath: string;
  /** "condition 0", "action 2" */
  ace: string;
  /** Parameter key ("layer", "x", ...), the argument index of a function call, or "script" */
  parameter: string;
  /** The expression (or script line) as saved */
  expression: string;
  /** A "layer" parameter that is exactly the quoted name */
  definite: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The string literals of a Construct expression ("" inside one is a quote), with their positions. */
export function expressionStringLiterals(expression: string): Array<{ start: number; end: number; text: string }> {
  const literals: Array<{ start: number; end: number; text: string }> = [];
  let i = 0;
  while (i < expression.length) {
    if (expression[i] !== '"') {
      i++;
      continue;
    }
    const start = i;
    let text = '';
    i++;
    while (i < expression.length) {
      if (expression[i] === '"') {
        if (expression[i + 1] === '"') {
          text += '"';
          i += 2;
          continue;
        }
        break;
      }
      text += expression[i];
      i++;
    }
    if (i >= expression.length) break; // unterminated: not a literal
    literals.push({ start, end: i + 1, text });
    i++;
  }
  return literals;
}

/** A layer name as a Construct string literal. */
export function layerNameLiteral(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** The literal of `expression` naming `layerName` (ignoring case) when the whole expression is that one literal. */
function wholeLiteralNaming(expression: string, layerName: string): { start: number; end: number } | undefined {
  const literals = expressionStringLiterals(expression);
  if (literals.length !== 1) return undefined;
  const [literal] = literals;
  if (nameKey(literal.text) !== nameKey(layerName)) return undefined;
  return expression.slice(0, literal.start).trim() === '' && expression.slice(literal.end).trim() === '' ? literal : undefined;
}

type Visit = (use: Omit<LayerNameUse, 'eventSheet'>, rewrite: (() => void) | undefined) => void;

/**
 * Walk the conditions, actions and script lines of one sheet (events,
 * groups, function blocks and sub-events to any depth) that name `layerName`
 * in a string literal. `rewrite` (for definite uses, when `newName` is
 * given) replaces the literal with the new name.
 */
function walkLayerNameUses(sheet: EventSheet | undefined, layerName: string, newName: string | undefined, visit: Visit): void {
  const key = nameKey(layerName);
  const scriptPattern = new RegExp(`(["'\`])${layerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1`, 'i');
  const stack: Array<{ events: unknown; path: string }> = [{ events: sheet?.events, path: 'events' }];
  while (stack.length > 0) {
    const { events, path } = stack.pop()!;
    if (!Array.isArray(events)) continue;
    events.forEach((event, i) => {
      if (!isRecord(event)) return;
      const eventPath = `${path}[${i}]`;
      for (const kind of ['conditions', 'actions'] as const) {
        const aces = event[kind];
        if (!Array.isArray(aces)) continue;
        aces.forEach((ace, j) => {
          if (!isRecord(ace)) return;
          const aceLabel = `${kind === 'conditions' ? 'condition' : 'action'} ${j}`;
          if (Array.isArray(ace.script)) {
            for (const line of ace.script) {
              if (typeof line === 'string' && scriptPattern.test(line)) {
                visit({ eventPath, ace: aceLabel, parameter: 'script', expression: line, definite: false }, undefined);
              }
            }
          }
          const params = ace.parameters;
          const entries: Array<[string, unknown]> = isRecord(params)
            ? Object.entries(params)
            : Array.isArray(params) ? params.map((value, n) => [String(n), value]) : [];
          for (const [param, value] of entries) {
            if (typeof value !== 'string') continue;
            if (!expressionStringLiterals(value).some(l => nameKey(l.text) === key)) continue;
            const whole = isRecord(params) && param === 'layer' ? wholeLiteralNaming(value, layerName) : undefined;
            const rewrite = whole && newName !== undefined
              ? () => { (params as Record<string, unknown>)[param] = value.slice(0, whole.start) + layerNameLiteral(newName) + value.slice(whole.end); }
              : undefined;
            visit({ eventPath, ace: aceLabel, parameter: param, expression: value, definite: whole !== undefined }, rewrite);
          }
        });
      }
      if (typeof event.script === 'string' || Array.isArray(event.script)) {
        const lines = Array.isArray(event.script) ? event.script : [event.script];
        for (const line of lines) {
          if (typeof line === 'string' && scriptPattern.test(line)) {
            visit({ eventPath, ace: 'script', parameter: 'script', expression: line, definite: false }, undefined);
          }
        }
      }
      stack.push({ events: event.children, path: `${eventPath}.children` });
    });
  }
}

/** Every string in the given sheets that names `layerName` (see the module comment). */
export function findLayerNameUses(sheets: ReadonlyMap<string, EventSheet>, layerName: string): LayerNameUse[] {
  const uses: LayerNameUse[] = [];
  for (const [name, sheet] of sheets) {
    walkLayerNameUses(sheet, layerName, undefined, use => uses.push({ eventSheet: name, ...use }));
  }
  return uses;
}

/**
 * Point the definite uses of `oldName` in one sheet (in memory) at `newName`.
 * Returns how many parameters changed.
 */
export function renameLayerParameters(sheet: EventSheet, oldName: string, newName: string): number {
  let count = 0;
  walkLayerNameUses(sheet, oldName, newName, (_use, rewrite) => {
    if (rewrite) {
      rewrite();
      count++;
    }
  });
  return count;
}

/** Where a use is, for messages: '"Sheet1" events[3] action 0 "layer"'. */
export function layerNameUseLocation(use: LayerNameUse): string {
  const where = use.parameter === 'script' ? 'script' : `"${use.parameter}"`;
  return `"${use.eventSheet}" ${use.eventPath} ${use.ace} ${where}`;
}
