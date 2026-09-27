/**
 * Name rules for event variables (global and local variables declared in
 * event sheets) and function parameters, as the Construct 3 editor applies
 * them when one is added or renamed (the Event variable and Function
 * parameter dialogs run the same checks in the same order, in releases r449
 * and r495.2):
 *
 * 1. The name must come out of the editor's name cleanup unchanged: no
 *    whitespace, none of DISALLOWED_NAME_CHARACTERS, no leading underscore,
 *    not only digits, Unicode NFC.
 * 2. It must not match, ignoring case (names.ts), an event variable or
 *    function parameter in its scope:
 *    - a global variable (declared at the top level of a sheet): every event
 *      variable and function parameter in every event sheet of the project;
 *    - a local variable: every global variable of the project, the variables
 *      and function parameters of each event enclosing it, and every variable
 *      and function parameter below its parent event;
 *    - a function parameter: the same as a local variable declared directly
 *      in its function (the function's other parameters, everything below
 *      the function, the variables and parameters of the events enclosing the
 *      function, and every global variable).
 * 3. It must not match, ignoring case, the name of a System expression.
 *
 * Object type and family names are not compared: the editor accepts event
 * variables named like an object.
 */

import type { C3Event } from './types.js';
import { findNameClash, nameKey } from './names.js';

/**
 * Names of the System plugin's expressions, deprecated ones included, from
 * the editor's plugins/allAces.json of release r495.2 (a superset of r449,
 * which lacks the SYSTEM_EXPRESSIONS_NOT_IN_R449).
 */
export const SYSTEM_EXPRESSION_NAMES: readonly string[] = [
  'abs', 'acos', 'angle', 'anglediff', 'anglelerp', 'anglerotate', 'asin', 'atan',
  'CallMapped', 'CanvasSnapshot', 'CanvasToLayerX', 'CanvasToLayerY', 'ceil', 'choose',
  'chooseindex', 'clamp', 'ColorToHexString', 'cos', 'cosp', 'cpuutilisation', 'cubic',
  'CurrentEventNumber', 'CurrentEventSheetName', 'distance', 'distance3d', 'dt', 'exp',
  'find', 'findCase', 'float', 'floor', 'fps', 'getbit', 'gpuutilisation', 'HexColor',
  'imageloadingprogress', 'ImageMemoryUsage', 'Infinity', 'int', 'LayerAngle', 'LayerIndex',
  'LayerOpacity', 'LayerParallaxX', 'LayerParallaxY', 'LayerScale', 'LayerScaleRate',
  'LayerScrollX', 'LayerScrollY', 'LayerToCanvasX', 'LayerToCanvasY', 'LayerToLayerX',
  'LayerToLayerY', 'LayerZElevation', 'LayoutAngle', 'LayoutHeight', 'LayoutName',
  'LayoutScale', 'LayoutWidth', 'left', 'len', 'lerp', 'ln', 'loadingprogress', 'log10',
  'loopindex', 'lowercase', 'max', 'mid', 'min', 'newline', 'objectcount',
  'OriginalViewportHeight', 'OriginalViewportWidth', 'OriginalWindowHeight',
  'OriginalWindowWidth', 'pi', 'ProjectFileCount', 'ProjectFileNameAt', 'projectid',
  'projectname', 'projectuniqueid', 'projectversion', 'qarp', 'random', 'RegexMatchAt',
  'RegexMatchCount', 'RegexReplace', 'RegexSearch', 'renderer', 'rendererDetail', 'replace',
  'rgb', 'rgba', 'rgba255', 'rgbEx', 'rgbEx255', 'right', 'round', 'roundToDp',
  'SaveStateJSON', 'scrollx', 'scrolly', 'setbit', 'sign', 'sin', 'sqrt', 'str', 'StringSub',
  'tan', 'tickcount', 'time', 'timescale', 'togglebit', 'tokenat', 'tokencount', 'trim',
  'unixtime', 'unlerp', 'uppercase', 'URLDecode', 'URLEncode', 'VanishingPointX',
  'VanishingPointY', 'ViewportBottom', 'ViewportHeight', 'ViewportLeft', 'ViewportMidX',
  'ViewportMidY', 'ViewportRight', 'ViewportTop', 'ViewportWidth', 'wallclockdt',
  'wallclocktime', 'WindowHeight', 'WindowWidth', 'zeropad',
];

/**
 * The System expressions of r495.2 that release r449 does not have: the r449
 * editor accepts event variables with these names, the r495.2 editor refuses
 * them.
 */
export const SYSTEM_EXPRESSIONS_NOT_IN_R449: ReadonlySet<string> = new Set([
  'ColorToHexString', 'distance3d', 'HexColor', 'ProjectFileCount', 'ProjectFileNameAt',
]);

/**
 * Characters the editor's name cleanup removes, besides whitespace: ASCII
 * punctuation, the not sign, the pound sign, the soft hyphen, the ideographic
 * full stop, the full-width comma, parentheses, question mark and colon, and
 * typographic double quotes. Other full-width forms (e.g. U+FF0E, U+FF0F) are
 * accepted by the editor.
 */
export const DISALLOWED_NAME_CHARACTERS: ReadonlySet<string> = new Set([
  ...'.,"()?:\\/;*|\'-`!$%^&+=<>{}[]@#~',
  '\u00AC', '\u00A3', '\u00AD', // not sign, pound sign, soft hyphen
  '\u3002', '\uFF0C', '\uFF08', '\uFF09', '\uFF1F', '\uFF1A', // ideographic full stop; full-width , ( ) ? :
  '\u201C', '\u201D', // typographic double quotes
]);

/** The whitespace characters the editor's name cleanup removes. */
const NAME_WHITESPACE: ReadonlySet<string> = new Set([
  ' ', '\t', '\n', '\r', '\u00A0', '\u0085',
  '\u2000', '\u2001', '\u2002', '\u2003', '\u2004', '\u2005', '\u2006', '\u2007', '\u2008',
  '\u2009', '\u200A', '\u200B', '\u2028', '\u2029', '\u202F', '\u205F', '\u3000',
]);

/**
 * Why the editor would refuse `name` as an event variable name for its
 * characters (a short clause, e.g. 'it contains "-"'), or undefined when the
 * characters are fine.
 */
export function invalidEventVariableNameReason(name: string): string | undefined {
  if (name === '') return 'it is empty';
  for (const ch of name) {
    if (NAME_WHITESPACE.has(ch)) return 'it contains whitespace';
    if (DISALLOWED_NAME_CHARACTERS.has(ch)) {
      const code = ch.codePointAt(0) ?? 0;
      if (code === 0xAD) return 'it contains a soft hyphen (U+00AD)';
      return code > 0x7E
        ? `it contains "${ch}" (U+${code.toString(16).toUpperCase().padStart(4, '0')})`
        : `it contains "${ch}"`;
    }
  }
  if (name !== name.normalize()) return 'it is not in Unicode normalization form C';
  if (name.startsWith('_')) return 'it starts with an underscore';
  if (/^[0-9]+$/.test(name)) return 'it consists only of digits';
  return undefined;
}

/** An event variable or function parameter whose name another variable must not take. */
export interface EventVariableNameUse {
  name: string;
  kind: 'variable' | 'function parameter';
  /** Event sheet declaring it. */
  sheet: string;
}

function childEvents(event: C3Event): C3Event[] {
  const children = (event as { children?: unknown }).children;
  return Array.isArray(children) ? children as C3Event[] : [];
}

/** The function parameters of `event` that have a name (none for other events). */
function namedParameters(event: C3Event): Array<{ name: string }> {
  const params = (event as { functionParameters?: unknown }).functionParameters;
  if (!Array.isArray(params)) return [];
  return params.filter((p): p is { name: string } =>
    typeof p === 'object' && p !== null && typeof (p as { name?: unknown }).name === 'string');
}

function variableName(event: C3Event): string | undefined {
  if (event.eventType !== 'variable') return undefined;
  const name = (event as { name?: unknown }).name;
  return typeof name === 'string' ? name : undefined;
}

/**
 * The event variables and function parameters whose names a variable declared
 * in sheet `sheetName` under `parents` must not take (see the module comment).
 * `parents` are the events enclosing the variable, outermost first; empty for
 * a global variable. For a function parameter, `parents` end with its
 * function. `sheets` holds the events of every event sheet in the project.
 * `self`, the variable event or parameter object being checked, is left out.
 */
export function eventVariableNameUses(
  sheets: ReadonlyMap<string, readonly C3Event[]>,
  sheetName: string,
  parents: readonly C3Event[],
  self?: object,
): EventVariableNameUse[] {
  const uses: EventVariableNameUse[] = [];
  const addVariable = (event: C3Event, sheet: string) => {
    const name = variableName(event);
    if (name !== undefined && event !== self) uses.push({ name, kind: 'variable', sheet });
  };
  const addParameters = (event: C3Event, sheet: string) => {
    for (const param of namedParameters(event)) {
      if (param !== self) uses.push({ name: param.name, kind: 'function parameter', sheet });
    }
  };
  /** Every variable and parameter declared in `events` or below them. */
  const addTree = (events: readonly C3Event[], sheet: string) => {
    for (const event of events) {
      addVariable(event, sheet);
      addParameters(event, sheet);
      addTree(childEvents(event), sheet);
    }
  };

  if (parents.length === 0) {
    for (const [sheet, events] of sheets) addTree(events, sheet);
    return uses;
  }

  // Local variable: all global variables, ...
  for (const [sheet, events] of sheets) {
    for (const event of events) addVariable(event, sheet);
  }
  // ... the variables and parameters of each enclosing event, ...
  for (const parent of parents) {
    addParameters(parent, sheetName);
    for (const event of childEvents(parent)) addVariable(event, sheetName);
  }
  // ... and everything below the parent event (its own variables were added above)
  for (const event of childEvents(parents[parents.length - 1])) {
    addParameters(event, sheetName);
    addTree(childEvents(event), sheetName);
  }
  return uses;
}

/**
 * The events enclosing `target` (compared by identity) in `events`, outermost
 * first; an empty array for a top-level event, undefined when it is not there.
 */
export function findEnclosingEvents(events: readonly C3Event[], target: C3Event): C3Event[] | undefined {
  for (const event of events) {
    if (event === target) return [];
    const inner = findEnclosingEvents(childEvents(event), target);
    if (inner) return [event, ...inner];
  }
  return undefined;
}

/** An event variable or function parameter declared in an event tree. */
export interface EventVariableDeclaration {
  name: string;
  kind: 'variable' | 'function parameter';
  /** The variable event, or the parameter object in its function's functionParameters. */
  declaration: object;
  /** The events enclosing it, outermost first; for a parameter, ending with its function. */
  parents: C3Event[];
}

/**
 * Every event variable and function parameter declared in `events` or below
 * them, in document order. `parents` are the events enclosing `events`.
 */
export function listEventVariableDeclarations(
  events: readonly C3Event[],
  parents: readonly C3Event[] = [],
): EventVariableDeclaration[] {
  const found: EventVariableDeclaration[] = [];
  for (const event of events) {
    const name = variableName(event);
    if (name !== undefined) found.push({ name, kind: 'variable', declaration: event, parents: [...parents] });
    for (const param of namedParameters(event)) {
      found.push({ name: param.name, kind: 'function parameter', declaration: param, parents: [...parents, event] });
    }
    found.push(...listEventVariableDeclarations(childEvents(event), [...parents, event]));
  }
  return found;
}

/** A variable or parameter in copied or moved events whose name clashes in its new scope. */
export interface NewEventVariableNameClash {
  declaration: EventVariableDeclaration;
  use: EventVariableNameUse;
}

/** The use in `uses` whose name equals `name` ignoring case (the exact name first). */
function findUse(name: string, uses: readonly EventVariableNameUse[]): EventVariableNameUse | undefined {
  const match = findNameClash(name, uses.map(u => u.name));
  return match === undefined ? undefined : uses.find(u => u.name === match);
}

/**
 * The name clashes that copying or moving events creates: the variables and
 * function parameters in `copies` whose name matches, ignoring case, a
 * variable or parameter in their new scope, when the same declaration in the
 * original event had no such match in its old place (clashes that were already
 * there are not counted). `before` and `after` hold the events of every event
 * sheet before and after the change; `originals[i]` sits in sheet `fromSheet`
 * of `before` and `copies[i]`, a copy of it, in sheet `toSheet` of `after`.
 */
export function findNewEventVariableNameClashes(
  before: ReadonlyMap<string, readonly C3Event[]>,
  fromSheet: string,
  originals: readonly C3Event[],
  after: ReadonlyMap<string, readonly C3Event[]>,
  toSheet: string,
  copies: readonly C3Event[],
): NewEventVariableNameClash[] {
  const clashes: NewEventVariableNameClash[] = [];
  copies.forEach((copy, i) => {
    const original = originals[i];
    const newPlace = listEventVariableDeclarations([copy], findEnclosingEvents(after.get(toSheet) ?? [], copy) ?? []);
    const oldPlace = original === undefined
      ? []
      : listEventVariableDeclarations([original], findEnclosingEvents(before.get(fromSheet) ?? [], original) ?? []);
    newPlace.forEach((declaration, j) => {
      const use = findUse(declaration.name, eventVariableNameUses(after, toSheet, declaration.parents, declaration.declaration));
      if (!use) return;
      const old = oldPlace[j];
      if (old && findUse(old.name, eventVariableNameUses(before, fromSheet, old.parents, old.declaration))) return;
      clashes.push({ declaration, use });
    });
  });
  return clashes;
}

/** Why the editor would refuse an event variable name, in the order its dialog checks. */
export type EventVariableNameProblem =
  | { problem: 'invalid'; reason: string }
  | { problem: 'in-use'; use: EventVariableNameUse }
  | { problem: 'system-expression'; expression: string };

/**
 * The first reason the editor would refuse `name` for an event variable whose
 * scope holds `uses` (from eventVariableNameUses), or undefined when it would
 * accept it. When renaming, pass the variable's current name as `ownName`:
 * changing only the case of its own name is not a clash.
 */
export function findEventVariableNameProblem(
  name: string,
  uses: readonly EventVariableNameUse[],
  ownName?: string,
): EventVariableNameProblem | undefined {
  const reason = invalidEventVariableNameReason(name);
  if (reason) return { problem: 'invalid', reason };
  if (ownName === undefined || nameKey(ownName) !== nameKey(name)) {
    const use = findUse(name, uses);
    if (use) return { problem: 'in-use', use };
  }
  const expression = findNameClash(name, SYSTEM_EXPRESSION_NAMES);
  if (expression !== undefined) return { problem: 'system-expression', expression };
  return undefined;
}
