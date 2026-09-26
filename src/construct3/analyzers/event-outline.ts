/**
 * Event sheet outline and editor event-number mapping.
 *
 * Construct 3 refers to events by a per-sheet display number ("es_game, event 72,
 * action 1"). That number follows the editor's display order, not the JSON
 * events[] index. Rule from komabear/c3-skill (MIT, scripts/es_outline.py), refined
 * against real exported projects:
 *
 * - Depth-first pre-order walk: top-level events in order, each node's children[]
 *   inline right after it (group, block and function bodies alike).
 * - 1-based, restarting at 1 in every sheet.
 * - Numbered: block (including else, OR and disabled blocks, also those under a disabled
 *   parent), group, function-block, custom-ace-block and event-level script blocks.
 * - Not numbered: variable, include, comment.
 * - "action M" is actions[M-1], action comment rows and disabled action rows included: the
 *   runtime prints the action's debug index + 1, and the debug index is the actions[] index.
 *
 * Evidence: the C3 runtime stores the editor-assigned number as
 * EventBlock._displayNumber (data[5]) and EventScript._displayNumber (data[2]);
 * variables and includes carry none. It prints script errors as
 * "Unhandled exception running script <sheet>, event <displayNumber>, action
 * <debugIndex + 1>". Comparing the display numbers in 32 exported data.json files
 * (r232-r466) with their folder-project sources by sid confirmed the rules for blocks,
 * groups, functions, custom ACE blocks, variables, includes and comments, and that the
 * debug index of script actions is their actions[] index. Exports strip action comment
 * rows, but keep the debug index: in AshleyScirra/CommandAndConstruct, "Multiplayer
 * join events" event 5 (function StartJoinAttempt) has a comment row at actions[4] and
 * a script at actions[5]; the live export has 4 ACEs, then the script with debug index
 * 5 (scriptsInEvents.MultiplayerJoinEvents_Event5_Act6). So comment rows count
 * (countActionComments, default true).
 *
 * Exports of further projects (r449) confirm three more rules. An event-level script
 * block, one of them nested two levels deep inside sub-events, takes one number at its
 * depth-first position, and every later event keeps matching. Exports drop disabled
 * actions just as they drop comment rows, but a script action keeps its actions[] index as
 * its debug index (a script after two disabled rows at actions[2] keeps debug index 2, so
 * it is "action 3"): disabled action rows count too, whatever countActionComments says.
 * Disabled events, also those disabled only through a parent, keep their numbers; the
 * export leaves a gap for them.
 *
 * Not verified: how errors raised by the editor itself number actions. c3-skill
 * (references/c3-json-surgical-rewrites.md) says that for editor load errors such as
 * "Empty expression", actions[j] matches "action j" (0-based); the editor's own
 * strings ("<sheet>, number N, action M, line L" for script syntax errors) do not settle
 * it. This is the actionIndexBase option (default 1, the verified runtime reading), and
 * locate_event always names the other reading. Also not verified: whether condition
 * numbers are 1-based. These are stated in tool notes and docs/API.md.
 */

import { BEHAVIOR_TYPE_KEY, LEGACY_BEHAVIOR_TYPE_KEY, isBehaviorName } from './legacy-behavior-keys.js';

const MAX_NODES = 100_000;
const MAX_DEPTH = 50;
const PARAM_VALUE_MAX = 40;
const TEXT_MAX = 80;
const SUMMARY_MAX = 200;
const MAX_LISTED_ITEMS = 50;

/** Event types the editor gives a display number. */
const NUMBERED_EVENT_TYPES = new Set(['block', 'group', 'function-block', 'custom-ace-block', 'script']);
/** Event types the editor shows without a display number. */
const UNNUMBERED_EVENT_TYPES = new Set(['variable', 'include', 'comment']);

/** One-paragraph statement of the numbering rule, included in tool output. */
export const NUMBERING_RULE =
  'Event numbers follow the editor display order: depth-first, each event\'s sub-events right after it, 1-based per sheet. ' +
  'Numbered: blocks (incl. else, OR and disabled blocks), groups, functions, custom ACE blocks, script blocks. ' +
  'Not numbered: variables, includes, comments. ' +
  'Action M is actions[M-1], comment and disabled rows included (verified for runtime script errors; ' +
  'editor load errors may count actions from 0, see actionIndexBase).';

export type OutlineNodeKind =
  | 'block'
  | 'else'
  | 'group'
  | 'function'
  | 'custom-ace'
  | 'script'
  | 'variable'
  | 'include'
  | 'comment'
  | 'unknown';

export type OutlineItemKind = 'condition' | 'action' | 'call' | 'custom-action' | 'script' | 'comment';

/** A condition or action of an event, rendered on one line. */
export interface OutlineItem {
  /** Index in the event's conditions[] or actions[] array in the JSON */
  index: number;
  /** JSON path from the sheet root, e.g. events[3].children[1].actions[0] */
  path: string;
  kind: OutlineItemKind;
  sid?: number;
  disabled: boolean;
  /** e.g. "NOT Player.is-on-floor()", "DO Player[Platform].simulate-control(control=left)" */
  text: string;
}

/** One row of the event sheet in display order. */
export interface OutlineNode {
  /** Editor display number, or null for rows the editor does not number */
  number: number | null;
  kind: OutlineNodeKind;
  eventType: string;
  /** JSON path from the sheet root, e.g. events[3].children[1] */
  path: string;
  /** Nesting depth (0 = top level) */
  depth: number;
  sid?: number;
  disabled: boolean;
  /** Titles of the enclosing groups, outermost first */
  enclosingGroups: string[];
  /** Name of the nearest enclosing function or custom ACE block */
  enclosingFunction?: string;
  /** e.g. "IF Keyboard.key-is-down(key=87) AND NOT Player.is-on-floor()" */
  header: string;
  conditions: OutlineItem[];
  actions: OutlineItem[];
}

export interface SheetOutline {
  sheet: string;
  /** Every row in display order, numbered or not */
  nodes: OutlineNode[];
  /** Count of numbered events */
  totalEvents: number;
  /** True when the walk stopped early (node or depth limit); events after totalEvents are not mapped */
  truncated: boolean;
  warnings: string[];
}

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function renderValue(value: unknown): string {
  if (typeof value === 'string') return truncate(oneLine(value), PARAM_VALUE_MAX);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return `[${value.length} items]`;
  return truncate(JSON.stringify(value), PARAM_VALUE_MAX);
}

/** Parameters are a dict for ACEs and an array for callFunction actions. */
function renderParams(params: unknown): string {
  if (Array.isArray(params)) return params.map(renderValue).join(', ');
  if (isRecord(params)) {
    return Object.entries(params).map(([key, value]) => `${key}=${renderValue(value)}`).join(', ');
  }
  return '';
}

/** Real projects write `behaviorType`; older files written by this server used `behavior-type`. */
function aceTarget(ace: Raw): string {
  const objectClass = typeof ace.objectClass === 'string' ? ace.objectClass : '?';
  const behavior = ace.behaviorType ?? ace['behavior-type'];
  return typeof behavior === 'string' && behavior ? `${objectClass}[${behavior}]` : objectClass;
}

/**
 * The ACE names its behavior only under the legacy "behavior-type" key. Construct 3
 * does not read that key and fails to open the project (issue #16), so the outline
 * marks it instead of showing it like a working behavior ACE.
 */
function hasOnlyLegacyBehaviorKey(ace: Raw): boolean {
  return isBehaviorName(ace[LEGACY_BEHAVIOR_TYPE_KEY]) && !isBehaviorName(ace[BEHAVIOR_TYPE_KEY]);
}

const LEGACY_MARK = ' [legacy behavior-type]';

/** Script text may be a single string or an array of lines. */
function scriptLines(script: unknown): string[] {
  const text = Array.isArray(script) ? script.map(String).join('\n') : typeof script === 'string' ? script : '';
  return text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
}

function renderScript(node: Raw, prefix: string): string {
  const lines = scriptLines(node.script);
  const language = typeof node.language === 'string' && node.language !== 'javascript' ? `[${node.language}]` : '';
  const first = lines.length > 0 ? truncate(lines[0], TEXT_MAX) : '(empty)';
  const more = lines.length > 1 ? ` (+${lines.length - 1} lines)` : '';
  return `${prefix}${language}: ${first}${more}`;
}

function describeCondition(cond: Raw): string {
  const id = typeof cond.id === 'string' ? cond.id : '?';
  const not = cond.isInverted ? 'NOT ' : '';
  const disabled = cond.disabled ? ' [disabled]' : '';
  // isOr is a per-condition flag this server's writer emits; real sheets use the block's isOrBlock.
  const nonStandard = cond.isOr === true ? ' [non-standard isOr]' : '';
  const legacy = hasOnlyLegacyBehaviorKey(cond) ? LEGACY_MARK : '';
  return `${not}${aceTarget(cond)}.${id}(${renderParams(cond.parameters)})${disabled}${nonStandard}${legacy}`;
}

/**
 * " IF c1 AND c2" (or OR for isOrBlock), or '' when there are no conditions.
 * Lists at most MAX_LISTED_ITEMS conditions, so a header stays one readable line.
 */
function describeConditions(node: Raw, conditions: Raw[]): string {
  if (conditions.length === 0) return '';
  const joiner = node.isOrBlock === true ? ' OR ' : ' AND ';
  const more = conditions.length > MAX_LISTED_ITEMS
    ? ` … (+${conditions.length - MAX_LISTED_ITEMS} more conditions)` : '';
  return ` IF ${conditions.slice(0, MAX_LISTED_ITEMS).map(describeCondition).join(joiner)}${more}`;
}

function classifyAction(action: Raw): OutlineItemKind {
  if (action.type === 'comment') return 'comment';
  if (action.type === 'script') return 'script';
  if (typeof action.callFunction === 'string') return 'call';
  if (typeof action.customAction === 'string') return 'custom-action';
  return 'action';
}

/**
 * A custom action call names the class whose custom action runs in customActionObjectClass
 * when it differs from objectClass, e.g. the family original called on an object type that
 * overrides it. The editor labels that "PlayAnimation (Animals)" (manual, Custom actions).
 */
function customActionOrigin(action: Raw): string {
  const origin = action.customActionObjectClass;
  return typeof origin === 'string' && origin && origin !== action.objectClass ? ` (${origin})` : '';
}

function describeAction(action: Raw, kind: OutlineItemKind): string {
  const disabled = action.disabled ? ' [disabled]' : '';
  switch (kind) {
    case 'comment':
      return `COMMENT: ${truncate(oneLine(String(action.text ?? '')), TEXT_MAX)}`;
    case 'script':
      return renderScript(action, 'SCRIPT') + disabled;
    case 'call':
      return `CALL ${action.callFunction as string}(${renderParams(action.parameters)})${disabled}`;
    case 'custom-action':
      return `CALL ${aceTarget(action)}.${action.customAction as string}${customActionOrigin(action)}(${renderParams(action.parameters)})${disabled}`;
    default: {
      const id = typeof action.id === 'string' ? action.id : '?';
      const legacy = hasOnlyLegacyBehaviorKey(action) ? LEGACY_MARK : '';
      return `DO ${aceTarget(action)}.${id}(${renderParams(action.parameters)})${disabled}${legacy}`;
    }
  }
}

/** Real sheets mark an else block with a System "else" first condition. */
function isElseBlock(conditions: Raw[]): boolean {
  const first = conditions[0];
  return first !== undefined && first.id === 'else' && first.objectClass === 'System';
}

function renderFunctionParams(node: Raw): string {
  const params = Array.isArray(node.functionParameters)
    ? node.functionParameters
    : Array.isArray(node.parameters) ? node.parameters : [];
  return params
    .filter(isRecord)
    .map(p => (typeof p.type === 'string' && p.type ? `${String(p.name)}: ${p.type}` : String(p.name)))
    .join(', ');
}

function nodeKind(eventType: string, conditions: Raw[]): OutlineNodeKind {
  switch (eventType) {
    case 'block': return isElseBlock(conditions) ? 'else' : 'block';
    case 'group': return 'group';
    case 'function-block': return 'function';
    case 'custom-ace-block': return 'custom-ace';
    case 'script': return 'script';
    case 'variable': return 'variable';
    case 'include': return 'include';
    case 'comment': return 'comment';
    default: return 'unknown';
  }
}

function describeHeader(kind: OutlineNodeKind, node: Raw, conditions: Raw[]): string {
  const disabled = node.disabled === true ? ' [disabled]' : '';
  switch (kind) {
    case 'block':
    case 'else': {
      // isElse is a block flag this server's writer emits; real sheets use the System "else" condition.
      const nonStandard = node.isElse === true ? ' [non-standard isElse]' : '';
      if (kind === 'else') return `ELSE${describeConditions(node, conditions.slice(1))}${disabled}${nonStandard}`;
      const conds = describeConditions(node, conditions);
      return `${conds ? conds.trimStart() : 'IF (no conditions)'}${disabled}${nonStandard}`;
    }
    case 'group': {
      const inactive = node.isActiveOnStart === false ? ' (inactive on start)' : '';
      return `GROUP [${String(node.title ?? '')}]${inactive}${disabled}`;
    }
    case 'function': {
      const returnType = typeof node.functionReturnType === 'string' && node.functionReturnType !== 'none'
        ? ` -> ${node.functionReturnType}` : '';
      const isAsync = node.functionIsAsync === true ? ' [async]' : '';
      return `FUNCTION ${String(node.functionName ?? '?')}(${renderFunctionParams(node)})${returnType}${isAsync}` +
        `${describeConditions(node, conditions)}${disabled}`;
    }
    case 'custom-ace': {
      const aceType = typeof node.aceType === 'string' ? node.aceType.toUpperCase() : 'ACE';
      return `CUSTOM ${aceType} ${aceTarget(node)}.${String(node.aceName ?? '?')}(${renderFunctionParams(node)})` +
        `${describeConditions(node, conditions)}${disabled}`;
    }
    case 'script':
      return renderScript(node, 'SCRIPT BLOCK') + disabled;
    case 'variable': {
      const flags = [node.isConstant === true ? 'constant' : '', node.isStatic === true ? 'static' : '']
        .filter(Boolean);
      const suffix = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
      return `VAR ${String(node.name ?? '?')}: ${String(node.type ?? '?')} = ${renderValue(node.initialValue)}${suffix}`;
    }
    case 'include':
      return `INCLUDE ${String(node.includeSheet ?? '?')}`;
    case 'comment':
      return `COMMENT: ${truncate(oneLine(String(node.text ?? '')), TEXT_MAX)}`;
    default:
      return `? ${String(node.eventType)}${disabled}`;
  }
}

function enclosingName(kind: OutlineNodeKind, node: Raw): string | undefined {
  if (kind === 'function') return String(node.functionName ?? '?');
  if (kind === 'custom-ace') return `${aceTarget(node)}.${String(node.aceName ?? '?')}`;
  return undefined;
}

/**
 * Keep the objects of a conditions[]/actions[] array with their JSON index, so paths
 * stay exact; other entries are reported and left out of the numbering.
 */
function records(list: unknown, path: string, key: 'conditions' | 'actions', warnings: string[]): Array<[Raw, number]> {
  if (!Array.isArray(list)) return [];
  const out: Array<[Raw, number]> = [];
  list.forEach((item, i) => {
    if (isRecord(item)) out.push([item, i]);
    else warnings.push(`${path}.${key}[${i}] is not an object; skipped, so later ${key === 'actions' ? 'action' : 'condition'} numbers in this event may be off.`);
  });
  return out;
}

/** Paths of rows that carry a flag or key Construct 3 does not write, reported once per sheet. */
function nonStandardFlagWarnings(isElse: string[], isOr: string[], legacyBehavior: string[]): string[] {
  const first = (paths: string[]) => `${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ', …' : ''}`;
  const warnings: string[] = [];
  if (legacyBehavior.length > 0) {
    warnings.push(
      `${legacyBehavior.length} condition(s)/action(s) name their behavior only under the legacy "behavior-type" key (${first(legacyBehavior)}), ` +
      'written by construct3-mcp 1.8.1 and earlier. Construct 3 reads "behaviorType" and fails to open such a project (e.g. "missing action id"); ' +
      'the outline shows the behavior as stored, marked [legacy behavior-type]. Run fix_legacy_behavior_keys to repair them.',
    );
  }
  if (isElse.length > 0) {
    warnings.push(
      `${isElse.length} block(s) carry isElse: true (${first(isElse)}), a flag written by construct3-mcp's event tools, not by Construct 3. ` +
      'Real sheets mark an else block with a System "else" first condition, so Construct 3 may ignore the flag; the outline shows these blocks as stored, marked [non-standard isElse].',
    );
  }
  if (isOr.length > 0) {
    warnings.push(
      `${isOr.length} condition(s) carry isOr: true (${first(isOr)}), a flag written by construct3-mcp's event tools, not by Construct 3. ` +
      'Real sheets OR a block\'s conditions with the block\'s isOrBlock flag, so Construct 3 may ignore it; the outline joins the conditions as stored, marked [non-standard isOr].',
    );
  }
  return warnings;
}

/**
 * Walk an event sheet in editor display order and assign display numbers.
 * Iterative pre-order traversal with node and depth limits (like index-builder).
 * When a limit is hit the walk stops, so every number it assigns is still correct.
 */
export function buildEventOutline(sheet: string, events: unknown): SheetOutline {
  const nodes: OutlineNode[] = [];
  const warnings: string[] = [];
  const isElseFlags: string[] = [];
  const isOrFlags: string[] = [];
  const legacyBehaviorKeys: string[] = [];
  let counter = 0;
  let truncated = false;

  interface Frame { node: unknown; path: string; depth: number; groups: string[]; fn?: string }
  const stack: Frame[] = [];
  const pushChildren = (children: unknown[], parentPath: string, depth: number, groups: string[], fn?: string) => {
    for (let i = children.length - 1; i >= 0; i--) {
      const path = parentPath ? `${parentPath}.children[${i}]` : `events[${i}]`;
      stack.push({ node: children[i], path, depth, groups, fn });
    }
  };

  if (Array.isArray(events)) {
    pushChildren(events, '', 0, []);
  } else {
    warnings.push(`Event sheet "${sheet}" has no events array.`);
  }

  while (stack.length > 0) {
    if (nodes.length >= MAX_NODES) {
      warnings.push(`Event sheet "${sheet}": traversal limit reached (${MAX_NODES} nodes); the outline stops after event ${counter}.`);
      truncated = true;
      break;
    }
    const { node, path, depth, groups, fn } = stack.pop()!;
    if (!isRecord(node)) {
      warnings.push(`${path} is not an event object; skipped.`);
      continue;
    }

    const eventType = typeof node.eventType === 'string' ? node.eventType : String(node.eventType);
    const conditions = records(node.conditions, path, 'conditions', warnings);
    const actions = records(node.actions, path, 'actions', warnings);
    const conditionObjects = conditions.map(([cond]) => cond);
    const kind = nodeKind(eventType, conditionObjects);

    let numbered = NUMBERED_EVENT_TYPES.has(eventType);
    if (!numbered && !UNNUMBERED_EVENT_TYPES.has(eventType)) {
      // Unknown event types are most likely new event-like rows: number them, but say so.
      numbered = true;
      warnings.push(`${path} has unknown eventType "${eventType}"; counted as a numbered event, so later numbers may be off.`);
    }
    const number = numbered ? ++counter : null;

    if (node.isElse === true) isElseFlags.push(path);
    for (const [cond, i] of conditions) if (cond.isOr === true) isOrFlags.push(`${path}.conditions[${i}]`);
    for (const [cond, i] of conditions) if (hasOnlyLegacyBehaviorKey(cond)) legacyBehaviorKeys.push(`${path}.conditions[${i}]`);
    for (const [action, i] of actions) if (hasOnlyLegacyBehaviorKey(action)) legacyBehaviorKeys.push(`${path}.actions[${i}]`);

    nodes.push({
      number,
      kind,
      eventType,
      path,
      depth,
      sid: typeof node.sid === 'number' ? node.sid : undefined,
      disabled: node.disabled === true,
      enclosingGroups: groups,
      enclosingFunction: fn,
      header: describeHeader(kind, node, conditionObjects),
      conditions: conditions.map(([cond, i]) => ({
        index: i,
        path: `${path}.conditions[${i}]`,
        kind: 'condition' as const,
        sid: typeof cond.sid === 'number' ? cond.sid : undefined,
        disabled: cond.disabled === true,
        text: describeCondition(cond),
      })),
      actions: actions.map(([action, i]) => {
        const actionKind = classifyAction(action);
        return {
          index: i,
          path: `${path}.actions[${i}]`,
          kind: actionKind,
          sid: typeof action.sid === 'number' ? action.sid : undefined,
          disabled: action.disabled === true,
          text: describeAction(action, actionKind),
        };
      }),
    });

    if (Array.isArray(node.children) && node.children.length > 0) {
      if (depth + 1 > MAX_DEPTH) {
        // Skipping the subtree would shift every later number, so stop instead.
        warnings.push(`${path}: sub-events nested deeper than ${MAX_DEPTH} levels; the outline stops after event ${counter}.`);
        truncated = true;
        break;
      }
      const childGroups = kind === 'group' ? [...groups, String(node.title ?? '')] : groups;
      pushChildren(node.children, path, depth + 1, childGroups, enclosingName(kind, node) ?? fn);
    }
  }

  warnings.push(...nonStandardFlagWarnings(isElseFlags, isOrFlags, legacyBehaviorKeys));
  return { sheet, nodes, totalEvents: counter, truncated, warnings };
}

/** One-line summary of an event: header plus its actions. */
export function summarizeNode(node: OutlineNode): string {
  if (node.actions.length === 0) return truncate(node.header, SUMMARY_MAX);
  return truncate(`${node.header} => ${node.actions.map(a => a.text).join('; ')}`, SUMMARY_MAX);
}

// ─── locate_event ──────────────────────────────────────────

export interface LocateOptions {
  conditionNumber?: number;
  actionNumber?: number;
  /**
   * Count action-level comment rows ({ type: "comment" }) when resolving "action M".
   * Default true, verified for runtime script errors (see the module header). Disabled
   * action rows always count.
   */
  countActionComments?: boolean;
  /**
   * The number of the first action. Default 1, verified for runtime script errors.
   * 0 follows c3-skill's (unverified) reading of editor load errors: "action j" = actions[j].
   */
  actionIndexBase?: 0 | 1;
}

export interface LocatedItem {
  number: number;
  index: number;
  path: string;
  kind: OutlineItemKind;
  sid?: number;
  disabled: boolean;
  text: string;
}

export interface NeighbourEvent {
  number: number;
  path: string;
  kind: OutlineNodeKind;
  summary: string;
}

export interface EventLocation {
  sheet: string;
  eventNumber: number;
  totalEvents: number;
  event: {
    number: number;
    path: string;
    sid?: number;
    kind: OutlineNodeKind;
    eventType: string;
    depth: number;
    disabled: boolean;
    enclosingGroups: string[];
    enclosingFunction?: string;
    summary: string;
    conditions: string[];
    actions: string[];
  };
  condition?: LocatedItem;
  action?: LocatedItem;
  previousEvent: NeighbourEvent | null;
  nextEvent: NeighbourEvent | null;
  numbering: string;
  notes: string[];
  warnings: string[];
}

function neighbour(node: OutlineNode | undefined): NeighbourEvent | null {
  if (!node || node.number === null) return null;
  return { number: node.number, path: node.path, kind: node.kind, summary: summarizeNode(node) };
}

/** Number the actions of an event from `base`: every row, or every non-comment row. */
function numberActions(actions: OutlineItem[], countComments: boolean, base: number): Array<number | null> {
  let n = base - 1;
  return actions.map(a => (!countComments && a.kind === 'comment' ? null : ++n));
}

function listItems(items: OutlineItem[], numbers: Array<number | null>): string[] {
  const lines = items.slice(0, MAX_LISTED_ITEMS).map((item, i) => `${numbers[i] ?? '-'}: ${item.text}`);
  if (items.length > MAX_LISTED_ITEMS) lines.push(`(+${items.length - MAX_LISTED_ITEMS} more)`);
  return lines;
}

function toLocated(item: OutlineItem, number: number): LocatedItem {
  return {
    number,
    index: item.index,
    path: item.path,
    kind: item.kind,
    sid: item.sid,
    disabled: item.disabled,
    text: item.text,
  };
}

/** "events[0].actions[1]: DO ..." for the action numbered n, or "no such action". */
function describeAlternative(actions: OutlineItem[], numbers: Array<number | null>, n: number): string {
  const i = numbers.indexOf(n);
  return i >= 0 ? `${actions[i].path}: ${actions[i].text}` : 'no such action';
}

/** "action n is events[0].actions[2]: DO ...", or the range, when comment rows are counted. */
function withCommentsReading(actions: OutlineItem[], base: number, n: number): string {
  const numbers = numberActions(actions, true, base);
  return numbers.includes(n)
    ? `action ${n} is ${describeAlternative(actions, numbers, n)}`
    : `the event has ${actions.length} action(s) (${base}-${base + actions.length - 1})`;
}

/**
 * Map an editor event number (and optional condition/action number) to JSON.
 * Throws with a clear message when a number is out of range.
 */
export function locateEvent(outline: SheetOutline, eventNumber: number, options: LocateOptions = {}): EventLocation {
  const countComments = options.countActionComments ?? true;
  const base = options.actionIndexBase ?? 1;
  const numbered = outline.nodes.filter(n => n.number !== null);
  if (!Number.isInteger(eventNumber) || eventNumber < 1 || eventNumber > numbered.length) {
    const range = numbered.length === 0
      ? 'it has no numbered events'
      : `it has ${numbered.length} numbered events (1-${numbered.length})`;
    const stopped = outline.truncated ? ' before the outline stopped early (see warnings)' : '';
    throw new Error(`Event ${eventNumber} is out of range for event sheet "${outline.sheet}": ${range}${stopped}.`);
  }

  const node = numbered[eventNumber - 1];
  const actionNumbers = numberActions(node.actions, countComments, base);
  const notes: string[] = [];

  let condition: LocatedItem | undefined;
  if (options.conditionNumber !== undefined) {
    const n = options.conditionNumber;
    if (node.conditions.length === 0) {
      throw new Error(`Event ${eventNumber} in "${outline.sheet}" (${node.header}) has no conditions.`);
    }
    if (!Number.isInteger(n) || n < 1 || n > node.conditions.length) {
      throw new Error(`Condition ${n} is out of range: event ${eventNumber} in "${outline.sheet}" has ${node.conditions.length} condition(s) (1-${node.conditions.length}).`);
    }
    condition = toLocated(node.conditions[n - 1], n);
    notes.push('Condition numbers are assumed to be 1-based like action numbers (not verified against a Construct 3 error message).');
  }

  let action: LocatedItem | undefined;
  if (options.actionNumber !== undefined) {
    const n = options.actionNumber;
    const countable = actionNumbers.filter(x => x !== null).length;
    // Comment rows that countActionComments=false left out of the numbering.
    const skipped = node.actions.length - countable;
    if (countable === 0) {
      if (skipped > 0) {
        throw new Error(
          `Event ${eventNumber} in "${outline.sheet}" (${node.header}) has only comment rows in its actions (${skipped}), ` +
          'and countActionComments=false skips them. Runtime script errors count comment rows (verified), ' +
          'but a comment row cannot raise an error: check the event number.',
        );
      }
      throw new Error(`Event ${eventNumber} in "${outline.sheet}" (${node.header}) has no actions.`);
    }
    const last = base + countable - 1;
    if (!Number.isInteger(n) || n < base || n > last) {
      const hint = n === 0 && base === 1 ? ' If the number is 0-based, set actionIndexBase=0.' : '';
      const skippedHint = skipped > 0
        ? ` countActionComments=false skipped ${skipped} comment row(s); counting them, as runtime script errors do (verified), ` +
          `${withCommentsReading(node.actions, base, n)}.`
        : '';
      throw new Error(`Action ${n} is out of range: event ${eventNumber} in "${outline.sheet}" has ${countable} action(s) (${base}-${last}).${hint}${skippedHint}`);
    }
    const position = actionNumbers.indexOf(n);
    action = toLocated(node.actions[position], n);

    // The action base is only verified for runtime script errors: always name the other reading.
    const other = describeAlternative(node.actions, numberActions(node.actions, countComments, 1 - base), n);
    notes.push(base === 1
      ? `Action ${n} is read 1-based, as runtime script errors ("Unhandled exception running script <sheet>, event N, action M") count actions (verified). ` +
        `c3-skill reports that editor load errors (e.g. "Empty expression") count actions from 0 (not verified); read that way (actionIndexBase=0), action ${n} is ${other}.`
      : `Action ${n} is read 0-based (actionIndexBase=0), as c3-skill reports for editor load errors (not verified). ` +
        `Runtime script errors count actions from 1 (verified); read that way, action ${n} is ${other}.`);

    if (action.kind === 'comment') {
      notes.push(`Action ${n} is a comment row, which cannot raise an error: check the number and actionIndexBase.`);
    } else if (!countComments && node.actions.slice(0, position).some(a => a.kind === 'comment')) {
      notes.push(`countActionComments=false skips comment rows, but runtime script errors count them (verified); counting them, ${withCommentsReading(node.actions, base, n)}.`);
    }
  }

  return {
    sheet: outline.sheet,
    eventNumber,
    totalEvents: outline.totalEvents,
    event: {
      number: eventNumber,
      path: node.path,
      sid: node.sid,
      kind: node.kind,
      eventType: node.eventType,
      depth: node.depth,
      disabled: node.disabled,
      enclosingGroups: node.enclosingGroups,
      enclosingFunction: node.enclosingFunction,
      summary: summarizeNode(node),
      conditions: listItems(node.conditions, node.conditions.map((_, i) => i + 1)),
      actions: listItems(node.actions, actionNumbers),
    },
    ...(condition ? { condition } : {}),
    ...(action ? { action } : {}),
    previousEvent: neighbour(numbered[eventNumber - 2]),
    nextEvent: neighbour(numbered[eventNumber]),
    numbering: NUMBERING_RULE,
    notes,
    warnings: outline.warnings,
  };
}

// ─── get_eventsheet_outline ────────────────────────────────

/**
 * Soft size limit of one outline page in characters (about 10-13K tokens). MCP clients cap
 * tool output (Claude Code: MAX_MCP_OUTPUT_TOKENS, default 25000 tokens) and cut longer
 * results, so a page ends early at an event boundary once the next event would pass it.
 */
export const OUTLINE_PAGE_CHAR_BUDGET = 40_000;

/** Room kept in the budget for the "Showing events …" header line, written last. */
const SHOWING_LINE_RESERVE = 300;

export interface OutlineRenderOptions {
  /** First event number to show (1-based, default 1) */
  startEvent?: number;
  /** Maximum number of events per page (default 100); with maxDepth, only shown events count */
  limit?: number;
  /** Deepest nesting level to print (0 = top level only); deeper events are counted but hidden */
  maxDepth?: number;
  /**
   * Size budget of the page in characters (default OUTLINE_PAGE_CHAR_BUDGET). The page ends
   * before the next shown event that would pass it; it always shows at least one event.
   */
  maxChars?: number;
}

export interface OutlinePage {
  text: string;
  firstEvent: number | null;
  lastEvent: number | null;
  nextStartEvent: number | null;
  /** Why the page ended: `limit` events shown, the size budget, or the end of the sheet */
  stoppedBy: 'limit' | 'size' | 'end';
}

/** Enclosing rows of nodes[index], outermost first. */
function ancestorsOf(nodes: OutlineNode[], index: number): OutlineNode[] {
  const ancestors: OutlineNode[] = [];
  let depth = nodes[index].depth;
  for (let i = index - 1; i >= 0 && depth > 0; i--) {
    if (nodes[i].depth < depth) {
      ancestors.unshift(nodes[i]);
      depth = nodes[i].depth;
    }
  }
  return ancestors;
}

/** Lines of one shown row: its header, then at most MAX_LISTED_ITEMS actions. */
function nodeLines(node: OutlineNode, numberLabel: string, blank: string): string[] {
  const indent = '  '.repeat(node.depth);
  const lines = [`${numberLabel} ${indent}${node.header}`];
  // Paging counts events, so cap the actions of each event like locate_event does.
  for (const action of node.actions.slice(0, MAX_LISTED_ITEMS)) {
    lines.push(`${blank} ${indent}    ${action.text}`);
  }
  if (node.actions.length > MAX_LISTED_ITEMS) {
    lines.push(`${blank} ${indent}    … (+${node.actions.length - MAX_LISTED_ITEMS} more actions; ` +
      'locate_event with actionNumber shows any of them, get_eventsheet_details has the whole sheet)');
  }
  return lines;
}

/** Characters that lines add to a text joined with '\n'. */
function linesLength(lines: string[]): number {
  return lines.reduce((sum, line) => sum + line.length + 1, 0);
}

/**
 * Render a paged, human-readable outline with editor event numbers.
 * A page ends after `limit` shown events, or earlier, at an event boundary, when the next
 * shown event would take the page past the size budget (maxChars). Throws when startEvent
 * is past the last event.
 */
export function renderOutline(outline: SheetOutline, options: OutlineRenderOptions = {}): OutlinePage {
  const startEvent = options.startEvent ?? 1;
  const limit = options.limit ?? 100;
  const maxDepth = options.maxDepth;
  const maxChars = options.maxChars ?? OUTLINE_PAGE_CHAR_BUDGET;
  const total = outline.totalEvents;

  if (startEvent > 1 && startEvent > total) {
    const stopped = outline.truncated ? ' before the outline stopped early' : '';
    throw new Error(`startEvent ${startEvent} is out of range for event sheet "${outline.sheet}": it has ${total} numbered events${stopped}.`);
  }

  const nodes = outline.nodes;
  const isHidden = (node: OutlineNode) => maxDepth !== undefined && node.depth > maxDepth;

  // Every header line except "Showing events …", which depends on where the page ends.
  const unnumbered = nodes.length - total;
  const sheetLine =
    `Event sheet "${outline.sheet}": ${total} numbered event(s), ${unnumbered} unnumbered row(s) (variables, includes, comments).`;
  const fixedHeader: string[] = [
    `Numbering: ${NUMBERING_RULE}`,
    'Legend: IF conditions (NOT = inverted), DO action, CALL function or custom action ' +
      '("Obj.action (Family)" = the family\'s custom action run on Obj), SCRIPT first line, "-" = unnumbered row.',
    ...outline.warnings.map(w => `Warning: ${w}`),
    '',
  ];
  const bodyBudget = Math.max(maxChars - linesLength([sheetLine, ...fixedHeader]) - SHOWING_LINE_RESERVE, 0);

  const numberWidth = Math.max(String(total).length, 1);
  const blank = ' '.repeat(numberWidth);
  const pad = (n: number | null) => (n === null ? '-' : String(n)).padStart(numberWidth);
  const lines: string[] = [];
  let bodyLength = 0;
  const push = (line: string) => {
    lines.push(line);
    bodyLength += line.length + 1;
  };

  // A page runs from event `startEvent` (or the sheet start) up to the event after the
  // `limit`-th one. With maxDepth only shown events count, so hidden runs cannot fill a page.
  const startIdx = startEvent <= 1 ? 0 : nodes.findIndex(n => n.number === startEvent);

  // A page that starts inside a group, block or function names the enclosing rows first.
  if (startIdx > 0) {
    for (const parent of ancestorsOf(nodes, startIdx)) {
      if (isHidden(parent)) continue;
      const label = parent.number === null ? parent.header : `event ${parent.number}: ${parent.header}`;
      push(`${blank} ${'  '.repeat(parent.depth)}(inside ${label})`);
    }
  }

  let hidden: { depth: number; first: number | null; last: number | null; unnumbered: number } | null = null;
  const hiddenLine = (): string | null => {
    if (!hidden) return null;
    const range = hidden.first === null ? ''
      : hidden.first === hidden.last ? `event ${hidden.first}` : `events ${hidden.first}-${hidden.last}`;
    const extra = hidden.unnumbered > 0 ? `${range ? ' and ' : ''}${hidden.unnumbered} unnumbered row(s)` : '';
    return `${blank} ${'  '.repeat(hidden.depth)}… ${range}${extra} hidden (maxDepth=${maxDepth})`;
  };
  const flushHidden = () => {
    const line = hiddenLine();
    if (line !== null) push(line);
    hidden = null;
  };

  // Pages end only before a shown, numbered event, so the next page can start there. Rows
  // before it (unnumbered, hidden) stay on this page, and the first shown event always
  // does, even when it alone passes the budget, so paging always moves forward.
  let endIdx = nodes.length;
  let stoppedBy: OutlinePage['stoppedBy'] = 'end';
  let counted = 0;
  let firstEvent: number | null = null;
  let lastEvent: number | null = null;
  for (let i = startIdx; i < nodes.length; i++) {
    const node = nodes[i];
    if (maxDepth !== undefined && node.depth > maxDepth) {
      hidden ??= { depth: maxDepth + 1, first: null, last: null, unnumbered: 0 };
      if (node.number === null) hidden.unnumbered++;
      else {
        hidden.first ??= node.number;
        hidden.last = node.number;
        firstEvent ??= node.number;
        lastEvent = node.number;
      }
      continue;
    }
    const block = nodeLines(node, pad(node.number), blank);
    if (node.number !== null) {
      if (counted === limit) {
        endIdx = i;
        stoppedBy = 'limit';
        break;
      }
      const pendingHidden = hiddenLine();
      const added = linesLength(block) + (pendingHidden === null ? 0 : pendingHidden.length + 1);
      if (counted > 0 && bodyLength + added > bodyBudget) {
        endIdx = i;
        stoppedBy = 'size';
        break;
      }
      counted++;
      firstEvent ??= node.number;
      lastEvent = node.number;
    }
    flushHidden();
    for (const line of block) push(line);
  }
  flushHidden();

  const nextStartEvent = endIdx < nodes.length ? nodes[endIdx].number : null;
  const hiddenNote = maxDepth !== undefined ? ` Events deeper than level ${maxDepth} are hidden and do not count toward limit.` : '';
  const sizeNote = stoppedBy === 'size'
    ? ` Page ended at the ~${maxChars}-character size budget before limit=${limit} was reached.` : '';
  const showingLine = firstEvent === null
    ? 'No numbered events in this range.'
    : `Showing events ${firstEvent}-${lastEvent}.${sizeNote}` +
      `${nextStartEvent !== null ? ` Next page: startEvent=${nextStartEvent}.` : ''}${hiddenNote}`;

  return {
    text: [sheetLine, showingLine, ...fixedHeader, ...lines].join('\n'),
    firstEvent,
    lastEvent,
    nextStartEvent,
    stoppedBy,
  };
}
