/**
 * The event shapes the Construct 3 editor writes, where they differ from what
 * one might guess (issue #32). Counted in editor-saved r449 folder projects:
 *
 * - Else: the System condition { id: "else", objectClass: "System", sid } at
 *   condition index 0 of a block, always after another block (directly, or
 *   with comments between). Conditions after it make an else-if. There is no
 *   block-level "isElse" key.
 * - OR blocks: the block key "isOrBlock": true. Conditions carry no OR flag.
 * - Function calls: { callFunction, sid, disabled?, parameters?: [...] } with no
 *   id/objectClass. Parameters are positional, one per function parameter:
 *   expression strings, and JSON booleans for boolean parameters.
 * - Script actions: { type: "script", language: "javascript", script: [lines], disabled? }.
 * - "disabled" follows "sid" on conditions and actions; "isInverted" is the
 *   last key of a condition (after "parameters").
 * - The built-in Functions object: "Set return value" and the function map
 *   actions are saved on objectClass "Functions" (the project's functionsName),
 *   not on System.
 *
 * Shared by the event tools, the legacy shape scan and validate_project.
 */

import type { Condition, FunctionCallAction } from './types.js';

const MAX_NODES = 100_000;
const MAX_DEPTH = 50;

// ─── Else ────────────────────────────────────────────────────

/** True for the System "else" condition, which Construct 3 saves as condition 0 of an else block. */
export function isElseCondition(cond: unknown): boolean {
  if (typeof cond !== 'object' || cond === null) return false;
  const rec = cond as Record<string, unknown>;
  return rec.id === 'else' && rec.objectClass === 'System';
}

/** True when a stored event is an else block: its first condition is the System "else". */
export function isElseBlock(event: Readonly<Record<string, unknown>>): boolean {
  return Array.isArray(event.conditions) && isElseCondition(event.conditions[0]);
}

/** The System "else" condition, in the editor's key order. */
export function createElseCondition(sid: number): Condition {
  return { id: 'else', objectClass: 'System', sid };
}

// ─── Key order ───────────────────────────────────────────────

/**
 * Set a flag on an event, condition or action the way the editor orders it:
 * right after "sid" (at the end when there is no sid, as on script actions).
 * An existing key keeps its place.
 */
export function setKeyAfterSid(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key in target || !('sid' in target)) {
    target[key] = value;
    return;
  }
  const entries = Object.entries(target);
  for (const k of Object.keys(target)) delete target[k];
  for (const [k, v] of entries) {
    target[k] = v;
    if (k === 'sid') target[key] = value;
  }
}

/**
 * Set a condition's parameters in the editor's key order. In editor saves
 * "isInverted" is the last key of a condition, after "parameters" and
 * "behaviorType": 279 of the 280 inverted conditions with parameters in the
 * r449 projects on record; the other one sits in a block whose SIDs are
 * consecutive numbers (the editor draws SIDs at random), so another tool
 * wrote it. Parameters added to a condition that has none
 * therefore go before an existing "isInverted"; an existing "parameters" key
 * keeps its place.
 */
export function setConditionParameters(cond: Record<string, unknown>, parameters: Record<string, unknown>): void {
  if ('parameters' in cond || !('isInverted' in cond)) {
    cond.parameters = parameters;
    return;
  }
  const { isInverted } = cond;
  delete cond.isInverted;
  cond.parameters = parameters;
  cond.isInverted = isInverted;
}

// ─── Built-in Functions object ───────────────────────────────

/**
 * Name of the built-in Functions object class when project.c3proj has no
 * "functionsName" (it is "Functions" in every project on record that has the key).
 */
export const DEFAULT_FUNCTIONS_OBJECT_NAME = 'Functions';

/**
 * Actions the editor saves on the Functions object class instead of System:
 * "Set return value" (in editor-saved r449 projects, inside function blocks
 * and their sub-events) and the function map actions (Scirra's function-maps
 * example project). The editor's ACE list has them with the System plugin; no
 * condition of the Functions object is on record.
 */
export const FUNCTIONS_OBJECT_ACTION_IDS: ReadonlySet<string> = new Set([
  'set-function-return-value',
  'map-function',
  'map-function-default',
  'call-mapped-function',
]);

/** Function map actions whose "function" parameter names an event function. */
export const FUNCTION_MAP_ACTION_IDS: ReadonlySet<string> = new Set(['map-function', 'map-function-default']);

/**
 * The name the project gives the built-in Functions object: project.c3proj
 * "functionsName", or "Functions" when the key is missing. Conditions and
 * actions of that object are saved with it as their objectClass, and
 * expressions call functions through it ("Functions.MyFunction(1)").
 */
export function functionsObjectName(source: { getProject?: () => unknown } | undefined): string {
  try {
    const project = typeof source?.getProject === 'function' ? source.getProject() : undefined;
    const name = project && typeof project === 'object' ? (project as Record<string, unknown>).functionsName : undefined;
    return typeof name === 'string' && name !== '' ? name : DEFAULT_FUNCTIONS_OBJECT_NAME;
  } catch {
    return DEFAULT_FUNCTIONS_OBJECT_NAME;
  }
}

// ─── Create object (by name) ────────────────────────────────

/**
 * What a System "Create object (by name)" action (id "create-object-by-name")
 * creates: the object type or family name when its "object-name" parameter is
 * one string literal (`"Bullet"`, surrounding spaces allowed; `""` inside is a
 * quote), null when it is any other expression (a name built at runtime), and
 * undefined for any other condition or action. The runtime looks the name up
 * ignoring case. get_asset_usage and the cross-reference index share this rule.
 */
export function createByNameTarget(ace: unknown): string | null | undefined {
  if (!ace || typeof ace !== 'object' || Array.isArray(ace)) return undefined;
  const record = ace as Record<string, unknown>;
  const parameters = record.parameters;
  if (record.id !== 'create-object-by-name' || !parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
    return undefined;
  }
  const expression = (parameters as Record<string, unknown>)['object-name'];
  if (typeof expression !== 'string') return undefined;
  const s = expression.trim();
  if (!s.startsWith('"') || c3StringEnd(s, 0) !== s.length - 1) return null;
  return s.slice(1, -1).replace(/""/g, '"');
}

// ─── Function calls in expressions ──────────────────────────

/** Index of the quote that closes the C3 string literal opening at `start`, or -1. */
export function c3StringEnd(s: string, start: number): number {
  let i = start + 1;
  while (i < s.length) {
    if (s[i] === '"') {
      if (s[i + 1] === '"') {
        i += 2;
        continue;
      }
      return i;
    }
    i++;
  }
  return -1;
}

/** Split the C3 argument list that starts at `start` (just after `(`) into raw expressions. */
function splitC3Args(expr: string, start: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let argStart = start;
  for (let k = start; k < expr.length; k++) {
    const ch = expr[k];
    if (ch === '"') {
      const end = c3StringEnd(expr, k);
      if (end === -1) break;
      k = end;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')' && depth > 0) {
      depth--;
    } else if ((ch === ',' || ch === ')') && depth === 0) {
      const text = expr.slice(argStart, k).trim();
      if (text || ch === ',') args.push(text);
      if (ch === ')') break;
      argStart = k + 1;
    }
  }
  return args;
}

/**
 * Calls to event sheet functions inside a C3 expression, e.g.
 * `Functions.MyFunction(1, 2, 3)` (C3 manual, Functions: "Returning values").
 * Names are lower-cased (function names are case-insensitive). `args` holds
 * the raw argument expressions.
 */
export function findExpressionCalls(expr: string, functionsObject: string): Array<{ name: string; args: string[] }> {
  const calls: Array<{ name: string; args: string[] }> = [];
  const lowerObject = functionsObject.toLowerCase();
  if (!expr.toLowerCase().includes(lowerObject)) return calls;
  let i = 0;
  while (i < expr.length) {
    if (expr[i] === '"') {
      const end = c3StringEnd(expr, i);
      if (end === -1) break;
      i = end + 1;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(expr.slice(i));
    if (!word) {
      i++;
      continue;
    }
    i += word[0].length;
    if (word[0].toLowerCase() !== lowerObject) continue;
    const member = /^\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(expr.slice(i));
    if (!member) continue;
    i += member[0].length;
    const open = /^\s*\(/.exec(expr.slice(i));
    // Scanning resumes inside the argument list, so nested calls are found too
    calls.push({ name: member[1].toLowerCase(), args: open ? splitC3Args(expr, i + open[0].length) : [] });
  }
  return calls;
}

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/y;
const NUMBER = /[0-9][0-9A-Za-z_.]*/y;

/**
 * Bare names in a C3 expression, lower-cased, one entry per use: the names
 * that can refer to an event variable or a function parameter, such as
 * `Score` in `Score * 2` or `max(Score, 1)`. Not returned: anything inside
 * string literals, numbers, names after "." (`Sprite.Score`, `Functions.Name`)
 * and names followed by "." or "(" (object names as in `Sprite.X`, system
 * expressions and calls as in `max(...)`). Parameterless system expressions
 * such as `dt` are returned like any other name.
 */
export function findExpressionIdentifiers(expr: string): string[] {
  const names: string[] = [];
  let previous = ''; // last character before the current token, spaces aside
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === '"') {
      const end = c3StringEnd(expr, i);
      if (end === -1) break;
      i = end + 1;
      previous = '"';
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i++;
      continue;
    }
    NUMBER.lastIndex = i;
    const number = NUMBER.exec(expr);
    if (number) {
      i += number[0].length;
      previous = '0';
      continue;
    }
    IDENTIFIER.lastIndex = i;
    const word = IDENTIFIER.exec(expr);
    if (!word) {
      previous = ch;
      i++;
      continue;
    }
    i += word[0].length;
    let next = i;
    while (next < expr.length && /\s/.test(expr[next])) next++;
    if (previous !== '.' && expr[next] !== '.' && expr[next] !== '(') names.push(word[0].toLowerCase());
    previous = 'a';
  }
  return names;
}

/** Expression parameters of an ACE: `parameters` is an object (ACEs) or an array (function calls). */
export function parameterValues(ace: Readonly<Record<string, unknown>>): unknown[] {
  const params = ace.parameters;
  return Array.isArray(params) ? params : params && typeof params === 'object' ? Object.values(params) : [];
}

/**
 * The event function a function map action ("Map function", "Map function
 * default" of the Functions object) registers: its "function" parameter,
 * which editor saves spell as the function's name. Undefined for other ACEs.
 */
export function mappedFunctionName(ace: Readonly<Record<string, unknown>>, functionsName: string): string | undefined {
  if (ace.objectClass !== functionsName || typeof ace.id !== 'string' || !FUNCTION_MAP_ACTION_IDS.has(ace.id)) return undefined;
  const params = ace.parameters;
  const mapped = params && typeof params === 'object' && !Array.isArray(params)
    ? (params as Record<string, unknown>).function
    : undefined;
  return typeof mapped === 'string' && mapped !== '' ? mapped : undefined;
}

// ─── Function calls ──────────────────────────────────────────

/** Parameters of an event function, from its function block. */
export interface FunctionSignature {
  name: string;
  params: Array<{ name: string; type?: string }>;
  /** Spellings of further function blocks whose name differs from `name` only in case */
  otherSpellings?: string[];
}

/** Event functions by lower-cased name; the first definition wins. */
export function collectFunctionSignatures(sheets: Iterable<{ events?: unknown }>): Map<string, FunctionSignature> {
  const signatures = new Map<string, FunctionSignature>();
  for (const sheet of sheets) {
    const stack: Array<{ list: unknown; depth: number }> = [{ list: sheet.events, depth: 0 }];
    let nodes = 0;
    while (stack.length > 0) {
      const { list, depth } = stack.pop()!;
      if (!Array.isArray(list) || depth > MAX_DEPTH) continue;
      for (const ev of list) {
        if (++nodes > MAX_NODES) break;
        if (!ev || typeof ev !== 'object') continue;
        const rec = ev as Record<string, unknown>;
        if (rec.eventType === 'function-block' && typeof rec.functionName === 'string') {
          const key = rec.functionName.toLowerCase();
          const existing = signatures.get(key);
          if (existing) {
            if (existing.name !== rec.functionName && !existing.otherSpellings?.includes(rec.functionName)) {
              (existing.otherSpellings ??= []).push(rec.functionName);
            }
          } else {
            const raw = Array.isArray(rec.functionParameters) ? rec.functionParameters as unknown[] : [];
            signatures.set(key, {
              name: rec.functionName,
              params: raw
                .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
                .map(p => ({ name: String(p.name ?? ''), ...(typeof p.type === 'string' ? { type: p.type } : {}) })),
            });
          }
        }
        stack.push({ list: rec.children, depth: depth + 1 });
      }
    }
  }
  return signatures;
}

export type FunctionArgument = string | boolean;

/**
 * Turn function call parameters into the editor's positional array. An array
 * is kept (finite numbers become expression strings). An object, the input
 * form older versions accepted and wrote, is mapped only when that is
 * unambiguous: keys "0".."n-1", or exactly the function's parameter names.
 * Throws with an explanation otherwise.
 */
export function toPositionalArguments(
  parameters: unknown,
  signature: FunctionSignature | undefined,
  label: string,
): FunctionArgument[] {
  const normalize = (v: unknown, key: string): FunctionArgument => {
    if (typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    throw new Error(`${label}: argument ${key} must be an expression string or true/false, got ${JSON.stringify(v)}.`);
  };
  if (parameters === undefined || parameters === null) return [];
  if (Array.isArray(parameters)) return parameters.map((v, i) => normalize(v, String(i)));
  if (typeof parameters !== 'object') {
    throw new Error(`${label}: parameters must be an array of arguments in the order of the function's parameters.`);
  }

  const record = parameters as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0) return [];
  if (keys.every(k => /^(0|[1-9]\d*)$/.test(k))) {
    const args: FunctionArgument[] = [];
    for (let i = 0; i < keys.length; i++) {
      if (!(String(i) in record)) {
        throw new Error(`${label}: parameter keys must run from "0" without gaps (missing "${i}"). Pass the arguments as an array instead.`);
      }
      args.push(normalize(record[String(i)], String(i)));
    }
    return args;
  }
  if (!signature) {
    throw new Error(`${label}: parameters are keyed by name, but no function block with that name exists to map them to positions. Pass the arguments as an array in parameter order.`);
  }
  const names = signature.params.map(p => p.name);
  const unknown = keys.filter(k => !names.includes(k));
  const missing = names.filter(n => !(n in record));
  if (unknown.length > 0 || missing.length > 0) {
    const parts = [
      unknown.length > 0 ? `unknown: ${unknown.join(', ')}` : '',
      missing.length > 0 ? `missing: ${missing.join(', ')}` : '',
    ].filter(Boolean).join('; ');
    throw new Error(
      `${label}: parameter names do not match the parameters of function "${signature.name}" ` +
      `(${names.join(', ') || 'none'}): ${parts}. Pass the arguments as an array in parameter order.`,
    );
  }
  return names.map(n => normalize(record[n], `"${n}"`));
}

/**
 * Apply an update to a call's stored arguments. An array replaces them all;
 * an object sets single arguments by position ("0", "1", …) or parameter
 * name. Stored arguments in the old keyed form are converted first. Throws
 * when a key names no argument.
 */
export function mergeCallArguments(
  stored: unknown,
  update: unknown,
  signature: FunctionSignature | undefined,
  label: string,
): FunctionArgument[] {
  if (Array.isArray(update)) return toPositionalArguments(update, signature, label);
  const merged = toPositionalArguments(stored, signature, label);
  const limit = Math.max(merged.length, signature?.params.length ?? 0);
  for (const [key, value] of Object.entries((update ?? {}) as Record<string, unknown>)) {
    const index = /^(0|[1-9]\d*)$/.test(key)
      ? Number(key)
      : signature?.params.findIndex(p => p.name === key) ?? -1;
    if (index === -1) {
      throw new Error(`${label}: "${key}" is neither an argument position nor a parameter name of the called function.`);
    }
    if (index > merged.length || index >= limit) {
      throw new Error(`${label}: argument ${key} is out of range (the call has ${merged.length} argument(s)${signature ? `, the function ${signature.params.length} parameter(s)` : ''}). Pass all arguments as an array instead.`);
    }
    merged[index] = toPositionalArguments([value], signature, label)[0];
  }
  return merged;
}

/**
 * Problems with the arguments of a call, as warnings: editor saves always pass
 * one argument per parameter, a JSON boolean for boolean parameters and an
 * expression string for the others. Whether the editor refuses a mismatch is
 * not verified.
 */
export function checkFunctionCallArguments(
  args: ReadonlyArray<unknown>,
  signature: FunctionSignature | undefined,
  name: string,
  label: string,
): string[] {
  if (!signature) {
    return [`${label}: no function block named "${name}" was found in the project's event sheets. Check the name; functions are defined with add_event_to_sheet (eventType "function").`];
  }
  const warnings: string[] = [];
  if (args.length !== signature.params.length) {
    warnings.push(`${label}: function "${signature.name}" takes ${signature.params.length} parameter(s), but ${args.length} argument(s) were given. Construct 3 saves one argument per parameter.`);
  }
  signature.params.forEach((p, i) => {
    if (i >= args.length) return;
    const isBoolean = typeof args[i] === 'boolean';
    if (p.type === 'boolean' && !isBoolean) {
      warnings.push(`${label}: parameter "${p.name}" of "${signature.name}" is boolean; Construct 3 saves true/false for it, not an expression string.`);
    } else if (p.type !== undefined && p.type !== 'boolean' && isBoolean) {
      warnings.push(`${label}: parameter "${p.name}" of "${signature.name}" is a ${p.type}; pass an expression string, not true/false.`);
    }
  });
  return warnings;
}

/**
 * The function name to write for a call. Editor saves always spell a call
 * like its function block (every call on record does), and whether the editor
 * resolves another case is not verified, so a call whose name differs from
 * the defined one only in case is written with the defined spelling, with a
 * warning. A name that some function block spells exactly is kept.
 */
export function resolveCallName(
  name: string,
  signature: FunctionSignature | undefined,
  label: string,
  warnings: string[],
): string {
  if (!signature || signature.name === name || signature.otherSpellings?.includes(name)) return name;
  warnings.push(`${label}: the function is defined as "${signature.name}", so the call was written with that spelling, as Construct 3 saves calls.`);
  return signature.name;
}

/**
 * The function name to write in the "function" parameter of a function map
 * action ("Map function", "Map function default"). Editor saves pick the
 * function from a list, so they spell it like its function block: a name that
 * differs from the defined one only in case is written with the defined
 * spelling, with a warning. A name no function block has gets a warning: the
 * editor's loader throws "cannot find function" for it (projectResources.js
 * r495.2; whether the project then fails to open is not confirmed).
 */
export function resolveMappedFunctionName(
  name: string,
  signature: FunctionSignature | undefined,
  label: string,
  warnings: string[],
): string {
  if (!signature) {
    warnings.push(`${label}: no function block named "${name}" was found in the project's event sheets. Construct 3 looks the mapped function up by name when it loads the project and throws "cannot find function" when there is none. Check the name; functions are defined with add_event_to_sheet (eventType "function").`);
    return name;
  }
  if (signature.name === name || signature.otherSpellings?.includes(name)) return name;
  warnings.push(`${label}: the function is defined as "${signature.name}", so the function map was written with that spelling, as Construct 3 saves it.`);
  return signature.name;
}

/** A function call action in the editor's key order: callFunction, sid, disabled, parameters. */
export function createFunctionCallAction(
  name: string,
  sid: number,
  args: FunctionArgument[],
  disabled?: boolean,
): FunctionCallAction {
  const act: FunctionCallAction = { callFunction: name, sid };
  if (disabled) act.disabled = true;
  if (args.length > 0) act.parameters = args;
  return act;
}

/** True when a condition/action (input or stored) is a function call. */
export function isFunctionCall(ace: Readonly<Record<string, unknown>>): boolean {
  return typeof ace.callFunction === 'string' && ace.callFunction !== '';
}

/** Keys older versions wrote on function calls that the editor does not write there. */
export const LEGACY_CALL_KEYS = ['id', 'objectClass', 'behaviorType', 'behavior-type'] as const;

/** True when a stored function call is not in the editor's shape (legacy keys, or keyed parameters). */
export function isLegacyFunctionCall(ace: Readonly<Record<string, unknown>>): boolean {
  if (!isFunctionCall(ace)) return false;
  if (LEGACY_CALL_KEYS.some(k => k in ace)) return true;
  return ace.parameters !== undefined && !Array.isArray(ace.parameters);
}

/**
 * Rewrite a stored function call in place into the editor's shape: drops the
 * legacy keys and writes `args` as positional parameters, in the order
 * callFunction, sid, disabled, other keys, parameters.
 */
export function rewriteFunctionCallInPlace(ace: Record<string, unknown>, args: FunctionArgument[]): void {
  const others = Object.entries(ace).filter(([k]) =>
    !['callFunction', 'sid', 'disabled', 'parameters', ...LEGACY_CALL_KEYS].includes(k));
  const { callFunction, sid, disabled } = ace;
  for (const k of Object.keys(ace)) delete ace[k];
  ace.callFunction = callFunction;
  if (sid !== undefined) ace.sid = sid;
  if (disabled !== undefined) ace.disabled = disabled;
  for (const [k, v] of others) ace[k] = v;
  if (args.length > 0) ace.parameters = args;
}

// ─── Script actions ──────────────────────────────────────────

/** Script source as the editor saves it: one array entry per line. */
export function toScriptLines(script: string | readonly string[]): string[] {
  return typeof script === 'string' ? script.split(/\r?\n/) : [...script];
}

/**
 * True when a stored script action ({ type: "script" }) or script event
 * ({ eventType: "script" }) is not in the current editor's shape: its script
 * is one string, or it has no "language" key. That is the shape older
 * Construct 3 releases saved ({ type: "script", script: "<code>" }), and
 * construct3-mcp 1.8.1 and earlier also wrote it.
 */
export function isLegacyScript(rec: Readonly<Record<string, unknown>>): boolean {
  if (rec.type !== 'script' && rec.eventType !== 'script') return false;
  return typeof rec.script === 'string' || !('language' in rec);
}

/**
 * Rewrite a stored script action or script event in place into the editor's
 * shape: the script as lines and a "language" key ("javascript" when there is
 * none), in the order type/eventType, language, script, other keys.
 */
export function rewriteScriptInPlace(rec: Record<string, unknown>): void {
  const head = rec.type === 'script' ? 'type' : 'eventType';
  const script = rec.script as string | string[];
  const language = 'language' in rec ? rec.language : 'javascript';
  const others = Object.entries(rec).filter(([k]) => ![head, 'language', 'script'].includes(k));
  for (const k of Object.keys(rec)) delete rec[k];
  rec[head] = 'script';
  rec.language = language;
  rec.script = toScriptLines(script);
  for (const [k, v] of others) rec[k] = v;
}
