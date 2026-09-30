/**
 * Effects named by conditions and actions (Set effect enabled, Set effect
 * parameter, ...).
 *
 * The editor saves the effect of such an ACE in its "effect" parameter as a
 * string expression holding the effect's name: `"effect": "\"AdjustHSL\""`.
 * Checked on Scirra's public example projects
 * (github.com/Scirra/Construct-Example-Projects): winter-tree
 * (set-effect-parameter), glokar, follow-custom-properties, meowgix and
 * run-n-gun-weapons (set-effect-enabled), 25 such parameters, every one a
 * single quoted name. In winter-tree the effect belongs to the family
 * "Branches" and the actions name its member "Branch": an object's
 * conditions and actions reach the effects of its families. A System ACE's
 * "effect" names a layer or layout effect and is not an object's.
 *
 * So removing a family, or a member from it, leaves such a parameter naming
 * an effect the member no longer has.
 */

import type { EventSheet } from '../types.js';

/** A condition or action that names an effect of its object. */
export interface EffectUse {
  eventSheet: string;
  /** JSON path of the event, e.g. "events[3].children[1]" */
  eventPath: string;
  /** "condition 0" or "action 2" of that event */
  ace: string;
  /** SID of the condition or action, when it has one */
  sid?: number;
  /** The condition's or action's object (as spelled in the event) */
  objectClass: string;
  /** The effect's name, as the string literal holds it; undefined when the parameter is another expression */
  name?: string;
  /** The parameter as saved */
  expression: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The name an effect parameter holds: the text of an expression that is one
 * string literal (a quote inside is written as two quotes); undefined for any
 * other expression.
 */
export function effectNameOf(expression: string): string | undefined {
  const match = /^\s*"((?:[^"]|"")*)"\s*$/.exec(expression);
  return match ? match[1].replace(/""/g, '"') : undefined;
}

/**
 * Every condition and action with a string "effect" parameter in the given
 * event sheets, except System ones (layer and layout effects). Walks events,
 * groups, function and custom action blocks and sub-events to any depth.
 */
export function findEffectUses(sheets: ReadonlyMap<string, EventSheet>): EffectUse[] {
  const uses: EffectUse[] = [];
  for (const [sheetName, sheet] of sheets) {
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
            if (!isRecord(ace) || typeof ace.objectClass !== 'string' || ace.objectClass === 'System') return;
            const expression = isRecord(ace.parameters) ? ace.parameters.effect : undefined;
            if (typeof expression !== 'string') return;
            const name = effectNameOf(expression);
            uses.push({
              eventSheet: sheetName,
              eventPath,
              ace: `${kind === 'conditions' ? 'condition' : 'action'} ${j}`,
              ...(typeof ace.sid === 'number' ? { sid: ace.sid } : {}),
              objectClass: ace.objectClass,
              ...(name !== undefined ? { name } : {}),
              expression,
            });
          });
        }
        stack.push({ events: event.children, path: `${eventPath}.children` });
      });
    }
  }
  return uses;
}

/**
 * Of `uses`, those that name an effect of `familyEffects` (ignoring case)
 * through one of `members` that does not keep an effect of that name (its
 * own, or another family's: `keptEffects`, member → effect names it has
 * without this family), and those through such a member whose effect cannot
 * be told (another expression than a quoted name).
 */
export function familyEffectUsesThroughMembers(
  uses: readonly EffectUse[],
  familyEffects: readonly string[],
  members: readonly string[],
  keptEffects: ReadonlyMap<string, readonly string[]>,
): { broken: EffectUse[]; unknown: EffectUse[] } {
  const familyKeys = new Set(familyEffects.map(e => e.toLowerCase()));
  const broken: EffectUse[] = [];
  const unknown: EffectUse[] = [];
  if (familyKeys.size === 0) return { broken, unknown };
  for (const use of uses) {
    if (!members.includes(use.objectClass)) continue;
    if (use.name === undefined) {
      unknown.push(use);
      continue;
    }
    const key = use.name.toLowerCase();
    if (!familyKeys.has(key)) continue;
    const kept = (keptEffects.get(use.objectClass) ?? []).some(e => e.toLowerCase() === key);
    if (!kept) broken.push(use);
  }
  return { broken, unknown };
}

/** Where an effect use is, for messages: '"Sheet1" events[3] action 0'. */
export function effectUseLocation(use: EffectUse): string {
  return `"${use.eventSheet}" ${use.eventPath} ${use.ace}`;
}
