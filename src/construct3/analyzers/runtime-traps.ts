/**
 * Runtime trap detection for Construct 3 event sheets.
 *
 * Finds event logic that loads fine in the editor but hangs or throws while
 * the game runs:
 *
 * 1. signal-pairing — System "Wait for signal" tags that nothing ever
 *    signals (the wait can never finish), signals nobody waits for or listens
 *    to, "On signal" triggers nothing raises, and tags that are not string
 *    literals (cannot be analyzed statically). Signals raised from scripts via
 *    runtime.signal("tag") count as emitters. A tag that is just a function
 *    parameter (a "signal helper" function) is resolved through the literal
 *    arguments at the function's call sites; a function registered in a
 *    function map (Functions object "Map function") can also be called by
 *    "Call mapped function" with any arguments, so its forwarded tag may be
 *    anything. A non-literal tag that starts
 *    with a literal (`"button_" & Button.type`) may produce any tag with that
 *    prefix.
 * 2. signal-order — a System "Wait for signal" whose tag was already raised
 *    before the wait starts: by a Signal earlier in the same event (or in a
 *    parent event), or synchronously inside a function the event called
 *    first. Signal only resumes waits that already exist, so such a wait
 *    misses it. A function raises a tag synchronously when a Signal is
 *    reached on an unconditional path without passing a Wait / Wait for
 *    signal / Wait for previous actions in its own event or an ancestor
 *    within the function (a Wait defers only the rest of its own event, so
 *    later sibling sub-events still run during the call). Calls are followed
 *    transitively; scripts are not followed.
 * 3. script-function-parameter — script actions inside a function or custom
 *    action that use one of its parameters as a bare JavaScript identifier.
 *    Event parameters are only reachable as `localVars.<name>` (C3 manual,
 *    "Scripts in event sheets"), so the bare name throws ReferenceError at
 *    runtime.
 *
 * Disabled events, conditions and actions (`"disabled": true`, toggled with D
 * in the editor) do not run and are skipped. Per-instance signals (the common
 * Signal / Wait for signal actions and On signal condition of objects) are
 * not analyzed.
 *
 * Locations are paths of event-type segments ("function:Name > block >
 * action:2", `action:N` being the 0-based actions[] index). Entries of
 * `related` and of the signal map end with the SID of the event that holds
 * the ACE ("(sid 123)"); an event without a SID gets its index among its
 * siblings on its segment ("block#2") so paths stay unique.
 *
 * Rules from komabear/c3-skill (MIT). ACE ids and parameter names were
 * checked against editor-saved projects and the C3 manual.
 */

import type { Construct3ProjectReader } from '../project-reader.js';
import type { C3Event, FileFolder, FileFolderSubfolder, FileItem } from '../types.js';
import {
  getScriptSource,
  tokenizeScript,
  findBareIdentifierUses,
  findScriptFunctionCalls,
  findScriptSignalCalls,
  collectImportsForEventsNames,
} from './script-scan.js';
import {
  functionsObjectName,
  FUNCTION_MAP_ACTION_IDS,
  c3StringEnd,
  findExpressionCalls,
  parameterValues,
} from '../event-shapes.js';

// System ACEs (objectClass "System"); each takes one `tag` expression parameter.
const SIGNAL_ACTION_ID = 'signal';
const WAIT_FOR_SIGNAL_ACTION_ID = 'wait-for-signal';
const ON_SIGNAL_CONDITION_ID = 'on-signal';
/** System actions that defer the rest of their event (remaining actions and sub-events) */
const WAIT_ACTION_IDS = new Set(['wait', WAIT_FOR_SIGNAL_ACTION_ID, 'wait-for-previous-actions']);
/** Functions object action that calls the function a function map holds for a string (chosen at runtime) */
const CALL_MAPPED_FUNCTION_ACTION_ID = 'call-mapped-function';

const MAX_NODES = 100_000;
const MAX_DEPTH = 50;
const SUMMARY_ISSUE_LIMIT = 10;
const RELATED_LIMIT = 10;
const SUMMARY_RELATED_LIMIT = 3;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type RuntimeTrapCheck = 'signal-pairing' | 'signal-order' | 'script-function-parameter';

export interface RuntimeTrapIssue {
  severity: 'warning' | 'info';
  check: RuntimeTrapCheck;
  /** "Sheet > function:Name > block > action:2" (action:N is the 0-based actions[] index) */
  location: string;
  /** SID of the event that holds the action/condition (script actions have no SID of their own) */
  eventSid?: number;
  message: string;
  /** How to fix it (omitted with detail: summary to keep the output small) */
  suggestion?: string;
  /** Signal tag (signal checks only; null for non-literal tags) */
  tag?: string | null;
  /**
   * Other locations involved (e.g. every wait for the same tag), capped. Each
   * entry is "Sheet > path [how] (sid N)", N being the SID of the event that
   * holds the ACE.
   */
  related?: string[];
}

/** Every site of one tag; entries are formatted like RuntimeTrapIssue.related, ending with "(sid N)". */
export interface SignalUsage {
  tag: string;
  emitters: string[];
  waiters: string[];
  listeners: string[];
}

export interface RuntimeTrapsResult {
  summary: {
    warning: number;
    info: number;
    sheetsScanned: number;
    scriptsScanned: number;
    signalTags: number;
  };
  issues: RuntimeTrapIssue[];
  /** Full signal map (detail: full only) */
  signals?: SignalUsage[];
  notes: string[];
}

type SignalRole = 'emitter' | 'waiter' | 'listener';
type ScriptLanguage = 'javascript' | 'typescript';

interface Site {
  sheet: string;
  location: string;
  eventSid?: number;
}

interface SignalSite extends Site {
  /** How the tag is used, for messages: 'Signal', 'Wait for signal', 'runtime.signal()', ... */
  via: string;
}

interface DynamicSite extends SignalSite {
  role: SignalRole;
  /** Original tag expression ('' for script arguments) */
  expression: string;
  /** Texts every produced tag starts with; null when the tag can be anything */
  prefixes: string[] | null;
}

interface TagEntry {
  tag: string;
  emitter: SignalSite[];
  waiter: SignalSite[];
  listener: SignalSite[];
}

/** A call site's argument at a position: its literal value, or the prefix of a non-literal */
interface CallArg {
  tag: string | null;
  prefix: string | null;
}

interface CallSite extends Site {
  arg: (index: number) => CallArg;
}

interface ParamScope {
  /** Label for messages, e.g. `function "Foo"` */
  owner: string;
  /** All parameter names visible here (own + enclosing) */
  names: string[];
  /** Nearest enclosing function block and its parameters in call order */
  functionName?: string;
  functionParams?: string[];
}

/**
 * Parse a C3 expression that is exactly one string literal. Event JSON stores
 * the expression text, so the tag "hit" is saved as "\"hit\"". Inside C3
 * strings a double quote is written as two double quotes; backslash is not an
 * escape character (C3 manual, Expressions). Returns null for anything else
 * (variables, concatenations, numbers).
 */
export function parseC3StringLiteral(expr: unknown): string | null {
  if (typeof expr !== 'string') return null;
  const s = expr.trim();
  if (s.length < 2 || s[0] !== '"') return null;
  const end = c3StringEnd(s, 0);
  return end === s.length - 1 ? s.slice(1, end).replace(/""/g, '"') : null;
}

/** Remove C3 string literals from an expression (keeps the quotes as `""`). */
function stripC3Strings(expr: string): string {
  let out = '';
  for (let i = 0; i < expr.length; i++) {
    if (expr[i] === '"') {
      const end = c3StringEnd(expr, i);
      if (end === -1) return out;
      out += '""';
      i = end;
    } else {
      out += expr[i];
    }
  }
  return out;
}

/**
 * For a non-literal C3 tag written as `"prefix" & ...`, the text every value
 * starts with: `&` concatenates when either side is a string (C3 manual,
 * Expressions). Null when the expression does not start that way or contains
 * an operator that could pick another value (`?:`, comparisons, `|`).
 */
export function c3ConcatPrefix(expr: unknown): string | null {
  if (typeof expr !== 'string') return null;
  const s = expr.trim();
  if (s[0] !== '"') return null;
  const end = c3StringEnd(s, 0);
  if (end === -1) return null;
  const rest = s.slice(end + 1);
  if (!/^\s*&/.test(rest) || /[?:=<>|]/.test(stripC3Strings(rest))) return null;
  const prefix = s.slice(1, end).replace(/""/g, '"');
  return prefix || null;
}

/** Argument accessor for positional argument expressions of an event function call. */
function eventArg(expressions: unknown[]): (i: number) => CallArg {
  return (i: number): CallArg => ({
    tag: parseC3StringLiteral(expressions[i]),
    prefix: c3ConcatPrefix(expressions[i]),
  });
}


/**
 * Scan event sheets for runtime traps. Signal tags are matched across ALL
 * sheets; `eventsheet` only limits which issues are reported.
 */
export async function findRuntimeTraps(
  reader: Construct3ProjectReader,
  options: {
    eventsheet?: string;
    detail?: 'summary' | 'standard' | 'full';
  } = {},
): Promise<RuntimeTrapsResult> {
  const detail = options.detail || 'standard';
  const sheets = await reader.readAllEventSheets();
  const filter = options.eventsheet;
  if (filter && !sheets.has(filter)) {
    throw new Error(`Event sheet "${filter}" not found. Available: ${[...sheets.keys()].join(', ') || '(none)'}`);
  }

  const notes: string[] = [
    'Signal tags are compared case-insensitively.',
    'Only event sheets are scanned; runtime.signal() calls in script files are not seen, nor calls on a runtime '
      + 'that a script receives as a function parameter.',
    'Disabled events, conditions and actions are skipped. Per-instance signals (object Signal / Wait for signal / On signal) are not analyzed.',
    'See construct3://docs/pitfalls for the underlying runtime behavior.',
  ];

  // Sheets the project lists but that could not be read or parsed
  const listed = typeof reader.listEventSheets === 'function' ? await reader.listEventSheets() : [...sheets.keys()];
  const skippedSheets = listed.filter(name => !sheets.has(name));
  if (skippedSheets.length > 0) {
    notes.push(`${skippedSheets.length} event sheet(s) could not be read and were not scanned: ${skippedSheets.join(', ')}. `
      + 'Waits without a matching Signal are reported as info, since the Signal may be in one of them.');
  }

  const functionsObject = functionsObjectName(reader);
  const importGlobals = await importsForEventsGlobals(reader, notes);

  const tags = new Map<string, TagEntry>(); // key: lower-cased tag
  const dynamic: DynamicSite[] = [];
  /** Signal ACEs whose tag is a parameter of the enclosing function */
  const forwarded: Array<SignalSite & { role: SignalRole; expression: string; functionName: string; paramIndex: number }> = [];
  /** Function call sites by lower-cased name (C3 function names are case-insensitive) */
  const callSites = new Map<string, CallSite[]>();
  /** Functions registered in a function map (lower-cased): Call mapped function can call them with any arguments */
  const mappedFunctions = new Set<string>();
  let mappedCalls = 0;
  const issues: RuntimeTrapIssue[] = [];
  const walkWarnings: string[] = [];
  let scriptsScanned = 0;
  let sheetsScanned = 0;

  const addSignal = (role: SignalRole, tag: string, site: SignalSite) => {
    const key = tag.toLowerCase();
    let entry = tags.get(key);
    if (!entry) {
      entry = { tag, emitter: [], waiter: [], listener: [] };
      tags.set(key, entry);
    }
    entry[role].push(site);
  };

  const addCallSite = (name: string, site: Site, arg: (index: number) => CallArg) => {
    const key = name.toLowerCase();
    const list = callSites.get(key) ?? [];
    list.push({ ...site, arg });
    callSites.set(key, list);
  };

  /** Record `Functions.Name(...)` calls found in an ACE's expression parameters. */
  const scanExpressions = (ace: Record<string, unknown>, site: Site) => {
    for (const value of parameterValues(ace)) {
      if (typeof value !== 'string') continue;
      for (const call of findExpressionCalls(value, functionsObject)) {
        addCallSite(call.name, site, eventArg(call.args));
      }
    }
  };

  const recordTagParam = (
    role: SignalRole,
    via: string,
    ace: Record<string, unknown>,
    site: Site,
    scope: ParamScope | null,
  ) => {
    const params = ace.parameters as Record<string, unknown> | undefined;
    const raw = params?.tag;
    const tag = parseC3StringLiteral(raw);
    if (tag !== null) {
      addSignal(role, tag, { ...site, via });
      return;
    }
    const expression = typeof raw === 'string' ? raw.trim() : String(raw);
    const paramIndex = scope?.functionParams && IDENTIFIER.test(expression)
      ? scope.functionParams.indexOf(expression)
      : -1;
    if (scope?.functionName && paramIndex !== -1) {
      forwarded.push({ ...site, via, role, expression, functionName: scope.functionName, paramIndex });
    } else {
      const prefix = c3ConcatPrefix(raw);
      dynamic.push({ ...site, via, role, expression, prefixes: prefix ? [prefix] : null });
    }
  };

  for (const [sheetName, sheet] of sheets) {
    if (!Array.isArray(sheet.events)) continue;
    sheetsScanned++;
    const inFilter = !filter || sheetName === filter;

    walkEvents(sheetName, sheet.events, walkWarnings, {
      condition(cond, location, eventSid, scope) {
        const site = { sheet: sheetName, location, eventSid };
        scanExpressions(cond, site);
        if (cond.objectClass === 'System' && cond.id === ON_SIGNAL_CONDITION_ID) {
          recordTagParam('listener', 'On signal', cond, site, scope);
        }
      },
      action(action, location, eventSid, scope) {
        const site = { sheet: sheetName, location, eventSid };
        scanExpressions(action, site);
        // Function calls store positional argument expressions in a `parameters` array
        if (typeof action.callFunction === 'string') {
          addCallSite(action.callFunction, site, eventArg(Array.isArray(action.parameters) ? action.parameters : []));
        }
        // Function maps of the Functions object: which functions a mapped call may reach
        if (action.objectClass === functionsObject && typeof action.id === 'string') {
          if (FUNCTION_MAP_ACTION_IDS.has(action.id)) {
            const params = action.parameters;
            const mapped = params && typeof params === 'object' && !Array.isArray(params)
              ? (params as Record<string, unknown>).function
              : undefined;
            if (typeof mapped === 'string' && mapped) mappedFunctions.add(mapped.toLowerCase());
          } else if (action.id === CALL_MAPPED_FUNCTION_ACTION_ID) {
            mappedCalls++;
          }
        }
        if (action.objectClass !== 'System') return;
        if (action.id === SIGNAL_ACTION_ID) {
          recordTagParam('emitter', 'Signal', action, site, scope);
        } else if (action.id === WAIT_FOR_SIGNAL_ACTION_ID) {
          recordTagParam('waiter', 'Wait for signal', action, site, scope);
        }
      },
      script(holder, location, eventSid, scope) {
        const source = getScriptSource(holder.script);
        if (source === null) return;
        scriptsScanned++;
        const tokens = tokenizeScript(source);

        for (const call of findScriptSignalCalls(tokens)) {
          const role: SignalRole = call.method === 'signal' ? 'emitter' : 'waiter';
          const via = `runtime.${call.method}()`;
          const site = { sheet: sheetName, location: `${location} (script line ${call.line})`, eventSid };
          if (call.tag !== null) addSignal(role, call.tag, { ...site, via });
          else dynamic.push({ ...site, via, role, expression: '', prefixes: call.prefix ? [call.prefix] : null });
        }
        for (const call of findScriptFunctionCalls(tokens)) {
          const site = { sheet: sheetName, location: `${location} (script line ${call.line})`, eventSid };
          addCallSite(call.name, site, i => ({ tag: call.args[i] ?? null, prefix: null }));
        }

        if (!scope || !inFilter) return;
        const language = holder.language === 'typescript' || holder.language === 'javascript'
          ? holder.language as ScriptLanguage
          : undefined;
        const uses = findBareIdentifierUses(tokens, scope.names, {
          typescript: language === 'typescript',
          // Imports for events are language-specific; an unmarked script gets both
          globals: language ? importGlobals[language] : [...importGlobals.javascript, ...importGlobals.typescript],
        });
        for (const use of uses) {
          issues.push({
            severity: 'warning',
            check: 'script-function-parameter',
            location: `${sheetName} > ${location}`,
            eventSid,
            message: `Script in ${scope.owner} uses parameter "${use.name}" as a bare JavaScript identifier `
              + `(script line ${use.lines.join(', ')}). Event parameters are not JS variables: this throws `
              + 'ReferenceError at runtime (unless an unrelated global has that name), and the rest of the '
              + "event's actions may not run.",
            suggestion: `Use localVars.${use.name} instead (function parameters and local variables are exposed on `
              + 'localVars; global variables on runtime.globalVars).',
          });
        }
      },
    });
  }

  // ─── Resolve tags forwarded through function parameters ──
  for (const f of forwarded) {
    const calls = callSites.get(f.functionName.toLowerCase()) ?? [];
    // No call site found, or a function map lets Call mapped function pass any argument: the tag can be anything
    let prefixes: string[] | null = calls.length === 0 || mappedFunctions.has(f.functionName.toLowerCase()) ? null : [];
    for (const call of calls) {
      const arg = call.arg(f.paramIndex);
      if (arg.tag !== null) {
        addSignal(f.role, arg.tag, {
          sheet: call.sheet,
          location: call.location,
          eventSid: call.eventSid,
          via: `${f.via} via ${f.functionName}()`,
        });
      } else if (prefixes !== null) {
        prefixes = arg.prefix ? [...prefixes, arg.prefix] : null;
      }
    }
    if (prefixes === null || prefixes.length > 0) dynamic.push({ ...f, prefixes });
  }

  // ─── Signal pairing ─────────────────────────────────────
  const relatedLimit = detail === 'summary' ? SUMMARY_RELATED_LIMIT : RELATED_LIMIT;
  const scriptFilesCaveat = 'Script files are not scanned; if one raises this tag, ignore this finding.';
  const firstIn = (sites: SignalSite[]) => (filter ? sites.find(s => s.sheet === filter) : sites[0]);
  const fmt = formatSite;
  const cap = (list: string[]) => (list.length > relatedLimit
    ? [...list.slice(0, relatedLimit), `... and ${list.length - relatedLimit} more`]
    : list);
  /** Can this non-literal tag produce `tag`? */
  const mayProduce = (d: DynamicSite, tag: string) => {
    const lower = tag.toLowerCase();
    return d.prefixes === null || d.prefixes.some(p => lower.startsWith(p.toLowerCase()));
  };
  const dynamicEmitters = dynamic.filter(d => d.role === 'emitter');
  const dynamicConsumers = dynamic.filter(d => d.role !== 'emitter');

  for (const entry of tags.values()) {
    const hasEmitter = entry.emitter.length > 0;
    const possibleEmitters = hasEmitter ? [] : dynamicEmitters.filter(d => mayProduce(d, entry.tag));

    if (entry.waiter.length > 0 && !hasEmitter) {
      const at = firstIn(entry.waiter);
      if (at) {
        // With a non-literal Signal that may produce this tag, or unreadable sheets, "never" cannot be proven
        const certain = possibleEmitters.length === 0 && skippedSheets.length === 0;
        let message: string;
        if (certain) {
          message = `Wait for signal "${entry.tag}" can never finish: no Signal action or runtime.signal() call `
            + `with this tag exists in any event sheet (${entry.waiter.length} wait(s) affected).`;
        } else if (possibleEmitters.length > 0) {
          message = `Wait for signal "${entry.tag}" has no Signal with this literal tag (${entry.waiter.length} wait(s) `
            + `affected). It can only finish if one of the ${possibleEmitters.length} signal(s) with a `
            + 'non-literal tag that may produce it does so at runtime.';
        } else {
          message = `Wait for signal "${entry.tag}" has no Signal with this literal tag in the event sheets that `
            + `could be read (${entry.waiter.length} wait(s) affected); ${skippedSheets.length} sheet(s) could not be read.`;
        }
        issues.push({
          severity: certain ? 'warning' : 'info',
          check: 'signal-pairing',
          location: `${at.sheet} > ${at.location}`,
          eventSid: at.eventSid,
          tag: entry.tag,
          message,
          suggestion: `Add Signal "${entry.tag}" where the awaited work completes, or fix the tag spelling `
            + `(tags compare case-insensitively). ${scriptFilesCaveat}`,
          related: cap([...entry.waiter.map(fmt), ...possibleEmitters.map(fmt)]),
        });
      }
    }

    // `"button_" & Button.type` + On signal "button_ok": a dispatch pattern, not a dead trigger
    const prefixMatched = possibleEmitters.some(d => d.prefixes !== null);
    if (entry.listener.length > 0 && !hasEmitter && !prefixMatched) {
      const at = firstIn(entry.listener);
      if (at) {
        issues.push({
          severity: 'info',
          check: 'signal-pairing',
          location: `${at.sheet} > ${at.location}`,
          eventSid: at.eventSid,
          tag: entry.tag,
          message: possibleEmitters.length > 0
            ? `On signal "${entry.tag}" has no Signal with this literal tag. It may be raised by one of the `
              + `${possibleEmitters.length} signal(s) with a non-literal tag at runtime.`
            : `On signal "${entry.tag}" never fires unless something outside the event sheets signals it: `
              + 'no Signal with this literal tag was found.',
          suggestion: `Raise it with Signal "${entry.tag}" or remove the dead trigger. ${scriptFilesCaveat}`,
          related: cap([...entry.listener.map(fmt), ...possibleEmitters.map(fmt)]),
        });
      }
    }

    if (hasEmitter && entry.waiter.length === 0 && entry.listener.length === 0) {
      const possibleConsumers = dynamicConsumers.filter(d => mayProduce(d, entry.tag));
      const at = firstIn(entry.emitter);
      if (at && !possibleConsumers.some(d => d.prefixes !== null)) {
        issues.push({
          severity: 'info',
          check: 'signal-pairing',
          location: `${at.sheet} > ${at.location}`,
          eventSid: at.eventSid,
          tag: entry.tag,
          message: `Signal "${entry.tag}" is raised but nothing waits for it or listens to it.`
            + (possibleConsumers.length > 0
              ? ` ${possibleConsumers.length} wait(s)/listener(s) with non-literal tags might match it.`
              : ''),
          suggestion: 'Check the tag for typos, or remove the unused Signal. Signals are not queued, so a wait '
            + 'that starts after the signal will not see it.',
          related: cap(entry.emitter.map(fmt)),
        });
      }
    }
  }

  if (mappedCalls > 0 || mappedFunctions.size > 0) {
    notes.push(`Function maps: ${mappedCalls} Call mapped function action(s) call a function chosen at runtime, which `
      + 'signal-order does not follow; parameters of the functions in a function map are treated as able to hold any value.');
  }

  // ─── Signal order ───────────────────────────────────────
  const orderIssues = findSignalOrderIssues(sheets, filter, functionsObject, cap);
  if (orderIssues.length > 0) {
    issues.push(...orderIssues);
    notes.push('signal-order follows Signal actions and function calls (actions and Functions.Name() in expressions) '
      + 'on unconditional paths only: a Signal behind a condition, and anything done in scripts, is not followed, '
      + 'so a conditional Signal can still race its wait.');
  }

  for (const d of dynamic) {
    if (filter && d.sheet !== filter) continue;
    issues.push({
      severity: 'info',
      check: 'signal-pairing',
      location: `${d.sheet} > ${d.location}`,
      eventSid: d.eventSid,
      tag: null,
      message: `${d.via} uses a tag that is not a string literal${d.expression ? ` (${d.expression})` : ''}, `
        + 'so it cannot be analyzed statically.'
        + (d.prefixes ? ` Its values start with ${d.prefixes.map(p => `"${p}"`).join(' or ')}.` : ''),
      suggestion: 'Make sure every value it can take has a matching Signal / Wait for signal, or use a literal tag.',
    });
  }

  // Warnings first, then by location for stable output
  const order = { warning: 0, info: 1 };
  issues.sort((a, b) => order[a.severity] - order[b.severity] || a.location.localeCompare(b.location));

  // Summary: first issues only, without suggestions (the <2K-token contract of detail levels)
  const shown = detail === 'summary'
    ? issues.slice(0, SUMMARY_ISSUE_LIMIT).map(({ suggestion: _omitted, ...issue }) => issue)
    : issues;
  if (shown.length < issues.length) {
    notes.push(`Showing the first ${shown.length} of ${issues.length} issues (warnings first); `
      + 'use detail "standard" for all of them with suggestions.');
  }

  const result: RuntimeTrapsResult = {
    summary: {
      warning: issues.filter(i => i.severity === 'warning').length,
      info: issues.filter(i => i.severity === 'info').length,
      sheetsScanned,
      scriptsScanned,
      signalTags: tags.size,
    },
    issues: shown,
    notes: [...notes, ...walkWarnings],
  };

  if (detail === 'full') {
    result.signals = [...tags.values()]
      .sort((a, b) => a.tag.localeCompare(b.tag))
      .map(e => ({
        tag: e.tag,
        emitters: e.emitter.map(fmt),
        waiters: e.waiter.map(fmt),
        listeners: e.listener.map(fmt),
      }));
  }

  return result;
}

// ─── Project lookups ────────────────────────────────────────

/**
 * Names the project's "Imports for events" scripts make available to script
 * actions and blocks, per language (C3 manual, "Scripts in event sheets":
 * these scripts are language-specific). Scripts are listed in project.c3proj
 * under rootFileFolders.script with `"script-info": {"purpose": "imports-for-events"}`.
 */
async function importsForEventsGlobals(
  reader: Construct3ProjectReader,
  notes: string[],
): Promise<Record<ScriptLanguage, Set<string>>> {
  const globals: Record<ScriptLanguage, Set<string>> = { javascript: new Set(), typescript: new Set() };
  let folder: FileFolder | undefined;
  try {
    folder = typeof reader.getProject === 'function' ? reader.getProject().rootFileFolders?.script : undefined;
  } catch {
    return globals;
  }
  if (!folder || typeof reader.readScriptFile !== 'function') return globals;

  const found: Array<{ path: string; item: FileItem }> = [];
  const walk = (f: FileFolder | FileFolderSubfolder, prefix: string, depth: number) => {
    if (depth > MAX_DEPTH) return;
    for (const item of Array.isArray(f.items) ? f.items : []) {
      const purpose = item?.['script-info']?.purpose ?? item?.['file-info']?.purpose;
      if (purpose === 'imports-for-events' && typeof item.name === 'string') found.push({ path: prefix + item.name, item });
    }
    for (const sub of Array.isArray(f.subfolders) ? f.subfolders : []) {
      if (sub && typeof sub.name === 'string') walk(sub, `${prefix}${sub.name}/`, depth + 1);
    }
  };
  walk(folder, '', 0);

  for (const { path, item } of found) {
    const language: ScriptLanguage = item.type === 'application/typescript' || path.endsWith('.ts')
      ? 'typescript'
      : 'javascript';
    try {
      const source = await reader.readScriptFile(path);
      for (const name of collectImportsForEventsNames(source)) globals[language].add(name);
    } catch {
      notes.push(`Imports-for-events script "${path}" could not be read; its names are not treated as in scope.`);
    }
  }
  return globals;
}

// ─── Event walking ──────────────────────────────────────────

interface WalkVisitor {
  condition(cond: Record<string, unknown>, location: string, eventSid: number | undefined, scope: ParamScope | null): void;
  action(action: Record<string, unknown>, location: string, eventSid: number | undefined, scope: ParamScope | null): void;
  /** A script action (`{type: "script"}`) or script block event (`eventType: "script"`) */
  script(holder: Record<string, unknown>, location: string, eventSid: number | undefined, scope: ParamScope | null): void;
}

/**
 * Parameter names declared by an event, in call order. Function blocks and
 * custom action blocks (`eventType: "custom-ace-block"`) both save them as
 * `functionParameters`.
 */
function ownParameterNames(event: Record<string, unknown>): string[] {
  const list = event.functionParameters;
  if (!Array.isArray(list)) return [];
  const names: string[] = [];
  for (const p of list) {
    const name = (p as Record<string, unknown> | null)?.name;
    if (typeof name === 'string' && name) names.push(name);
  }
  return names;
}

/** `Player.Hurt` for a custom action block (`objectClass` + `aceName`). */
function customAceName(event: Record<string, unknown>): string {
  const objectClass = typeof event.objectClass === 'string' ? event.objectClass : 'unknown';
  const aceName = typeof event.aceName === 'string' ? event.aceName : 'unknown';
  return `${objectClass}.${aceName}`;
}

function segmentFor(event: Record<string, unknown>): string {
  switch (event.eventType) {
    case 'block': return 'block';
    case 'function-block': return `function:${typeof event.functionName === 'string' ? event.functionName : 'unknown'}`;
    case 'custom-ace-block': return `custom-${event.aceType === 'action' ? 'action' : 'ace'}:${customAceName(event)}`;
    case 'group': return `group:${typeof event.title === 'string' ? event.title : 'untitled'}`;
    default: return String(event.eventType ?? 'event');
  }
}

/**
 * Path segment of an event. An event without a SID (hand-written JSON) gets
 * its index among its siblings ("block#2"), so sibling paths stay unique.
 */
function segmentAt(event: Record<string, unknown>, index: number): string {
  const segment = segmentFor(event);
  return typeof event.sid === 'number' ? segment : `${segment}#${index}`;
}

/** "Sheet > path [how] (sid N)": the form of `related` and signal map entries. */
function formatSite(s: SignalSite): string {
  return `${s.sheet} > ${s.location} [${s.via}]${s.eventSid !== undefined ? ` (sid ${s.eventSid})` : ''}`;
}

/** Iterative traversal (like the index builder) so deep sheets cannot overflow the stack. */
function walkEvents(sheetName: string, events: C3Event[], warnings: string[], visitor: WalkVisitor): void {
  const stack: Array<{
    event: Record<string, unknown>;
    index: number;
    path: string;
    depth: number;
    scope: ParamScope | null;
  }> = [];
  for (let i = events.length - 1; i >= 0; i--) {
    stack.push({ event: events[i] as Record<string, unknown>, index: i, path: '', depth: 0, scope: null });
  }
  let nodeCount = 0;

  while (stack.length > 0) {
    if (nodeCount++ > MAX_NODES) {
      warnings.push(`Event sheet "${sheetName}": traversal limit reached (${MAX_NODES} nodes)`);
      break;
    }
    const { event, index, path, depth, scope: parentScope } = stack.pop()!;
    if (!event || typeof event !== 'object') continue;
    // A disabled event (and everything under it) does not run. Groups that are
    // merely inactive on start (isActiveOnStart: false) can be activated, so they stay in.
    if (event.disabled === true) continue;
    if (depth > MAX_DEPTH) {
      warnings.push(`Event sheet "${sheetName}": max depth exceeded at ${path}`);
      continue;
    }

    const segment = segmentAt(event, index);
    const eventPath = path ? `${path} > ${segment}` : segment;
    const eventSid = typeof event.sid === 'number' ? event.sid : undefined;

    let scope = parentScope;
    const own = ownParameterNames(event);
    if (own.length > 0) {
      const isFunction = event.eventType === 'function-block' && typeof event.functionName === 'string';
      const owner = isFunction
        ? `function "${event.functionName}"`
        : event.eventType === 'custom-ace-block'
          ? `custom action "${customAceName(event)}"`
          : `${String(event.eventType)} (${eventPath})`;
      scope = {
        owner,
        names: [...new Set([...(parentScope?.names ?? []), ...own])],
        functionName: isFunction ? event.functionName as string : parentScope?.functionName,
        functionParams: isFunction ? own : parentScope?.functionParams,
      };
    }

    if (event.eventType === 'script') {
      visitor.script(event, eventPath, eventSid, scope);
    }

    if (Array.isArray(event.conditions)) {
      event.conditions.forEach((cond, i) => {
        if (!cond || typeof cond !== 'object' || (cond as Record<string, unknown>).disabled === true) return;
        visitor.condition(cond as Record<string, unknown>, `${eventPath} > condition:${i}`, eventSid, scope);
      });
    }

    if (Array.isArray(event.actions)) {
      event.actions.forEach((action, i) => {
        if (!action || typeof action !== 'object') return;
        const rec = action as Record<string, unknown>;
        if (rec.disabled === true) return;
        const location = `${eventPath} > action:${i}`;
        if (rec.type === 'script') visitor.script(rec, location, eventSid, scope);
        else visitor.action(rec, location, eventSid, scope);
      });
    }

    if (Array.isArray(event.children)) {
      for (let i = event.children.length - 1; i >= 0; i--) {
        stack.push({
          event: event.children[i] as Record<string, unknown>,
          index: i,
          path: eventPath,
          depth: depth + 1,
          scope,
        });
      }
    }
  }
}

// ─── Signal order ───────────────────────────────────────────

/** A Signal or function call, in the order its event runs it */
type OrderEffect =
  | { kind: 'signal'; tag: string; site: SignalSite }
  /** Signal whose tag is a parameter of the enclosing function (index into its parameters) */
  | { kind: 'forward'; paramIndex: number; site: SignalSite }
  | { kind: 'call'; name: string; arg: (index: number) => CallArg; site: SignalSite };

/** What a function raises before a call to it returns */
interface SyncSignals {
  /** Lower-cased tag -> the Signal that raises it */
  tags: Map<string, SignalSite>;
  /** Parameter index -> the Signal whose tag is that parameter */
  params: Map<number, SignalSite>;
}

interface FunctionInfo {
  name: string;
  event: Record<string, unknown>;
  sheet: string;
  path: string;
}

interface Raiser {
  /** The Signal or call that runs before the wait */
  at: SignalSite;
  /** The Signal action itself (inside the called function for a call) */
  signal: SignalSite;
  /** Name of the called function, for a call */
  fn?: string;
}

const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const isLive = (item: unknown): item is Record<string, unknown> =>
  !!item && typeof item === 'object' && (item as Record<string, unknown>).disabled !== true;

const hasLiveConditions = (event: Record<string, unknown>) => listOf(event.conditions).some(isLive);

const isSystemWait = (action: Record<string, unknown>) =>
  action.objectClass === 'System' && typeof action.id === 'string' && WAIT_ACTION_IDS.has(action.id);

const tagParam = (ace: Record<string, unknown>): unknown => {
  const params = ace.parameters;
  return params && typeof params === 'object' && !Array.isArray(params)
    ? (params as Record<string, unknown>).tag
    : undefined;
};

/**
 * Signals and function calls an ACE performs. `Functions.Name(...)` calls in
 * its expressions run before the action itself. With `params` (the enclosing
 * function's parameters), a Signal whose tag is one of them is recorded as
 * forwarded.
 */
function aceEffects(
  ace: Record<string, unknown>,
  site: Site,
  functionsObject: string,
  names: Map<string, string>,
  params?: string[],
): OrderEffect[] {
  const effects: OrderEffect[] = [];
  for (const value of parameterValues(ace)) {
    if (typeof value !== 'string') continue;
    for (const call of findExpressionCalls(value, functionsObject)) {
      effects.push({
        kind: 'call',
        name: call.name,
        arg: eventArg(call.args),
        site: { ...site, via: `${functionsObject}.${names.get(call.name) ?? call.name}()` },
      });
    }
  }
  if (typeof ace.callFunction === 'string') {
    effects.push({
      kind: 'call',
      name: ace.callFunction.toLowerCase(),
      arg: eventArg(listOf(ace.parameters)),
      site: { ...site, via: `call ${ace.callFunction}` },
    });
  }
  if (ace.objectClass === 'System' && ace.id === SIGNAL_ACTION_ID) {
    const raw = tagParam(ace);
    const tag = parseC3StringLiteral(raw);
    const paramIndex = params && typeof raw === 'string' ? params.indexOf(raw.trim()) : -1;
    if (tag !== null) effects.push({ kind: 'signal', tag, site: { ...site, via: 'Signal' } });
    else if (paramIndex !== -1) effects.push({ kind: 'forward', paramIndex, site: { ...site, via: 'Signal' } });
  }
  return effects;
}

/** Enabled function blocks by lower-cased name (C3 function names are case-insensitive). */
function indexFunctions(sheets: ReadonlyMap<string, { events?: unknown }>): Map<string, FunctionInfo> {
  const functions = new Map<string, FunctionInfo>();
  for (const [sheet, data] of sheets) {
    const visit = (events: unknown[], parentPath: string, depth: number) => {
      if (depth > MAX_DEPTH) return;
      events.forEach((event, i) => {
        if (!isLive(event)) return;
        const path = parentPath ? `${parentPath} > ${segmentAt(event, i)}` : segmentAt(event, i);
        if (event.eventType === 'function-block' && typeof event.functionName === 'string') {
          const key = event.functionName.toLowerCase();
          if (!functions.has(key)) functions.set(key, { name: event.functionName, event, sheet, path });
          return;
        }
        visit(listOf(event.children), path, depth + 1);
      });
    };
    visit(listOf(data.events), '', 0);
  }
  return functions;
}

/**
 * Signals and calls a function runs before a call to it returns: its own
 * actions up to the first Wait / Wait for signal / Wait for previous actions,
 * then (if none) its sub-events the same way. A Wait defers only the rest of
 * its own event, so later sibling sub-events still count. Events with enabled
 * conditions are skipped (the Signal may not run); scripts are not followed.
 */
function syncEffects(fn: FunctionInfo, functionsObject: string, names: Map<string, string>): OrderEffect[] {
  const params = ownParameterNames(fn.event);
  const effects: OrderEffect[] = [];
  const visit = (event: Record<string, unknown>, path: string, depth: number) => {
    if (depth > MAX_DEPTH || hasLiveConditions(event)) return;
    const eventSid = typeof event.sid === 'number' ? event.sid : undefined;
    const actions = listOf(event.actions);
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      if (!isLive(action) || action.type === 'script') continue;
      // The rest of this event, sub-events included, runs after the call has returned
      if (isSystemWait(action)) return;
      const site = { sheet: fn.sheet, location: `${path} > action:${i}`, eventSid };
      effects.push(...aceEffects(action, site, functionsObject, names, params));
    }
    listOf(event.children).forEach((child, i) => {
      if (isLive(child)) visit(child, `${path} > ${segmentAt(child, i)}`, depth + 1);
    });
  };
  visit(fn.event, fn.path, 0);
  return effects;
}

/**
 * Waits that start after their tag was already raised: Signal "T" earlier in
 * the same event or a parent event, or an earlier call to a function that
 * raises "T" before it returns (followed transitively). Only literal tags of
 * System Wait for signal actions in `filter` (or every sheet) are checked.
 */
function findSignalOrderIssues(
  sheets: ReadonlyMap<string, { events?: unknown }>,
  filter: string | undefined,
  functionsObject: string,
  cap: (list: string[]) => string[],
): RuntimeTrapIssue[] {
  const functions = indexFunctions(sheets);
  const names = new Map([...functions].map(([key, fn]) => [key, fn.name]));
  const memo = new Map<string, SyncSignals>();
  const active = new Set<string>();

  const resolve = (key: string): SyncSignals => {
    const known = memo.get(key);
    if (known) return known;
    const result: SyncSignals = { tags: new Map(), params: new Map() };
    const fn = functions.get(key);
    // Unknown function, or a recursive call already being resolved
    if (!fn || active.has(key)) return result;
    active.add(key);
    for (const effect of syncEffects(fn, functionsObject, names)) {
      if (effect.kind === 'signal') {
        const tag = effect.tag.toLowerCase();
        if (!result.tags.has(tag)) result.tags.set(tag, effect.site);
      } else if (effect.kind === 'forward') {
        if (!result.params.has(effect.paramIndex)) result.params.set(effect.paramIndex, effect.site);
      } else {
        const callee = resolve(effect.name);
        for (const [tag, site] of callee.tags) if (!result.tags.has(tag)) result.tags.set(tag, site);
        for (const [index, site] of callee.params) {
          const tag = effect.arg(index).tag?.toLowerCase();
          if (tag !== undefined && !result.tags.has(tag)) result.tags.set(tag, site);
        }
      }
    }
    active.delete(key);
    memo.set(key, result);
    return result;
  };

  /** The latest earlier effect that raises `tag`: a Signal, or a call to a function that raises it synchronously */
  const raiser = (pre: OrderEffect[], tag: string): Raiser | null => {
    for (let i = pre.length - 1; i >= 0; i--) {
      const effect = pre[i];
      if (effect.kind === 'signal') {
        if (effect.tag.toLowerCase() === tag) return { at: effect.site, signal: effect.site };
        continue;
      }
      if (effect.kind !== 'call') continue;
      const sync = resolve(effect.name);
      let signal = sync.tags.get(tag);
      for (const [index, site] of sync.params) {
        if (signal) break;
        if (effect.arg(index).tag?.toLowerCase() === tag) signal = site;
      }
      if (signal) return { at: effect.site, signal, fn: names.get(effect.name) ?? effect.name };
    }
    return null;
  };

  const issues: RuntimeTrapIssue[] = [];
  const report = (tag: string, site: Site, hit: Raiser) => {
    const again = 'Signal only resumes waits that already exist, so this wait misses it and only finishes the next '
      + `time "${tag}" is raised.`;
    const confirm = `If this flow already works in-game, a later Signal "${tag}" may be what completes the wait; `
      + 'confirm before changing it.';
    const latch = 'latch it with a flag the waiter checks and consumes once (construct3://docs/pitfalls, item 7).';
    issues.push({
      severity: 'info',
      check: 'signal-order',
      location: `${site.sheet} > ${site.location}`,
      eventSid: site.eventSid,
      tag,
      message: hit.fn
        ? `${hit.fn} raises Signal "${tag}" before it returns (no Wait comes before that Signal on its path), so `
          + 'the signal fires during the call, before this Wait for signal starts and before any Wait inside '
          + `${hit.fn} has finished. ${again}`
        : `Signal "${tag}" runs before this Wait for signal starts (earlier in this event or a parent event). ${again}`,
      suggestion: hit.fn
        ? `Raise the Signal only after the work it announces is done (after the last Wait in ${hit.fn}), make `
          + `${hit.fn} asynchronous and use Wait for previous actions to complete instead, or ${latch} ${confirm}`
        : `If the Signal is meant for another event's wait, give this wait its own tag; otherwise ${latch} ${confirm}`,
      related: cap(hit.fn ? [formatSite(hit.at), formatSite(hit.signal)] : [formatSite(hit.at)]),
    });
  };

  for (const [sheet, data] of sheets) {
    if (filter && sheet !== filter) continue;
    const visit = (events: unknown[], parentPath: string, inherited: OrderEffect[], depth: number) => {
      if (depth > MAX_DEPTH) return;
      events.forEach((event, i) => {
        if (!isLive(event)) return;
        const path = parentPath ? `${parentPath} > ${segmentAt(event, i)}` : segmentAt(event, i);
        const eventSid = typeof event.sid === 'number' ? event.sid : undefined;
        // Sub-events run after all of their parent's actions (a Wait there defers them too)
        const pre = [...inherited];
        listOf(event.conditions).forEach((cond, c) => {
          if (!isLive(cond)) return;
          const site = { sheet, location: `${path} > condition:${c}`, eventSid };
          pre.push(...aceEffects(cond, site, functionsObject, names));
        });
        listOf(event.actions).forEach((action, k) => {
          if (!isLive(action) || action.type === 'script') return;
          const site = { sheet, location: `${path} > action:${k}`, eventSid };
          if (action.objectClass === 'System' && action.id === WAIT_FOR_SIGNAL_ACTION_ID) {
            const tag = parseC3StringLiteral(tagParam(action));
            const hit = tag !== null ? raiser(pre, tag.toLowerCase()) : null;
            if (tag !== null && hit) report(tag, site, hit);
          }
          pre.push(...aceEffects(action, site, functionsObject, names));
        });
        visit(listOf(event.children), path, pre, depth + 1);
      });
    };
    visit(listOf(data.events), '', [], 0);
  }
  return issues;
}
