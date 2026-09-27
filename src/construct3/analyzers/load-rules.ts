/**
 * Load-time rules for Construct 3 projects.
 *
 * The Construct 3 editor enforces these rules only when it opens a project, and
 * breaking one can make it refuse to open the whole project. JSON validation does
 * not catch them. The pure checks here are shared by the pre-write gate in the
 * event tools and by validate_project.
 *
 * Rules from komabear/c3-skill (MIT), checked against the Construct 3 manual, the
 * Addon SDK reference, real editor-saved folder projects, and the editor's own
 * project loader (projectResources.js of release r495.2, which throws the error
 * messages quoted below; notes per rule).
 */

import type { C3Event, Subfolder } from '../types.js';
import { findNameClash, nameKey } from '../names.js';
import { isElseCondition, DEFAULT_FUNCTIONS_OBJECT_NAME } from '../event-shapes.js';

// ─── Types ───────────────────────────────────────────────────

export type LoadRuleName =
  | 'expression-syntax'
  | 'empty-expression'
  | 'trigger-placement'
  | 'else-placement'
  | 'duplicate-object-name'
  | 'family-plugin-mismatch';

export interface LoadRuleIssue {
  rule: LoadRuleName;
  severity: 'error' | 'warning';
  /** Where the issue lives, e.g. `eventSheets/Main > block (sid 12) > condition 0 "on-key-pressed"` */
  location: string;
  message: string;
  suggestion?: string;
  /** Stable identity, used to tell issues a write introduces from pre-existing ones. */
  key: string;
}

/**
 * Where a condition or action comes from. Only `builtin` ACEs (System and addons
 * whose usedAddons author is "Scirra") are trusted to follow the `on-` trigger
 * id convention; third-party addons break it in both directions.
 */
export type AceOrigin = 'builtin' | 'addon' | 'unknown';
export type AceOriginResolver = (ace: Record<string, unknown>) => AceOrigin;

export interface EventCheckOptions {
  /** Location prefix, e.g. `eventSheets/Main` */
  sheet: string;
  aceOrigin: AceOriginResolver;
}

// ─── Constants ───────────────────────────────────────────────

const MAX_DEPTH = 50;
const MAX_NODES = 100_000;
const PREVIEW_LENGTH = 80;

// ─── Rule 1: Expression Syntax ───────────────────────────────

export type ExpressionProblem = 'backslash-outside-string' | 'unterminated-string';

/**
 * Tokenize a C3 expression just far enough to find string-literal problems.
 *
 * C3 string literals have no escape sequences: a literal quote is written as two
 * quotes (`"He said ""hi"""`, manual: Expressions > Text), which toggling the
 * in-string flag on every quote handles naturally. A backslash outside a literal
 * is not an operator and fails at editor load with "Syntax error: Unknown
 * character"; inside a literal it is plain text (real projects use regexes like
 * "^(https?:\/\/)" in string literals).
 */
export function lintExpression(value: string): { problem: ExpressionProblem; index: number } | null {
  let inString = false;
  let stringStart = -1;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '"') {
      inString = !inString;
      if (inString) stringStart = i;
    } else if (ch === '\\' && !inString) {
      return { problem: 'backslash-outside-string', index: i };
    }
  }
  return inString ? { problem: 'unterminated-string', index: stringStart } : null;
}

function preview(value: string): string {
  return value.length > PREVIEW_LENGTH ? `${value.slice(0, PREVIEW_LENGTH)}…` : value;
}

/** Label of a condition or action within its event, e.g. `action 0 "wait" (System)`. */
export function describeAce(ace: Record<string, unknown>, kind: 'condition' | 'action', index: number): string {
  if (typeof ace.callFunction === 'string') return `${kind} ${index} (call function "${ace.callFunction}")`;
  if (typeof ace.customAction === 'string') return `${kind} ${index} (custom action "${ace.customAction}")`;
  const owner = typeof ace.objectClass === 'string' ? ace.objectClass : '?';
  return `${kind} ${index} "${String(ace.id)}" (${owner})`;
}

/**
 * Check the expression parameters of one condition or action (rules 1 and 2).
 * Parameters are a dict for ordinary ACEs and an argument array for function and
 * custom action calls. Only string values are expressions: numbers, booleans and
 * objects ({ path }, { name, objectClass }) are not. Script actions hold
 * JavaScript, not C3 expressions, and are skipped.
 */
function checkAceParameters(
  ace: Record<string, unknown>,
  label: string,
  location: string,
  keyBase: string,
  out: LoadRuleIssue[],
): void {
  if (ace.type === 'script') return;
  const params = ace.parameters;
  const entries: Array<[string, unknown]> = Array.isArray(params)
    ? params.map((v, i) => [String(i), v] as [string, unknown])
    : params && typeof params === 'object'
      ? Object.entries(params as Record<string, unknown>)
      : [];

  for (const [name, value] of entries) {
    if (typeof value !== 'string') continue;
    const key = `${keyBase}|${name}|${value}`;

    // Rule 2: no real project stores "" in any parameter (0 of 108k string
    // values across 755 sheets, incl. Scirra's example projects); an empty
    // string literal is always written as "\"\"".
    if (value === '') {
      out.push({
        rule: 'empty-expression',
        severity: 'error',
        location,
        message: `Parameter "${name}" of ${label} is empty. Construct 3 fails to open the project with "Empty expression: You must enter an expression".`,
        suggestion: 'For an empty string write the literal "\\"\\"" (a JSON string holding two double quotes); for a number write 0.',
        key: `empty-expression|${key}`,
      });
      continue;
    }

    const lint = lintExpression(value);
    if (!lint) continue;
    if (lint.problem === 'backslash-outside-string') {
      out.push({
        rule: 'expression-syntax',
        severity: 'error',
        location,
        message: `Parameter "${name}" of ${label} has a backslash outside a string literal (position ${lint.index}): ${preview(value)}. C3 expressions have no escape sequences, so \\" ends the string instead of escaping the quote; the editor fails with "Syntax error: Unknown character".`,
        suggestion: 'Write a double quote inside a string literal as two double quotes, e.g. "He said ""hi""".',
        key: `expression-syntax|${key}`,
      });
    } else {
      out.push({
        rule: 'expression-syntax',
        severity: 'error',
        location,
        message: `Parameter "${name}" of ${label} has an unterminated string literal (odd number of double quotes, opened at position ${lint.index}): ${preview(value)}.`,
        suggestion: 'Close the string literal. A double quote inside a string is written as two double quotes.',
        key: `expression-syntax|${key}`,
      });
    }
  }
}

// ─── Rule 3: Trigger Placement ───────────────────────────────

/**
 * Trigger ACE ids conventionally start with "on-" (e.g. "on-start-of-layout").
 * In the built-in ACE schemas every "on-" condition is a trigger, and the only
 * built-in trigger without the prefix is Bluetooth "is-device-connected" (missed
 * here, so it is never reported). The editor counts real, fake (On collision,
 * Timer "On timer", the Gamepad button conditions: polled every tick at runtime)
 * and fast triggers alike: its condition model is
 * `isTrigger || isFakeTrigger || isFastTrigger`.
 */
export function isTriggerId(id: unknown): boolean {
  return typeof id === 'string' && id.startsWith('on-');
}

type TriggerKind = 'trigger' | 'possible-trigger';

function classifyCondition(cond: Record<string, unknown>, aceOrigin: AceOriginResolver): TriggerKind | null {
  if (!isTriggerId(cond.id)) return null;
  // Every "on-" id from System and Scirra addons in 755 real sheets obeys the
  // trigger rules. Third-party addons do not reliably follow the convention
  // (non-trigger "on-" ids and triggers without the prefix both exist), so their
  // violations are reported as warnings only.
  return aceOrigin(cond) === 'builtin' ? 'trigger' : 'possible-trigger';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/** The nearest ancestor that makes an event branch "triggered". */
interface TriggerRoot {
  label: string;
  confirmed: boolean;
}

/** Label of an event for locations, e.g. `block (sid 12)` or `group "UI" (sid 3)`. */
export function describeEvent(ev: Record<string, unknown>): string {
  const sid = typeof ev.sid === 'number' ? ` (sid ${ev.sid})` : '';
  switch (ev.eventType) {
    case 'function-block':
      return `function "${String(ev.functionName)}"${sid}`;
    case 'custom-ace-block':
      return `custom action ${String(ev.objectClass)}.${String(ev.aceName)}${sid}`;
    case 'group':
      return `group "${String(ev.title)}"${sid}`;
    default:
      return `${String(ev.eventType)}${sid}`;
  }
}

/**
 * Identity of a condition or action within its event, for issue keys. Real
 * projects give every condition and action a SID except comment and script
 * actions; without one, the ACE is identified by what it calls rather than by
 * its index, so edits that shift indices do not make an old issue look new.
 */
function aceId(ace: Record<string, unknown>): string {
  if (typeof ace.sid === 'number') return String(ace.sid);
  const target = ace.callFunction ?? ace.customAction ?? ace.id ?? ace.type;
  return `~${String(ace.objectClass ?? '')}.${String(target)}`;
}

function loadFailure(confirmed: boolean): string {
  return confirmed
    ? 'Construct 3 fails to open the project with "cannot add another trigger to event branch"'
    : 'Construct 3 may refuse to open the project ("cannot add another trigger to event branch") if this is a trigger branch';
}

/**
 * Check trigger placement for one event (rule 3). Semantics, per the manual
 * (How events work, Sub-events) and the editor's loader, which adds each
 * condition of a block through the same method the event sheet view uses:
 * - AND blocks: a second trigger throws "cannot add another trigger to event
 *   branch". A trigger after other conditions is not refused: the loader
 *   inserts it before the first condition, so the editor silently reorders the
 *   event. That changes the order conditions are tested in, so it is a warning.
 * - OR blocks (`isOrBlock: true`): any number of triggers in any position.
 * - A branch holds one trigger: no trigger under an ancestor that has one, or
 *   under a function block or custom action block (both count as holding a
 *   trigger in the editor's model). Groups are transparent.
 */
function checkTriggers(
  ev: Record<string, unknown>,
  location: string,
  keyBase: string,
  root: TriggerRoot | undefined,
  aceOrigin: AceOriginResolver,
  out: LoadRuleIssue[],
): TriggerRoot | undefined {
  const conditions = Array.isArray(ev.conditions) ? ev.conditions as unknown[] : [];
  const triggers: Array<{ c: Record<string, unknown>; i: number; kind: TriggerKind }> = [];
  conditions.forEach((c, i) => {
    if (!isObject(c)) return;
    const kind = classifyCondition(c, aceOrigin);
    if (kind) triggers.push({ c, i, kind });
  });

  const isFunction = ev.eventType === 'function-block';
  const isCustomAction = ev.eventType === 'custom-ace-block';

  // Function and custom action blocks are trigger roots themselves, so a
  // trigger among their own conditions is already "another trigger". In the
  // editor both block types derive from one class that always reports a
  // trigger ("On function"; manual: custom actions work like functions).
  const ownRoot: TriggerRoot | undefined = isFunction || isCustomAction
    ? { label: describeEvent(ev), confirmed: true }
    : undefined;
  const branchRoot = root ?? ownRoot;

  if (branchRoot) {
    for (const t of triggers) {
      const confirmed = t.kind === 'trigger' && branchRoot.confirmed;
      out.push({
        rule: 'trigger-placement',
        severity: confirmed ? 'error' : 'warning',
        location: `${location} > condition ${t.i} "${String(t.c.id)}"`,
        message: `Trigger "${String(t.c.id)}" is inside the event branch of ${branchRoot.label}, which already acts as a trigger. An event branch may contain only one trigger; ${loadFailure(confirmed)}.`,
        suggestion: 'Move this event out of the triggered branch (e.g. to the top level or into a group), or replace the trigger with a non-trigger condition.',
        key: `trigger-nested|${keyBase}|${aceId(t.c)}`,
      });
    }
  }

  // Both AND-block issues share one key per event, so removing some of several
  // triggers (a partial fix) is not mistaken for a new problem. A trigger after
  // the "else" condition of an else block is reported by rule 4 instead, since
  // "put the trigger first" would take Else off its first place.
  const elseBlock = isElseCondition(conditions[0]);
  if (ev.isOrBlock !== true) {
    if (triggers.length > 1) {
      const confirmed = triggers.every(t => t.kind === 'trigger');
      out.push({
        rule: 'trigger-placement',
        severity: confirmed ? 'error' : 'warning',
        location,
        message: `Event has ${triggers.length} triggers (${triggers.map(t => `"${String(t.c.id)}"`).join(', ')}). Only one trigger is allowed per event unless it is an OR block; ${loadFailure(confirmed)}.`,
        suggestion: 'Split the triggers into separate events, one trigger each, or make the event an OR block (isOrBlock: true in add_event_block or update_event_block; a per-condition "isOr" flag does not make one).',
        key: `trigger-block|${keyBase}`,
      });
    } else if (triggers.length === 1 && triggers[0].i > 0 && !elseBlock) {
      const t = triggers[0];
      out.push({
        rule: 'trigger-placement',
        severity: 'warning',
        location: `${location} > condition ${t.i} "${String(t.c.id)}"`,
        message: `Trigger "${String(t.c.id)}" is condition ${t.i}, but a trigger must be the first condition of its event${t.kind === 'trigger' ? '' : ' (if this addon condition is a trigger)'}. Construct 3 moves it to the top when it opens the project, so the conditions before it will be tested after it.`,
        suggestion: 'Put the trigger first and the other conditions after it.',
        key: `trigger-block|${keyBase}`,
      });
    }
  }

  // The root passed to children: the nearest triggering event, preferring a
  // confirmed root over an unconfirmed one.
  const eventRoot: TriggerRoot | undefined = ownRoot ?? (triggers.length > 0
    ? { label: describeEvent(ev), confirmed: triggers.some(t => t.kind === 'trigger') }
    : undefined);
  if (!root) return eventRoot;
  if (!eventRoot) return root;
  return eventRoot.confirmed || !root.confirmed ? eventRoot : root;
}

// ─── Rule 4: Else Placement ──────────────────────────────────

/** Why an else block cannot stand where it is (see elsePlacementProblem). */
export type ElsePlacementProblem =
  | { kind: 'no-block-before'; previousType?: string }
  | { kind: 'after-trigger'; trigger: Record<string, unknown> }
  | { kind: 'holds-trigger'; trigger: Record<string, unknown> };

/**
 * The event an else block belongs to: the nearest sibling before index `i`
 * that is not a comment, or undefined. Comments do not run, and editor saves
 * have comments between a block and its else block.
 */
export function previousNonComment(list: readonly unknown[], i: number): unknown {
  for (let j = i - 1; j >= 0; j--) {
    const event = list[j];
    if (!isObject(event) || event.eventType !== 'comment') return event;
  }
  return undefined;
}

/**
 * Check where an else block stands. The manual (System conditions, Else):
 * "Else can only follow normal (non-triggered) events. It can also follow
 * another Else event with other conditions". Editor-saved r449 sheets agree:
 * every else block follows a block, directly or with comments between (see
 * previousNonComment), none follows a block with a trigger condition, and
 * none holds a trigger itself (the loader would move that trigger before the
 * "else" condition, see rule 3). `previous` is the nearest sibling before the
 * else block that is not a comment, `conditions` the else block's own,
 * starting with the "else" condition. Triggers are recognised by id (`on-`).
 */
export function elsePlacementProblem(previous: unknown, conditions: ReadonlyArray<unknown>): ElsePlacementProblem | null {
  const findTrigger = (list: unknown): Record<string, unknown> | undefined =>
    Array.isArray(list) ? list.find((c): c is Record<string, unknown> => isObject(c) && isTriggerId(c.id)) : undefined;

  if (!isObject(previous) || previous.eventType !== 'block') {
    return { kind: 'no-block-before', ...(isObject(previous) ? { previousType: String(previous.eventType) } : {}) };
  }
  const before = findTrigger(previous.conditions);
  if (before) return { kind: 'after-trigger', trigger: before };
  const own = findTrigger(conditions.slice(1));
  if (own) return { kind: 'holds-trigger', trigger: own };
  return null;
}

/** The problem in words, e.g. for messages of the event tools and the legacy shape repair. */
export function describeElsePlacementProblem(problem: ElsePlacementProblem): string {
  switch (problem.kind) {
    case 'no-block-before':
      return `${problem.previousType ? `the event before it is a ${problem.previousType}` : 'no event comes before it'} (comments aside), ` +
        'so there is no block for it to be the else of (Construct 3 saves an else block after a block, with at most comments between)';
    case 'after-trigger':
      return `the block before it is triggered by "${String(problem.trigger.id)}", but Else can only follow normal (non-triggered) events`;
    case 'holds-trigger':
      return `it holds the trigger "${String(problem.trigger.id)}". When Construct 3 opens the project it moves a trigger ` +
        'before the other conditions of its event, which would take Else off the first place (editor saves always have it first)';
  }
}

const ELSE_PLACEMENT_SUGGESTIONS: Record<ElsePlacementProblem['kind'], string> = {
  'no-block-before': 'Move the else block after the block it is the else of (only comments may stand between them), or remove its "else" condition (update_event_block with isElse: false).',
  'after-trigger': 'To branch inside a trigger, add sub-events under the triggered event: one with the condition, then the else block right after it. Or remove the "else" condition (update_event_block with isElse: false).',
  'holds-trigger': 'Put the trigger in its own event, or remove the "else" condition (update_event_block with isElse: false).',
};

/**
 * Rule 4 for one block. Whether the editor refuses to open a project that
 * breaks it is not verified, so it is always a warning.
 */
function checkElsePlacement(
  ev: Record<string, unknown>,
  siblings: readonly unknown[],
  index: number,
  location: string,
  keyBase: string,
  aceOrigin: AceOriginResolver,
  out: LoadRuleIssue[],
): void {
  if (ev.eventType !== 'block' || !Array.isArray(ev.conditions) || !isElseCondition(ev.conditions[0])) return;
  // Looked up only for else blocks: the comment runs before distinct else
  // blocks do not overlap, so the walk stays linear in the sheet size.
  const problem = elsePlacementProblem(previousNonComment(siblings, index), ev.conditions);
  if (!problem) return;
  const addonTrigger = problem.kind !== 'no-block-before' && classifyCondition(problem.trigger, aceOrigin) === 'possible-trigger'
    ? ' (if this addon condition is a trigger)'
    : '';
  out.push({
    rule: 'else-placement',
    severity: 'warning',
    location,
    message: `Else block: ${describeElsePlacementProblem(problem)}${addonTrigger}. The event may not run as intended; whether Construct 3 refuses to open the project is not verified.`,
    suggestion: ELSE_PLACEMENT_SUGGESTIONS[problem.kind],
    key: `else-placement|${keyBase}`,
  });
}

// ─── Event Sheet Walk (rules 1–4) ────────────────────────────

/**
 * Check every event of a sheet for expression, trigger-placement and
 * else-placement problems. Walks conditions and actions of blocks, function
 * blocks and custom action blocks; comments, variable initial values and
 * script actions are not linted.
 */
export function checkEventLoadRules(events: C3Event[], opts: EventCheckOptions): LoadRuleIssue[] {
  const out: LoadRuleIssue[] = [];
  const stack: Array<{
    event: Record<string, unknown>;
    /** The list holding the event and its index there (for else placement) */
    siblings: unknown[];
    index: number;
    location: string;
    root: TriggerRoot | undefined;
    depth: number;
  }> = [];
  const push = (list: unknown, parentLocation: string, root: TriggerRoot | undefined, depth: number) => {
    if (!Array.isArray(list)) return;
    for (let i = list.length - 1; i >= 0; i--) {
      const event = list[i];
      if (!isObject(event)) continue;
      stack.push({ event, siblings: list, index: i, location: `${parentLocation} > ${describeEvent(event)}`, root, depth });
    }
  };
  push(events, opts.sheet, undefined, 0);

  let nodes = 0;
  while (stack.length > 0) {
    if (nodes++ > MAX_NODES) break;
    const { event, siblings, index, location, root, depth } = stack.pop()!;
    if (depth > MAX_DEPTH) continue;

    // Identity for issue keys: the SID, or else the location, which names the
    // ancestors but no array indices, so issues survive index shifts from edits.
    const keyBase = `${opts.sheet}|${typeof event.sid === 'number' ? event.sid : `~${location}`}`;

    const conditions = Array.isArray(event.conditions) ? event.conditions as unknown[] : [];
    conditions.forEach((c, i) => {
      if (!isObject(c)) return;
      const label = describeAce(c, 'condition', i);
      checkAceParameters(c, label, `${location} > ${label}`, `${keyBase}|c${aceId(c)}`, out);
    });
    const actions = Array.isArray(event.actions) ? event.actions as unknown[] : [];
    actions.forEach((a, i) => {
      if (!isObject(a)) return;
      const label = describeAce(a, 'action', i);
      checkAceParameters(a, label, `${location} > ${label}`, `${keyBase}|a${aceId(a)}`, out);
    });

    // Groups (and other condition-less events) are transparent to the branch.
    const childRoot = Array.isArray(event.conditions)
      ? checkTriggers(event, location, keyBase, root, opts.aceOrigin, out)
      : root;
    checkElsePlacement(event, siblings, index, location, keyBase, opts.aceOrigin, out);
    push(event.children, location, childRoot, depth + 1);
  }
  return out;
}

/** Object classes of trigger-like conditions (for loading only what origin lookups need). */
export function collectTriggerObjectClasses(events: C3Event[]): Set<string> {
  const names = new Set<string>();
  const stack: Array<{ list: unknown; depth: number }> = [{ list: events, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const { list, depth } = stack.pop()!;
    if (!Array.isArray(list) || depth > MAX_DEPTH) continue;
    for (const ev of list) {
      if (nodes++ > MAX_NODES) return names;
      if (!ev || typeof ev !== 'object') continue;
      const rec = ev as Record<string, unknown>;
      if (Array.isArray(rec.conditions)) {
        for (const c of rec.conditions as Array<Record<string, unknown>>) {
          if (c && isTriggerId(c.id) && typeof c.objectClass === 'string' && c.objectClass !== 'System') {
            names.add(c.objectClass);
          }
        }
      }
      stack.push({ list: rec.children, depth: depth + 1 });
    }
  }
  return names;
}

const SEVERITY_RANK = { warning: 1, error: 2 } as const;

/**
 * Issues present in `after` but not in `before`. An issue counts as already
 * present only when `before` has one with the same key and the same or a higher
 * severity, so a warning that an edit turns into an error is new. Keys are
 * matched as a multiset: one old issue excuses one new one.
 */
export function newLoadRuleIssues(before: LoadRuleIssue[], after: LoadRuleIssue[]): LoadRuleIssue[] {
  const pool = new Map<string, number[]>(); // key → severity ranks, ascending
  for (const issue of before) {
    const ranks = pool.get(issue.key) ?? [];
    ranks.push(SEVERITY_RANK[issue.severity]);
    pool.set(issue.key, ranks);
  }
  for (const ranks of pool.values()) ranks.sort((a, b) => a - b);

  // Match errors first, so a pre-existing error excuses an error rather than a warning.
  const excused = new Set<LoadRuleIssue>();
  const bySeverity = [...after].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  for (const issue of bySeverity) {
    const ranks = pool.get(issue.key);
    if (!ranks) continue;
    const index = ranks.findIndex(rank => rank >= SEVERITY_RANK[issue.severity]);
    if (index === -1) continue;
    ranks.splice(index, 1);
    excused.add(issue);
  }
  return after.filter(issue => !excused.has(issue));
}

export function formatLoadRuleIssue(issue: LoadRuleIssue): string {
  return `${issue.location}: ${issue.message}${issue.suggestion ? ` ${issue.suggestion}` : ''}`;
}

/** Error text for a write that a pre-write load-time check blocked. */
export function loadRuleErrorMessage(errors: string[]): string {
  return 'Construct 3 load-time check failed; nothing was written. ' +
    'The editor enforces these rules when it opens the project, and breaking them can make the whole project fail to open:\n' +
    errors.map(e => `- ${e}`).join('\n');
}

// ─── ACE Origin ──────────────────────────────────────────────

export interface AceOriginData {
  objects: Map<string, Record<string, unknown>>;
  families: Map<string, Record<string, unknown>>;
  usedAddons: ReadonlyArray<{ type: string; id: string; author?: string }>;
  /** Name of the built-in Functions object (project.c3proj functionsName; default "Functions") */
  functionsName?: string;
}

function findBehaviorId(owner: Record<string, unknown> | undefined, behaviorName: string): string | undefined {
  if (!owner || !Array.isArray(owner.behaviorTypes)) return undefined;
  const entry = (owner.behaviorTypes as Array<Record<string, unknown>>).find(b => b && b.name === behaviorName);
  return entry && typeof entry.behaviorId === 'string' ? entry.behaviorId : undefined;
}

/**
 * Resolve whether an ACE comes from a built-in addon. System is never listed in
 * usedAddons (0 of 576 real projects) and is always built in, and so is the
 * Functions object (functionsName), whose actions the editor's ACE list keeps
 * with the System plugin; every other ACE is
 * traced to its plugin (object or family `plugin-id`) or behavior (`behaviorType`
 * name → `behaviorId`, looked up on the object and on the families it belongs
 * to) and then to the usedAddons author, which is "Scirra" for built-in addons.
 */
export function createAceOriginResolver(data: AceOriginData): AceOriginResolver {
  const authors = new Map<string, string>();
  for (const addon of data.usedAddons) {
    if (addon && typeof addon.id === 'string' && typeof addon.author === 'string') {
      authors.set(`${addon.type}:${addon.id}`, addon.author);
    }
  }

  return (ace) => {
    const objectClass = ace.objectClass;
    if (objectClass === 'System') return 'builtin';
    if (typeof objectClass !== 'string') return 'unknown';
    const owner = data.objects.get(objectClass) ?? data.families.get(objectClass);
    if (!owner) return objectClass === (data.functionsName ?? DEFAULT_FUNCTIONS_OBJECT_NAME) ? 'builtin' : 'unknown';

    // Real projects write "behaviorType"; older writes of this server used "behavior-type".
    const behaviorName = ace.behaviorType ?? ace['behavior-type'];
    let addonKey: string;
    if (typeof behaviorName === 'string') {
      let behaviorId = findBehaviorId(owner, behaviorName);
      if (!behaviorId) {
        for (const family of data.families.values()) {
          if (Array.isArray(family.members) && (family.members as unknown[]).includes(objectClass)) {
            behaviorId = findBehaviorId(family, behaviorName);
            if (behaviorId) break;
          }
        }
      }
      if (!behaviorId) return 'unknown';
      addonKey = `behavior:${behaviorId}`;
    } else {
      const pluginId = owner['plugin-id'];
      if (typeof pluginId !== 'string') return 'unknown';
      addonKey = `plugin:${pluginId}`;
    }

    const author = authors.get(addonKey);
    if (author === undefined) return 'unknown';
    return author === 'Scirra' ? 'builtin' : 'addon';
  };
}

/** Resolver that trusts only System — needs no project data. */
export const systemOnlyAceOrigin: AceOriginResolver = (ace) =>
  ace.objectClass === 'System' ? 'builtin' : 'unknown';

// ─── Rule 4: Object Class Names ──────────────────────────────

interface FolderTree {
  items: string[];
  subfolders: Subfolder[];
}

function flattenTree(tree: FolderTree | undefined): string[] {
  const out: string[] = [];
  const walk = (node: { items?: unknown; subfolders?: unknown }, depth: number) => {
    if (depth > MAX_DEPTH) return;
    if (Array.isArray(node.items)) {
      for (const item of node.items) if (typeof item === 'string') out.push(item);
    }
    if (Array.isArray(node.subfolders)) {
      for (const sub of node.subfolders) if (sub && typeof sub === 'object') walk(sub as FolderTree, depth + 1);
    }
  };
  if (tree) walk(tree, 0);
  return out;
}

/**
 * Object types and families are both "object classes" in the editor and share
 * one name namespace, compared after Unicode normalization and ignoring case
 * (Addon SDK: IProject.GetObjectClassByName returns either; see names.ts).
 */
export function normalizeObjectClassName(name: string): string {
  return nameKey(name);
}

type ObjectClassKind = 'object type' | 'family';

function objectClassLoadError(name: string): string {
  return `Construct 3 fails to open the project with "object class name '${name}' already used"`;
}

/**
 * The object classes the editor creates for every project, before it reads
 * the project's object types and families: System and the built-in Functions
 * object, which it names after project.c3proj "functionsName" ("Functions"
 * without the key). Both take their names in the object class namespace
 * (projectResources.js r495.2: the project model creates both classes and
 * then sets the Functions object's name from "functionsName"; an object class
 * whose name is already taken, ignoring case, throws "object class name '...'
 * already used", and the Functions object's rename dialog refuses such names).
 */
export function builtinObjectClassNames(functionsName: unknown): string[] {
  return ['System', typeof functionsName === 'string' && functionsName !== '' ? functionsName : DEFAULT_FUNCTIONS_OBJECT_NAME];
}

/**
 * The built-in object class (System or the Functions object, see
 * builtinObjectClassNames) whose name `name` takes, ignoring case, for the
 * pre-write checks of create_object and create_family.
 */
export function findBuiltinObjectClassClash(name: string, functionsName: unknown): string | undefined {
  const target = normalizeObjectClassName(name);
  return builtinObjectClassNames(functionsName).find(b => normalizeObjectClassName(b) === target);
}

function describeBuiltin(builtin: string): string {
  return builtin === 'System' ? 'the built-in System object' : `the built-in Functions object ("${builtin}", functionsName in project.c3proj)`;
}

/** Error text for a create_object/create_family name that takes the name of a built-in object class. */
export function builtinObjectClassClashMessage(name: string, builtin: string): string {
  return `"${name}" is the name of ${describeBuiltin(builtin)}, ignoring case. Construct 3 creates it for every project, ` +
    `in the name namespace object types and families share, and ${objectClassLoadError(name)}. Choose a different name.`;
}

/**
 * Object class names must be unique across the objectTypes and families trees,
 * all subfolders included. The editor's loader creates one object class per
 * listed name and refuses a name that is already taken, ignoring case, with
 * "object class name 'X' already used" (komabear/c3-skill reported it as
 * "object type name 'X' already used" for a name listed twice). So exact
 * duplicates, case-only duplicates and object type/family clashes all break
 * loading, and so does an object type or family named like one of the
 * built-in object classes (builtinObjectClassNames).
 */
export function checkObjectClassNames(project: {
  objectTypes?: FolderTree;
  families?: FolderTree;
  functionsName?: unknown;
}): LoadRuleIssue[] {
  const out: LoadRuleIssue[] = [];
  const groups = new Map<string, Array<{ name: string; kind: ObjectClassKind }>>();
  const add = (name: string, kind: ObjectClassKind) => {
    const key = normalizeObjectClassName(name);
    const list = groups.get(key) ?? [];
    list.push({ name, kind });
    groups.set(key, list);
  };
  for (const name of flattenTree(project.objectTypes)) add(name, 'object type');
  for (const name of flattenTree(project.families)) add(name, 'family');
  const builtins = builtinObjectClassNames(project.functionsName);

  for (const [normalized, list] of groups) {
    const builtin = builtins.find(b => normalizeObjectClassName(b) === normalized);
    if (builtin) {
      out.push({
        rule: 'duplicate-object-name',
        severity: 'error',
        location: `project.c3proj > ${list.map(e => `${e.kind} "${e.name}"`).join(', ')}`,
        message: `${list.map(e => `${e.kind} "${e.name}"`).join(' and ')} ${list.length > 1 ? 'have' : 'has'} the name of ${describeBuiltin(builtin)}, ignoring case. ` +
          `Construct 3 creates it for every project, in the name namespace object types and families share; ${objectClassLoadError(list[0].name)}.`,
        suggestion: `Rename the ${list.length > 1 ? 'object classes' : list[0].kind} so no object type or family is named like System or the Functions object.`,
        key: `object-name-clash|${normalized}`,
      });
      continue;
    }
    if (list.length < 2) continue;
    const first = list[0];
    const sameEntry = list.every(e => e.name === first.name && e.kind === first.kind);
    const tree = first.kind === 'family' ? 'families' : 'objectTypes';
    out.push({
      rule: 'duplicate-object-name',
      severity: 'error',
      location: sameEntry
        ? `project.c3proj > ${tree} > "${first.name}"`
        : `project.c3proj > ${list.map(e => `${e.kind} "${e.name}"`).join(', ')}`,
      message: sameEntry
        ? `${first.kind === 'family' ? 'Family' : 'Object type'} name "${first.name}" is registered ${list.length} times in the ${tree} tree. ${objectClassLoadError(first.name)}.`
        : `${list.map(e => `${e.kind} "${e.name}"`).join(' and ')} share a name. Object types and families share one name namespace that ignores case; ${objectClassLoadError(list[1].name)}.`,
      suggestion: sameEntry
        ? `Remove the duplicate entries from the ${tree} items/subfolders in project.c3proj.`
        : 'Rename one of them so every object type and family name is unique regardless of case.',
      key: `object-name-clash|${normalized}`,
    });
  }
  return out;
}

/**
 * The existing object type or family whose name clashes with `name` (see
 * checkObjectClassNames), for the pre-write checks of create_object and
 * create_family.
 */
export function findObjectClassNameClash(
  name: string,
  objectTypeNames: Iterable<string>,
  familyNames: Iterable<string>,
): { name: string; kind: ObjectClassKind } | undefined {
  const objectType = findNameClash(name, objectTypeNames);
  if (objectType !== undefined) return { name: objectType, kind: 'object type' };
  const family = findNameClash(name, familyNames);
  if (family !== undefined) return { name: family, kind: 'family' };
  return undefined;
}

/** Error text for a create_object/create_family name that clashes with an existing object class. */
export function objectClassNameClashMessage(name: string, clash: { name: string; kind: ObjectClassKind }): string {
  const what = clash.name === name
    ? `${clash.kind === 'family' ? 'A family' : 'An object type'} named "${clash.name}" already exists`
    : `"${name}" clashes with the existing ${clash.kind} "${clash.name}"`;
  return `${what}. Object types and families share one name namespace that ignores case, and ${objectClassLoadError(name)}. Choose a different name.`;
}

// ─── Rule 5: Family Plugin Homogeneity ───────────────────────

/**
 * "All the object types in a family must be from the same plugin" (manual:
 * Families). The editor's loader sets a family's members in one step that takes
 * the plugin of the first member and throws "wrong plugin" for any member with
 * another plugin (komabear/c3-skill traced its "Error: wrong plugin" load failure
 * to this). Members that do not exist are skipped here.
 *
 * Each mismatching member is reported against the family's "plugin-id" when a
 * member uses it, else against the first member. Members that all agree with
 * each other but not with the family's "plugin-id" are only a warning: the
 * loader then adopts the members' plugin, and no load failure is on record.
 */
export function checkFamilyPlugins(
  families: Map<string, Record<string, unknown>>,
  objects: Map<string, Record<string, unknown>>,
): LoadRuleIssue[] {
  const out: LoadRuleIssue[] = [];
  for (const [familyName, family] of families) {
    if (!Array.isArray(family.members)) continue;
    const members = (family.members as unknown[]).filter((m): m is string => typeof m === 'string');
    const familyPlugin = typeof family['plugin-id'] === 'string' ? family['plugin-id'] as string : undefined;
    const memberPlugins = members
      .map(m => ({ name: m, pluginId: objects.get(m)?.['plugin-id'] }))
      .filter((m): m is { name: string; pluginId: string } => typeof m.pluginId === 'string');
    if (memberPlugins.length === 0) continue;

    const mixed = memberPlugins.some(m => m.pluginId !== memberPlugins[0].pluginId);
    if (!mixed) {
      const pluginId = memberPlugins[0].pluginId;
      if (familyPlugin !== undefined && pluginId !== familyPlugin) {
        out.push({
          rule: 'family-plugin-mismatch',
          severity: 'warning',
          location: `families/${familyName}`,
          message: `Family "${familyName}" is declared with plugin "${familyPlugin}", but all its members are "${pluginId}" objects.`,
          suggestion: `Set the family's "plugin-id" to "${pluginId}", or give it "${familyPlugin}" members.`,
          key: `family-plugin-declared|${familyName}`,
        });
      }
      continue;
    }

    const expected = familyPlugin !== undefined && memberPlugins.some(m => m.pluginId === familyPlugin)
      ? familyPlugin
      : memberPlugins[0].pluginId;
    for (const member of memberPlugins) {
      if (member.pluginId === expected) continue;
      out.push({
        rule: 'family-plugin-mismatch',
        severity: 'error',
        location: `families/${familyName} > member "${member.name}"`,
        message: `Family "${familyName}" has "${expected}" members, but member "${member.name}" is a "${member.pluginId}" object. All object types in a family must be from the same plugin; Construct 3 fails to open the project with "wrong plugin".`,
        suggestion: `Remove "${member.name}" from the family, or put it in a family of "${member.pluginId}" objects.`,
        key: `family-plugin-mismatch|${familyName}|${member.name}`,
      });
    }
  }
  return out;
}

// ─── Rule 6: Duplicate SIDs in Object Type and Family Files ──

/** Object classes: object types and families. */
const OBJECT_CLASS_SID_KINDS: ReadonlySet<string> = new Set(['object', 'family']);

/**
 * SID kinds stored in object type and family files whose duplicates get a
 * specific warning (see classifySidDuplicate). Animation and frame SIDs are not
 * among them: Scirra's own "persistent-layouts" example
 * (Construct-Example-Projects) gives two object types the animation SID 17 and
 * opens fine. They get the generic warning, like other duplicate kinds (events,
 * layouts, instances).
 */
export const OBJECT_FILE_SID_KINDS: ReadonlySet<string> = new Set([
  ...OBJECT_CLASS_SID_KINDS,
  'behavior',
  'instance-variable',
  'family-behavior',
  'family-instance-variable',
]);

/** Parameters of function blocks and custom action blocks. */
const PARAMETER_SID_KINDS: ReadonlySet<string> = new Set(['function-parameter', 'parameter']);

/**
 * Event sheet and layout nodes whose duplicate SIDs are common in editor-saved
 * projects: the editor opens them and keeps the duplicates when it saves.
 */
const EVENT_OR_INSTANCE_SID_KINDS: ReadonlySet<string> = new Set(['event', 'condition', 'action', 'layout-instance']);

export type SidDuplicateImpact = 'object-class' | 'parameter' | 'object-file' | 'event-or-instance' | null;

/**
 * How a duplicate SID affects loading, from the kinds of its locations:
 * - 'object-class': two object types/families share a SID. The editor keeps one
 *   SID map of object classes and fails to open the project with "object class
 *   sid already in use" (error).
 * - 'parameter': a function or custom action parameter is involved. The loader
 *   of r495.2 checks function parameter SIDs for uniqueness, so this is a
 *   warning that does not claim the clash is harmless.
 * - 'object-file': a behavior or instance variable SID collides with another
 *   SID from an object type or family file. komabear/c3-skill lists this as
 *   load-breaking, but the failure it saw ("wrong plugin") was traced to family
 *   plugins (see checkFamilyPlugins), and the loader of r495.2 checks only
 *   object class and function parameter SIDs for uniqueness. With no load
 *   failure on record, this is a warning with specific wording.
 * - 'event-or-instance': only events, conditions, actions and layout instances.
 *   No load failure is on record, and git history of editor-saved projects shows
 *   the editor keeping such duplicates across many saves: re-saving does not
 *   give them new SIDs.
 * - null: any other mix (animations, layouts, layers, sheets...). No load impact
 *   on record (generic warning).
 */
export function classifySidDuplicate(kinds: string[]): SidDuplicateImpact {
  if (kinds.filter(k => OBJECT_CLASS_SID_KINDS.has(k)).length >= 2) return 'object-class';
  if (kinds.some(k => PARAMETER_SID_KINDS.has(k))) return 'parameter';
  if (kinds.filter(k => OBJECT_FILE_SID_KINDS.has(k)).length >= 2) return 'object-file';
  if (kinds.length > 0 && kinds.every(k => EVENT_OR_INSTANCE_SID_KINDS.has(k))) return 'event-or-instance';
  return null;
}

/** Whether a duplicate SID makes the editor refuse to open the project. */
export function isLoadBreakingSidDuplicate(kinds: string[]): boolean {
  return classifySidDuplicate(kinds) === 'object-class';
}
