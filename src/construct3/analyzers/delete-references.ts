/**
 * Names a delete_event_from_sheet delete would leave pointing at nothing.
 *
 * After the Construct 3 editor loads a project it resolves the names stored in
 * event parameters (projectResources.js r495.2: a pass over every parameter,
 * run once the project's files are read):
 * - the "variable" parameter of the System ACEs that read or set an event
 *   variable (EVENT_VARIABLE_ACE_IDS) throws `cannot find event variable
 *   '<name>'` when no event variable or function parameter of that name is in
 *   scope;
 * - a "Call function" action throws `invalid function name '<name>'` when no
 *   function block has that name;
 * - the "function" parameter of the Functions object's "Map function" and
 *   "Map function default" throws `cannot find function '<name>'`.
 * The editor compares these names ignoring case. Whether such an exception
 * stops the project from opening has not been confirmed in the editor.
 * `Functions.Name(...)` calls in expressions are not part of that pass as far
 * as the loader code shows (unverified); after the delete they name a
 * function that no longer exists. The same holds for event variables named in
 * expressions (`Score * 2`, a function call argument `Score`): every string
 * parameter is read as an expression (findExpressionIdentifiers), except the
 * parameters that hold a name rather than an expression
 * (NAME_PARAMETER_KEYS: objects, instance variables, layouts, audio files)
 * and the "variable" parameter above. A combo parameter whose value is spelled
 * like the variable is counted as well; the caller lists what it found, so
 * such a reference can be checked and the delete forced.
 *
 * Scope of event variables (the editor's lookup, the same scope as the name
 * rules for new variables): a variable at the top level of a sheet is global
 * and visible in every sheet; any other variable is visible to the events
 * beside it and below them; function parameters are visible inside their
 * function block. Only references that resolve before the delete and no longer
 * resolve after it are reported, so a reference that still finds another
 * variable or function of the same name (another sheet's global, a duplicate
 * function) is not reported, and neither is one that was already dangling.
 *
 * Scripts (script actions, script blocks, project scripts) are not scanned.
 */

import { findExpressionCalls, findExpressionIdentifiers, mappedFunctionName, parameterValues } from '../event-shapes.js';

const MAX_NODES = 100_000;
const MAX_DEPTH = 50;

/**
 * System ACEs whose "variable" parameter names an event variable (parameter
 * types eventvar, eventvarbool and eventvarany in the editor's System ACE
 * definitions); keys are "condition:<id>" and "action:<id>".
 */
export const EVENT_VARIABLE_ACE_IDS: ReadonlySet<string> = new Set([
  'condition:compare-eventvar',
  'condition:compare-boolean-eventvar',
  'action:set-eventvar-value',
  'action:add-to-eventvar',
  'action:subtract-from-eventvar',
  'action:set-boolean-eventvar',
  'action:toggle-boolean-eventvar',
  'action:reset-eventvar',
]);

/**
 * Parameter keys whose value is a name, not an expression: object parameters
 * ("object", "object-to-create", Pin's "pin-to", the hierarchy "child"),
 * instance variable, layout and audio file parameters. In editor-saved
 * projects every value under these keys is such a name, so a name there that
 * equals an event variable's is not a use of the variable.
 */
export const NAME_PARAMETER_KEYS: ReadonlySet<string> = new Set([
  'object',
  'object-to-create',
  'pin-to',
  'child',
  'instance-variable',
  'layout',
  'audio-file',
]);

/**
 * What names the deleted function or variable: a "Call function" action, a
 * function map registration, a `Functions.Name(...)` call in an expression,
 * the "variable" parameter of a System event variable ACE, or an expression
 * that uses the variable by name.
 */
export type DeleteReferenceKind = 'callFunction' | 'function-map' | 'expression' | 'event-variable' | 'variable-expression';

export interface DeleteReference {
  kind: DeleteReferenceKind;
  sheet: string;
  /** Path of the condition/action, e.g. "group:Title > block > action:0" (the get_function_map format) */
  path: string;
  /** SID of the event that holds the condition/action */
  sid?: number;
}

export interface DeleteReferenceReport {
  /** Functions defined in the deleted events that are still referenced from outside them */
  functions: Array<{ name: string; references: DeleteReference[] }>;
  /** Event variables declared in the deleted events that are still referenced from outside them */
  variables: Array<{ name: string; references: DeleteReference[] }>;
  /** False when a traversal limit stopped the scan early */
  complete: boolean;
}

type EventRecord = Record<string, unknown>;

function isRecord(value: unknown): value is EventRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function childList(ev: EventRecord): unknown[] {
  return Array.isArray(ev.children) ? ev.children : [];
}

function functionParameterNames(ev: EventRecord): string[] {
  if (ev.eventType !== 'function-block' || !Array.isArray(ev.functionParameters)) return [];
  return ev.functionParameters
    .filter(isRecord)
    .map(p => p.name)
    .filter((n): n is string => typeof n === 'string')
    .map(n => n.toLowerCase());
}

/** True when `event` is, or holds among its sub-events, a function block or an event variable. */
export function definesFunctionsOrVariables(event: object): boolean {
  const stack: Array<{ ev: unknown; depth: number }> = [{ ev: event, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const { ev, depth } = stack.pop()!;
    if (!isRecord(ev) || depth > MAX_DEPTH || ++nodes > MAX_NODES) continue;
    if (ev.eventType === 'function-block' || ev.eventType === 'variable') return true;
    for (const child of childList(ev)) stack.push({ ev: child, depth: depth + 1 });
  }
  return false;
}

/**
 * References the delete of `deleted` (an event object in one of `sheets`,
 * with all its sub-events) would leave unresolved. `sheets` maps each event
 * sheet name to its events; the sheet holding `deleted` must be the same
 * object tree. `functionsName` is the project's name for the built-in
 * Functions object (project.c3proj "functionsName").
 */
export function findReferencesLeftByDelete(
  sheets: ReadonlyMap<string, unknown>,
  deleted: object,
  functionsName: string,
): DeleteReferenceReport {
  const report: DeleteReferenceReport = { functions: [], variables: [], complete: true };

  // ── The deleted subtree and the functions/variables it defines ──
  const removed = new Set<object>();
  const deletedFunctions = new Map<string, string>();
  const deletedVariables = new Map<string, string>();
  const subtree: Array<{ ev: unknown; depth: number }> = [{ ev: deleted, depth: 0 }];
  while (subtree.length > 0) {
    const { ev, depth } = subtree.pop()!;
    if (!isRecord(ev) || depth > MAX_DEPTH || removed.has(ev)) continue;
    removed.add(ev);
    if (removed.size > MAX_NODES) {
      report.complete = false;
      break;
    }
    if (ev.eventType === 'function-block' && typeof ev.functionName === 'string') {
      deletedFunctions.set(ev.functionName.toLowerCase(), ev.functionName);
    } else if (ev.eventType === 'variable' && typeof ev.name === 'string') {
      deletedVariables.set(ev.name.toLowerCase(), ev.name);
    }
    for (const child of childList(ev)) subtree.push({ ev: child, depth: depth + 1 });
  }
  if (deletedFunctions.size === 0 && deletedVariables.size === 0) return report;

  // ── Function blocks and global variables, before and after the delete ──
  const functionsBefore = new Set<string>();
  const functionsAfter = new Set<string>();
  const globalsBefore = new Set<string>();
  const globalsAfter = new Set<string>();
  let nodes = 0;
  for (const events of sheets.values()) {
    if (!Array.isArray(events)) continue;
    for (const ev of events) {
      if (isRecord(ev) && ev.eventType === 'variable' && typeof ev.name === 'string') {
        globalsBefore.add(ev.name.toLowerCase());
        if (!removed.has(ev)) globalsAfter.add(ev.name.toLowerCase());
      }
    }
    const stack: Array<{ list: unknown[]; depth: number }> = [{ list: events, depth: 0 }];
    while (stack.length > 0) {
      const { list, depth } = stack.pop()!;
      if (depth > MAX_DEPTH) continue;
      for (const ev of list) {
        if (++nodes > MAX_NODES) {
          report.complete = false;
          break;
        }
        if (!isRecord(ev)) continue;
        if (ev.eventType === 'function-block' && typeof ev.functionName === 'string') {
          functionsBefore.add(ev.functionName.toLowerCase());
          if (!removed.has(ev)) functionsAfter.add(ev.functionName.toLowerCase());
        }
        stack.push({ list: childList(ev), depth: depth + 1 });
      }
    }
  }

  // ── References outside the deleted subtree ──
  const functionRefs = new Map<string, DeleteReference[]>();
  const variableRefs = new Map<string, DeleteReference[]>();
  const add = (map: Map<string, DeleteReference[]>, key: string, ref: DeleteReference) => {
    const list = map.get(key) ?? [];
    list.push(ref);
    map.set(key, list);
  };
  const functionLost = (name: string) => {
    const key = name.toLowerCase();
    return deletedFunctions.has(key) && functionsBefore.has(key) && !functionsAfter.has(key) ? key : undefined;
  };
  // Cheap test before an expression is tokenized: does it contain a deleted variable's name at all?
  const deletedVariableKeys = [...deletedVariables.keys()];
  const mentionsDeletedVariable = (value: string) => {
    const lower = value.toLowerCase();
    return deletedVariableKeys.some(key => lower.includes(key));
  };

  interface Frame {
    list: unknown[];
    /** Lists of the events enclosing this list, below the top level (for local variables) */
    scopes: unknown[][];
    /** Lower-cased parameters of the function blocks enclosing this list */
    params: string[];
    path: string;
    depth: number;
  }

  nodes = 0;
  for (const [sheet, events] of sheets) {
    if (!Array.isArray(events)) continue;
    const stack: Frame[] = [{ list: events, scopes: [], params: [], path: '', depth: 0 }];
    while (stack.length > 0) {
      const frame = stack.pop()!;
      if (frame.depth > MAX_DEPTH) continue;
      // Variables beside an event are local unless the list is a sheet's top level (globals)
      const localScopes = frame.depth === 0 ? frame.scopes : [...frame.scopes, frame.list];
      for (const ev of frame.list) {
        if (++nodes > MAX_NODES) {
          report.complete = false;
          break;
        }
        if (!isRecord(ev) || removed.has(ev)) continue;
        const params = ev.eventType === 'function-block' ? [...frame.params, ...functionParameterNames(ev)] : frame.params;
        const segment = ev.eventType === 'function-block'
          ? `function:${String(ev.functionName ?? 'unknown')}`
          : ev.eventType === 'group' ? `group:${String(ev.title ?? '')}` : 'block';
        const path = frame.path ? `${frame.path} > ${segment}` : segment;
        const sid = typeof ev.sid === 'number' ? ev.sid : undefined;

        const variableLost = (name: string): string | undefined => {
          const key = name.toLowerCase();
          if (!deletedVariables.has(key) || params.includes(key)) return undefined;
          const inScope = (keep: (v: EventRecord) => boolean) => localScopes.some(list => list.some(v =>
            isRecord(v) && v.eventType === 'variable' && typeof v.name === 'string' && v.name.toLowerCase() === key && keep(v)));
          const before = globalsBefore.has(key) || inScope(() => true);
          const after = globalsAfter.has(key) || inScope(v => !removed.has(v));
          return before && !after ? key : undefined;
        };

        for (const kind of ['condition', 'action'] as const) {
          const aces = kind === 'condition' ? ev.conditions : ev.actions;
          if (!Array.isArray(aces)) continue;
          aces.forEach((ace, i) => {
            if (!isRecord(ace)) return;
            const at = (refKind: DeleteReferenceKind): DeleteReference => ({
              kind: refKind, sheet, path: `${path} > ${kind}:${i}`, ...(sid !== undefined ? { sid } : {}),
            });
            if (deletedFunctions.size > 0) {
              const called = typeof ace.callFunction === 'string' ? functionLost(ace.callFunction) : undefined;
              if (called) add(functionRefs, called, at('callFunction'));
              const mapped = mappedFunctionName(ace, functionsName);
              const mappedKey = mapped !== undefined ? functionLost(mapped) : undefined;
              if (mappedKey) add(functionRefs, mappedKey, at('function-map'));
              for (const value of parameterValues(ace)) {
                if (typeof value !== 'string') continue;
                for (const call of findExpressionCalls(value, functionsName)) {
                  const key = functionLost(call.name);
                  if (key) add(functionRefs, key, at('expression'));
                }
              }
            }
            if (deletedVariables.size > 0) {
              const variableAce = ace.objectClass === 'System' && typeof ace.id === 'string'
                && EVENT_VARIABLE_ACE_IDS.has(`${kind}:${ace.id}`);
              if (variableAce) {
                const variable = isRecord(ace.parameters) ? ace.parameters.variable : undefined;
                const key = typeof variable === 'string' ? variableLost(variable) : undefined;
                if (key) add(variableRefs, key, at('event-variable'));
              }
              // Uses by name in expressions: every string parameter but the names
              const params = ace.parameters;
              const entries: Array<[string | undefined, unknown]> = Array.isArray(params)
                ? params.map(value => [undefined, value])
                : isRecord(params) ? Object.entries(params) : [];
              for (const [paramKey, value] of entries) {
                if (typeof value !== 'string' || !mentionsDeletedVariable(value)) continue;
                if (paramKey !== undefined && (NAME_PARAMETER_KEYS.has(paramKey) || (variableAce && paramKey === 'variable'))) continue;
                for (const name of findExpressionIdentifiers(value)) {
                  const key = variableLost(name);
                  if (key) add(variableRefs, key, at('variable-expression'));
                }
              }
            }
          });
        }

        const children = childList(ev);
        if (children.length > 0) {
          stack.push({ list: children, scopes: localScopes, params, path, depth: frame.depth + 1 });
        }
      }
    }
  }

  for (const [key, references] of functionRefs) report.functions.push({ name: deletedFunctions.get(key)!, references });
  for (const [key, references] of variableRefs) report.variables.push({ name: deletedVariables.get(key)!, references });
  return report;
}

/**
 * The names other event sheets can use of what deleting `event` removes: the
 * functions it holds (function blocks are visible in every sheet) and, when
 * `event` is a variable at the top level of its sheet (`topLevel`), that
 * global variable. Variables in groups, blocks and function blocks are local
 * to their sheet. delete_event_from_sheet searches event sheets it could not
 * parse for these names (issue #55).
 */
export function namesVisibleToOtherSheets(event: object, topLevel: boolean): string[] {
  const names = new Set<string>();
  if (topLevel && isRecord(event) && event.eventType === 'variable' && typeof event.name === 'string') {
    names.add(event.name);
  }
  const stack: Array<{ ev: unknown; depth: number }> = [{ ev: event, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const { ev, depth } = stack.pop()!;
    if (!isRecord(ev) || depth > MAX_DEPTH || ++nodes > MAX_NODES) continue;
    if (ev.eventType === 'function-block' && typeof ev.functionName === 'string') names.add(ev.functionName);
    for (const child of childList(ev)) stack.push({ ev: child, depth: depth + 1 });
  }
  return [...names];
}

/** Number of references in a report. */
export function countDeleteReferences(report: DeleteReferenceReport): number {
  return [...report.functions, ...report.variables].reduce((n, entry) => n + entry.references.length, 0);
}
