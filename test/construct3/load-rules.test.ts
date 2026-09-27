/**
 * Unit tests for the editor load-time rules (shared by the pre-write gate and validate_project).
 */

import { describe, it, expect } from 'vitest';
import {
  lintExpression,
  checkEventLoadRules,
  elsePlacementProblem,
  describeElsePlacementProblem,
  previousNonComment,
  checkObjectClassNames,
  checkFamilyPlugins,
  classifySidDuplicate,
  collectTriggerObjectClasses,
  createAceOriginResolver,
  findObjectClassNameClash,
  findBuiltinObjectClassClash,
  builtinObjectClassNames,
  isLoadBreakingSidDuplicate,
  newLoadRuleIssues,
  systemOnlyAceOrigin,
  type AceOriginResolver,
  type LoadRuleIssue,
} from '../../src/construct3/analyzers/load-rules.js';
import type { C3Event } from '../../src/construct3/types.js';

const builtin: AceOriginResolver = () => 'builtin';
const check = (events: unknown[], aceOrigin: AceOriginResolver = builtin) =>
  checkEventLoadRules(events as C3Event[], { sheet: 'eventSheets/Main', aceOrigin });

function block(sid: number, conditions: unknown[], actions: unknown[] = [], extra: Record<string, unknown> = {}) {
  return { eventType: 'block', sid, conditions, actions, ...extra };
}
const cond = (id: string, sid: number, objectClass = 'System', extra: Record<string, unknown> = {}) =>
  ({ id, objectClass, sid, ...extra });
const act = (id: string, sid: number, parameters: Record<string, unknown>) =>
  ({ id, objectClass: 'System', sid, parameters });

// ─── Rule 1: expression syntax ──────────────────────────────

describe('lintExpression', () => {
  it('accepts plain expressions and string literals', () => {
    expect(lintExpression('Player.X + 10')).toBeNull();
    expect(lintExpression('"Hello" & newline & "world"')).toBeNull();
    expect(lintExpression('""')).toBeNull();
  });

  it('accepts doubled quotes inside a string literal', () => {
    expect(lintExpression('"He said ""hi"" to me"')).toBeNull();
    expect(lintExpression('"{""c2dictionary"":true}"')).toBeNull();
  });

  it('accepts a backslash inside a string literal', () => {
    expect(lintExpression('"C:\\folder\\" & name')).toBeNull();
    expect(lintExpression('RegexMatchCount(Browser.URL, "^(https?:\\/\\/)", "gi")')).toBeNull();
  });

  it('rejects a backslash outside a string literal', () => {
    // The JSON value "{\"a\":1}" is the expression "{\"a\":1}": the string ends at \ .
    const result = lintExpression('"{\\"a\\":1}"');
    expect(result?.problem).toBe('backslash-outside-string');
    expect(lintExpression('score \\ 2')?.problem).toBe('backslash-outside-string');
  });

  it('rejects an unterminated string literal', () => {
    const result = lintExpression('"Hello & name');
    expect(result).toEqual({ problem: 'unterminated-string', index: 0 });
    expect(lintExpression('"a" & "b')?.problem).toBe('unterminated-string');
  });
});

describe('checkEventLoadRules — expression parameters', () => {
  it('flags a backslash-escaped quote in an action parameter as an error', () => {
    const issues = check([block(1, [cond('every-tick', 2)], [act('set-text', 3, { text: '"{\\"a\\":1}"' })])]);
    expect(issues).toHaveLength(1);
    expect(issues[0].rule).toBe('expression-syntax');
    expect(issues[0].severity).toBe('error');
    expect(issues[0].message).toContain('Syntax error: Unknown character');
    expect(issues[0].location).toContain('action 0 "set-text"');
  });

  it('flags an unterminated string in a condition parameter', () => {
    const issues = check([block(1, [cond('compare-two-values', 2, 'System', { parameters: { 'first-value': '"abc', comparison: 0, 'second-value': '1' } })])]);
    expect(issues.map(i => i.rule)).toEqual(['expression-syntax']);
    expect(issues[0].message).toContain('unterminated');
  });

  it('flags an empty parameter as an error and accepts the empty string literal', () => {
    const bad = check([block(1, [cond('every-tick', 2)], [act('set-eventvar-value', 3, { variable: 'name', value: '' })])]);
    expect(bad).toHaveLength(1);
    expect(bad[0].rule).toBe('empty-expression');
    expect(bad[0].severity).toBe('error');
    expect(bad[0].message).toContain('Empty expression');

    const good = check([block(1, [cond('every-tick', 2)], [act('set-eventvar-value', 3, { variable: 'name', value: '""' })])]);
    expect(good).toEqual([]);
  });

  it('checks function and custom action call argument lists', () => {
    const issues = check([block(1, [cond('every-tick', 2)], [
      { callFunction: 'Save', sid: 3, parameters: ['"ok"', '', true] },
      { customAction: 'Jump', objectClass: 'Player', sid: 4, parameters: ['"x\\"y"'] },
    ])]);
    expect(issues.map(i => i.rule).sort()).toEqual(['empty-expression', 'expression-syntax']);
    expect(issues.find(i => i.rule === 'empty-expression')!.location).toContain('call function "Save"');
  });

  it('ignores non-string values, script actions, comments and variable initial values', () => {
    const issues = check([
      { eventType: 'variable', name: 'v', type: 'string', initialValue: '', sid: 9 },
      { eventType: 'comment', text: 'a \\ b "' },
      block(1, [cond('every-tick', 2)], [
        { type: 'script', script: 'const s = "\\"";' },
        { type: 'script', language: 'javascript', script: ['const t = "\\\\";', ''] },
        act('play', 3, { 'audio-file': { path: 'jungle' }, loop: 0, volume: '0', tag: '""' }),
      ]),
    ]);
    expect(issues).toEqual([]);
  });
});

// ─── Rule 3: trigger placement ──────────────────────────────

describe('checkEventLoadRules — trigger placement', () => {
  it('accepts a single trigger as the first condition', () => {
    expect(check([block(1, [cond('on-start-of-layout', 2), cond('compare-eventvar', 3)])])).toEqual([]);
  });

  it('warns about a trigger that is not the first condition of an AND block (the editor moves it up)', () => {
    const issues = check([block(1, [cond('compare-eventvar', 2), cond('on-start-of-layout', 3)])]);
    expect(issues).toHaveLength(1);
    expect(issues[0].rule).toBe('trigger-placement');
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].message).toContain('must be the first condition');
    expect(issues[0].message).toContain('moves it to the top');
  });

  it('treats fake triggers (On collision, On timer) like triggers', () => {
    // Not first: a warning, as for any trigger
    const notFirst = check([block(1, [
      cond('is-overlapping-another-object', 2, 'Player'),
      cond('on-collision-with-another-object', 3, 'Player'),
    ])]);
    expect(notFirst).toHaveLength(1);
    expect(notFirst[0].severity).toBe('warning');

    // Nested under another trigger: the editor counts isFakeTrigger as a trigger
    const nested = check([block(1, [cond('on-collision-with-another-object', 2, 'Player')], [], {
      children: [block(3, [cond('on-timer', 4, 'Player', { behaviorType: 'Timer' })])],
    })]);
    expect(nested).toHaveLength(1);
    expect(nested[0].severity).toBe('error');
    expect(nested[0].message).toContain('cannot add another trigger to event branch');
  });

  it('rejects two triggers in an AND block', () => {
    const issues = check([block(1, [cond('on-key-pressed', 2, 'Keyboard'), cond('on-click', 3, 'Mouse')])]);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('error');
    expect(issues[0].message).toContain('cannot add another trigger to event branch');
  });

  it('does not treat a per-condition isOr flag as an OR block', () => {
    const issues = check([block(1, [cond('on-key-pressed', 2, 'Keyboard'), cond('on-click', 3, 'Mouse', { isOr: true })])]);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('error');
    // The suggestion names what the event tools can do: split, or make an OR block
    expect(issues[0].suggestion).toContain('separate events');
    expect(issues[0].suggestion).toContain('isOrBlock: true in add_event_block or update_event_block');
    expect(issues[0].suggestion).toContain('"isOr" flag does not make one');
  });

  it('allows several triggers in any position in an OR block', () => {
    const issues = check([block(1, [
      cond('evaluate-expression', 2),
      cond('on-key-released', 3, 'Keyboard'),
      cond('on-button-released', 4, 'Gamepad'),
    ], [], { isOrBlock: true })]);
    expect(issues).toEqual([]);
  });

  it('rejects a trigger in a sub-event of a triggered event', () => {
    const issues = check([block(1, [cond('on-start-of-layout', 2)], [], {
      children: [block(3, [cond('compare-eventvar', 4)], [], {
        children: [block(5, [cond('on-key-pressed', 6, 'Keyboard')])],
      })],
    })]);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('error');
    expect(issues[0].location).toContain('block (sid 5)');
    expect(issues[0].message).toContain('block (sid 1)');
  });

  it('rejects a trigger under an OR block that has triggers', () => {
    const issues = check([block(1, [cond('on-key-pressed', 2, 'Keyboard'), cond('on-click', 3, 'Mouse')], [], {
      isOrBlock: true,
      children: [block(4, [cond('on-created', 5, 'Sprite')])],
    })]);
    expect(issues).toHaveLength(1);
    expect(issues[0].location).toContain('block (sid 4)');
  });

  it('allows a trigger in a sub-event of a non-triggered event', () => {
    const issues = check([block(1, [cond('compare-eventvar', 2)], [], {
      children: [block(3, [cond('on-key-pressed', 4, 'Keyboard')])],
    })]);
    expect(issues).toEqual([]);
  });

  it('treats groups as transparent', () => {
    const ok = check([{ eventType: 'group', title: 'G', sid: 1, children: [
      block(2, [cond('on-start-of-layout', 3)]),
      { eventType: 'group', title: 'Inner', sid: 4, children: [block(5, [cond('on-key-pressed', 6, 'Keyboard')])] },
    ] }]);
    expect(ok).toEqual([]);

    const bad = check([block(1, [cond('on-start-of-layout', 2)], [], {
      children: [{ eventType: 'group', title: 'G', sid: 3, children: [block(4, [cond('on-key-pressed', 5, 'Keyboard')])] }],
    })]);
    expect(bad).toHaveLength(1);
  });

  it('rejects a trigger inside a function block', () => {
    const fn = {
      eventType: 'function-block', functionName: 'DoIt', sid: 1, conditions: [], actions: [],
      children: [block(2, [cond('on-key-pressed', 3, 'Keyboard')])],
    };
    const issues = check([fn]);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('error');
    expect(issues[0].message).toContain('function "DoIt"');

    const own = check([{ ...fn, conditions: [cond('on-start-of-layout', 4)], children: [] }]);
    expect(own).toHaveLength(1);
    expect(own[0].severity).toBe('error');
  });

  it('rejects a trigger inside a custom action block', () => {
    const issues = check([{
      eventType: 'custom-ace-block', aceType: 'action', aceName: 'Jump', objectClass: 'Player', sid: 1,
      conditions: [], actions: [],
      children: [block(2, [cond('on-key-pressed', 3, 'Keyboard')])],
    }]);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('error');
    expect(issues[0].message).toContain('custom action Player.Jump');
  });

  it('downgrades violations involving third-party or unknown triggers to warnings', () => {
    const origin: AceOriginResolver = (ace) => (ace.objectClass === 'NGIO' ? 'addon' : 'builtin');
    const issues = check([block(1, [cond('compare-eventvar', 2), cond('on-login-success', 3, 'NGIO')])], origin);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');

    const unknown = check([block(1, [cond('on-key-pressed', 2, 'Keyboard'), cond('on-click', 3, 'Mouse')])], systemOnlyAceOrigin);
    expect(unknown[0].severity).toBe('warning');
  });

  it('does not treat non-"on-" conditions as triggers', () => {
    expect(check([block(1, [cond('every-tick', 2), cond('trigger-once-while-true', 3)])])).toEqual([]);
  });

  it('skips malformed (null) conditions and actions instead of crashing', () => {
    const issues = check([block(1, [null, cond('compare-eventvar', 2), cond('on-start-of-layout', 3)], [null])]);
    expect(issues).toHaveLength(1);
    expect(issues[0].location).toContain('condition 2');
  });
});

// ─── Rule 4: else placement ─────────────────────────────────

describe('elsePlacementProblem', () => {
  const elseConds = (...rest: unknown[]) => [cond('else', 90), ...rest];

  it('accepts an else right after a block without a trigger, also an else-if chain', () => {
    expect(elsePlacementProblem(block(1, [cond('every-tick', 2)]), elseConds())).toBeNull();
    expect(elsePlacementProblem(block(1, elseConds(cond('compare-two-values', 3))), elseConds())).toBeNull();
    expect(elsePlacementProblem(block(1, []), elseConds(cond('trigger-once-while-true', 3)))).toBeNull();
  });

  it('names what is wrong', () => {
    expect(elsePlacementProblem(undefined, elseConds())).toEqual({ kind: 'no-block-before' });
    expect(elsePlacementProblem({ eventType: 'comment', text: '' }, elseConds())).toEqual({ kind: 'no-block-before', previousType: 'comment' });
    expect(elsePlacementProblem(block(1, [cond('on-start-of-layout', 2)]), elseConds())).toMatchObject({ kind: 'after-trigger', trigger: { id: 'on-start-of-layout' } });
    expect(elsePlacementProblem(block(1, [cond('every-tick', 2), cond('on-layout-end', 3)], [], { isOrBlock: true }), elseConds()))
      .toMatchObject({ kind: 'after-trigger', trigger: { id: 'on-layout-end' } });
    expect(elsePlacementProblem(block(1, []), elseConds(cond('on-start-of-layout', 3)))).toMatchObject({ kind: 'holds-trigger' });
  });

  it('finds the event an else block belongs to past comments', () => {
    const comment = { eventType: 'comment', text: '' };
    const head = block(1, []);
    expect(previousNonComment([head, comment, comment, block(2, [])], 3)).toBe(head);
    expect(previousNonComment([comment, block(2, [])], 1)).toBeUndefined();
    expect(previousNonComment([block(2, [])], 0)).toBeUndefined();
    expect(previousNonComment([null, comment, block(2, [])], 2)).toBeNull();
  });

  it('describes each problem', () => {
    expect(describeElsePlacementProblem({ kind: 'no-block-before' })).toContain('no event comes before it');
    expect(describeElsePlacementProblem({ kind: 'after-trigger', trigger: { id: 'on-x' } })).toContain('Else can only follow normal (non-triggered) events');
    expect(describeElsePlacementProblem({ kind: 'holds-trigger', trigger: { id: 'on-x' } })).toContain('take Else off the first place');
  });
});

describe('checkEventLoadRules — else placement', () => {
  const elseBlock = (sid: number, ...rest: unknown[]) => block(sid, [cond('else', sid + 1), ...rest]);

  it('warns about an else after a triggered block, at any depth, keyed by the else block', () => {
    const issues = check([
      block(1, [cond('every-tick', 2)], [], { children: [
        block(3, [cond('on-start-of-layout', 4)]),
        elseBlock(5),
      ] }),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ rule: 'else-placement', severity: 'warning', key: 'else-placement|eventSheets/Main|5' });
    expect(issues[0].location).toBe('eventSheets/Main > block (sid 1) > block (sid 5)');
    expect(issues[0].message).toContain('triggered by "on-start-of-layout"');
  });

  it('warns about an else that is first in its list or follows a non-block event, not counting comments', () => {
    const issues = check([
      elseBlock(1),
      { eventType: 'group', title: 'G', sid: 3, children: [{ eventType: 'comment', text: 'c' }, elseBlock(4)] },
      { eventType: 'variable', name: 'v', sid: 6 },
      { eventType: 'comment', text: 'c' },
      elseBlock(7),
    ]);
    expect(issues.map(i => [i.rule, i.key])).toEqual([
      ['else-placement', 'else-placement|eventSheets/Main|1'],
      ['else-placement', 'else-placement|eventSheets/Main|4'],
      ['else-placement', 'else-placement|eventSheets/Main|7'],
    ]);
    expect(issues[1].message).toContain('no event comes before it (comments aside)');
    expect(issues[1].message).not.toContain('is a comment');
    expect(issues[2].message).toContain('the event before it is a variable');
    expect(issues[2].suggestion).toContain('only comments may stand between them');
  });

  it('accepts comments between a block and its else block, as editor saves have them', () => {
    expect(check([
      block(1, [cond('every-tick', 2)]),
      { eventType: 'comment', text: 'c' },
      elseBlock(4),
      block(6, [cond('compare-two-values', 7)]),
      { eventType: 'comment', text: 'one' },
      { eventType: 'comment', text: 'two' },
      elseBlock(8, cond('compare-two-values', 10)),
      { eventType: 'comment', text: 'three' },
      elseBlock(11),
    ])).toEqual([]);
  });

  it('still looks through comments for a trigger on the block before the else', () => {
    const issues = check([block(1, [cond('on-start-of-layout', 2)]), { eventType: 'comment', text: 'c' }, elseBlock(4)]);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('triggered by "on-start-of-layout"');
  });

  it('reports a trigger after "else" once, as else-placement, not as "put the trigger first"', () => {
    const issues = check([block(1, [cond('every-tick', 2)]), elseBlock(3, cond('on-start-of-layout', 5))]);
    expect(issues).toHaveLength(1);
    expect(issues[0].rule).toBe('else-placement');
    expect(issues[0].message).toContain('holds the trigger "on-start-of-layout"');
    expect(issues[0].suggestion).toContain('own event');
    expect(issues[0].suggestion).not.toMatch(/Put the trigger first/);
  });

  it('marks third-party addon triggers as possible triggers', () => {
    const addon: AceOriginResolver = ace => (ace.objectClass === 'System' ? 'builtin' : 'addon');
    const issues = check([block(1, [cond('on-thing', 2, 'AddonObj')]), elseBlock(3)], addon);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('(if this addon condition is a trigger)');
  });

  it('accepts the shapes editor saves use: an if / else-if / else chain after non-triggered blocks', () => {
    expect(check([
      block(1, [cond('compare-two-values', 2)]),
      elseBlock(3, cond('compare-two-values', 5)),
      elseBlock(6),
      block(8, [cond('on-start-of-layout', 9)], [], { children: [block(10, [cond('every-tick', 11)]), elseBlock(12)] }),
    ])).toEqual([]);
  });
});

// Shapes copied from real editor-saved sheets (lasermagnet/free-version-survivors @ f2f7493,
// a public repo; adventureland eGameRoom.json), which the editor opens without complaint.
describe('checkEventLoadRules — real editor-saved shapes', () => {
  const realSheet = [
    // OR block mixing triggers of four plugins, one of them disabled (sid 682356468105815)
    block(682356468105815, [
      cond('on-tap-object', 304990990446090, 'Touch', { parameters: { object: 'UI_Button9P_Start' } }),
      cond('on-object-clicked', 735338109962809, 'Mouse', { parameters: { 'mouse-button': 'left', 'click-type': 'clicked', 'object-clicked': 'UI_Button9P_Start' } }),
      cond('on-button-pressed', 617458317322238, 'Gamepad', { parameters: { gamepad: '0', button: 'button-a' } }),
      cond('on-start-of-layout', 909455077034720, 'System', { disabled: true }),
    ], [
      { id: 'log', objectClass: 'Browser', sid: 265592090473247, parameters: { type: 'log', message: '"Free Version Survivors build " & projectversion' } },
      { type: 'script', language: 'javascript', script: ['runtime.globalVars.rulesJSON = getRulesFromEditor() ?? JSON.stringify(rules)'] },
      { id: 'go-to-layout', objectClass: 'System', sid: 281598064169003, parameters: { layout: 'Level' } },
    ], { isOrBlock: true }),
    // Custom action block with action-level comments and custom action calls with bare identifiers
    {
      eventType: 'custom-ace-block', aceType: 'action', aceName: 'tick', objectClass: 'Player', sid: 50,
      conditions: [
        { id: 'compare-eventvar', objectClass: 'System', sid: 860097898078923, parameters: { variable: 'isLeveling', comparison: 0, value: 'NO' } },
      ],
      actions: [
        { type: 'comment', text: 'Handle input first' },
        { type: 'comment', text: '' },
        { customAction: 'tick_input', objectClass: 'Player', sid: 406681418686896 },
        { customAction: 'spawn', objectClass: 'Enemy', sid: 865599306482982, parameters: ['Enemy.spawnEnemy', '1', 'YES', 'Enemy.X', 'Enemy.Y'] },
        { id: 'set-instvar-value', objectClass: 'UI_Bar_Health', sid: 813525834457805, parameters: { 'instance-variable': 'initWidth', value: 'Self.initWidth = 0 ? Self.Width : Self.initWidth' } },
      ],
    },
    // Group holding an event-level script sub-event
    { eventType: 'group', title: 'YSort', sid: 60, children: [
      { eventType: 'script', language: 'javascript', script: ['const ySort = globalThis.AdventureLand?.YSort;', 'if (ySort) {', '  ySort.sortWithAltitude();', '}'] },
    ] },
  ];

  it('reports nothing for them', () => {
    expect(check(realSheet)).toEqual([]);
  });
});

describe('newLoadRuleIssues', () => {
  it('reports only issues that are not already present', () => {
    const events = [block(1, [cond('compare-eventvar', 2), cond('on-start-of-layout', 3)])];
    const before = check(events);
    const afterEvents = [...events, block(10, [cond('every-tick', 11)], [act('set-text', 12, { text: '' })])];
    const introduced = newLoadRuleIssues(before, check(afterEvents));
    expect(introduced).toHaveLength(1);
    expect(introduced[0].rule).toBe('empty-expression');
  });

  const issue = (key: string, severity: 'error' | 'warning'): LoadRuleIssue =>
    ({ rule: 'trigger-placement', severity, location: key, message: key, key });

  it('treats a warning that became an error as new', () => {
    expect(newLoadRuleIssues([issue('k', 'warning')], [issue('k', 'error')])).toHaveLength(1);
    expect(newLoadRuleIssues([issue('k', 'error')], [issue('k', 'warning')])).toEqual([]);
    expect(newLoadRuleIssues([issue('k', 'error')], [issue('k', 'error')])).toEqual([]);
  });

  it('matches keys as a multiset', () => {
    const introduced = newLoadRuleIssues([issue('k', 'error')], [issue('k', 'warning'), issue('k', 'error')]);
    expect(introduced).toHaveLength(1);
    expect(introduced[0].severity).toBe('warning');
  });

  it('lets a partial fix of several triggers in one event through', () => {
    const three = check([block(60, [cond('on-start-of-layout', 61), cond('on-key-pressed', 62, 'Keyboard'), cond('on-key-released', 63, 'Keyboard')])]);
    const two = check([block(60, [cond('on-start-of-layout', 61), cond('on-key-pressed', 62, 'Keyboard')])]);
    const notFirst = check([block(60, [cond('compare-eventvar', 64), cond('on-key-pressed', 62, 'Keyboard'), cond('on-key-released', 63, 'Keyboard')])]);
    const notFirstOnly = check([block(60, [cond('compare-eventvar', 64), cond('on-key-pressed', 62, 'Keyboard')])]);
    expect(newLoadRuleIssues(three, two)).toEqual([]);
    expect(newLoadRuleIssues(notFirst, notFirstOnly)).toEqual([]);
    // A second trigger added to an event whose trigger was only misplaced is new (warning → error)
    const introduced = newLoadRuleIssues(notFirstOnly, notFirst);
    expect(introduced).toHaveLength(1);
    expect(introduced[0].severity).toBe('error');
  });

  it('keeps issues on SID-less events and ACEs stable when indices shift', () => {
    const sidless = { eventType: 'block', conditions: [cond('every-tick', 2)], actions: [{ id: 'set-text', objectClass: 'Text', parameters: { text: '' } }] };
    const before = check([sidless]);
    expect(before).toHaveLength(1);
    const after = check([{ eventType: 'comment', text: 'new' }, block(9, [cond('every-tick', 10)]), sidless]);
    expect(newLoadRuleIssues(before, after)).toEqual([]);
    // A second identical SID-less problem is still new
    expect(newLoadRuleIssues(before, check([sidless, sidless]))).toHaveLength(1);
  });
});

describe('collectTriggerObjectClasses', () => {
  it('collects object classes of trigger-like conditions, excluding System', () => {
    const names = collectTriggerObjectClasses([
      block(1, [cond('on-start-of-layout', 2)], [], {
        children: [block(3, [cond('on-created', 4, 'Enemy'), cond('is-visible', 5, 'Player')])],
      }),
    ] as unknown as C3Event[]);
    expect([...names]).toEqual(['Enemy']);
  });
});

// ─── ACE origin ─────────────────────────────────────────────

describe('createAceOriginResolver', () => {
  const resolver = createAceOriginResolver({
    objects: new Map<string, Record<string, unknown>>([
      ['Player', { name: 'Player', 'plugin-id': 'Sprite', behaviorTypes: [{ behaviorId: 'Platform', name: 'Platform', sid: 1 }] }],
      ['Drone', { name: 'Drone', 'plugin-id': 'Sprite', behaviorTypes: [] }],
      ['NGIO', { name: 'NGIO', 'plugin-id': 'ppstudio_newgroundsio_plugin' }],
    ]),
    families: new Map<string, Record<string, unknown>>([
      ['Enemies', { name: 'Enemies', 'plugin-id': 'Sprite', members: ['Drone'], behaviorTypes: [{ behaviorId: 'Timer', name: 'Timer', sid: 2 }] }],
    ]),
    usedAddons: [
      { type: 'plugin', id: 'Sprite', author: 'Scirra' },
      { type: 'behavior', id: 'Platform', author: 'Scirra' },
      { type: 'behavior', id: 'Timer', author: 'Scirra' },
      { type: 'plugin', id: 'ppstudio_newgroundsio_plugin', author: 'Pixel Perfect Studio' },
    ],
  });

  it('treats System as built in', () => {
    expect(resolver({ id: 'on-start-of-layout', objectClass: 'System' })).toBe('builtin');
  });

  it('resolves plugins and behaviors through usedAddons authors', () => {
    expect(resolver({ id: 'on-created', objectClass: 'Player' })).toBe('builtin');
    expect(resolver({ id: 'on-landed', objectClass: 'Player', behaviorType: 'Platform' })).toBe('builtin');
    expect(resolver({ id: 'on-landed', objectClass: 'Player', 'behavior-type': 'Platform' })).toBe('builtin');
    expect(resolver({ id: 'on-login-success', objectClass: 'NGIO' })).toBe('addon');
  });

  it('finds behaviors inherited from a family', () => {
    expect(resolver({ id: 'on-timer', objectClass: 'Drone', behaviorType: 'Timer' })).toBe('builtin');
    expect(resolver({ id: 'on-timer', objectClass: 'Enemies', behaviorType: 'Timer' })).toBe('builtin');
  });

  it('returns unknown when the class or behavior cannot be resolved', () => {
    expect(resolver({ id: 'on-created', objectClass: 'Missing' })).toBe('unknown');
    expect(resolver({ id: 'on-x', objectClass: 'Player', behaviorType: 'Nope' })).toBe('unknown');
  });

  it('treats the built-in Functions object as built in, under the project\'s functionsName', () => {
    expect(resolver({ id: 'set-function-return-value', objectClass: 'Functions' })).toBe('builtin');

    const renamed = createAceOriginResolver({ objects: new Map(), families: new Map(), usedAddons: [], functionsName: 'Fn' });
    expect(renamed({ id: 'set-function-return-value', objectClass: 'Fn' })).toBe('builtin');
    expect(renamed({ id: 'set-function-return-value', objectClass: 'Functions' })).toBe('unknown');
  });
});

describe('checkEventLoadRules — built-in Functions object', () => {
  it('lints the parameters of its actions like any other action', () => {
    const fn = (actions: unknown[]) => ({
      eventType: 'function-block', functionName: 'Label', functionReturnType: 'string', functionParameters: [],
      sid: 1, conditions: [], actions,
    });
    expect(check([fn([{ id: 'set-function-return-value', objectClass: 'Functions', sid: 2, parameters: { value: '"a" & "b"' } }])])).toEqual([]);

    const issues = check([fn([
      { id: 'set-function-return-value', objectClass: 'Functions', sid: 2, parameters: { value: '' } },
      { id: 'map-function', objectClass: 'Functions', sid: 3, parameters: { name: '"ops', string: '"x"', function: 'Label' } },
    ])]);
    expect(issues.map(i => i.rule).sort()).toEqual(['empty-expression', 'expression-syntax']);
    expect(issues.find(i => i.rule === 'empty-expression')!.location).toContain('action 0 "set-function-return-value" (Functions)');
  });
});

// ─── Rule 4: object class names ─────────────────────────────

describe('checkObjectClassNames', () => {
  const tree = (items: string[], subfolders: unknown[] = []) => ({ items, subfolders } as never);

  it('accepts unique names', () => {
    expect(checkObjectClassNames({
      objectTypes: tree(['Player'], [{ name: 'UI', items: ['Button'], subfolders: [] }]),
      families: tree(['Enemies']),
    })).toEqual([]);
  });

  it('rejects an object type name registered twice, including across subfolders', () => {
    const issues = checkObjectClassNames({
      objectTypes: tree(['Player'], [{ name: 'Chars', items: [], subfolders: [{ name: 'Deep', items: ['Player'], subfolders: [] }] }]),
      families: tree([]),
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('error');
    expect(issues[0].message).toContain('registered 2 times');
    expect(issues[0].message).toContain("object class name 'Player' already used");
  });

  it('rejects a family and an object type sharing a name, and names that differ only in case', () => {
    const clash = checkObjectClassNames({ objectTypes: tree(['Enemy']), families: tree(['Enemy']) });
    expect(clash).toHaveLength(1);
    expect(clash[0].severity).toBe('error');
    expect(clash[0].message).toContain("object class name 'Enemy' already used");

    const caseOnly = checkObjectClassNames({ objectTypes: tree(['Player', 'player']), families: tree([]) });
    expect(caseOnly).toHaveLength(1);
    expect(caseOnly[0].severity).toBe('error');

    const families = checkObjectClassNames({ objectTypes: tree([]), families: tree(['Foes', 'FOES']) });
    expect(families).toHaveLength(1);
    expect(families[0].severity).toBe('error');
  });
});

describe('findObjectClassNameClash', () => {
  it('finds object types and families ignoring case', () => {
    expect(findObjectClassNameClash('enemy', ['Enemy'], [])).toEqual({ name: 'Enemy', kind: 'object type' });
    expect(findObjectClassNameClash('Foes', ['Player'], ['foes'])).toEqual({ name: 'foes', kind: 'family' });
    expect(findObjectClassNameClash('Hero', ['Player'], ['Foes'])).toBeUndefined();
  });
});

describe('built-in object class names (System, the Functions object)', () => {
  const tree = (items: string[]) => ({ items, subfolders: [] } as never);

  it('reports an object type or family named like System or the Functions object, ignoring case', () => {
    const issues = checkObjectClassNames({ objectTypes: tree(['functions', 'Hero']), families: tree(['SYSTEM']) });
    expect(issues).toHaveLength(2);
    expect(issues.every(i => i.rule === 'duplicate-object-name' && i.severity === 'error')).toBe(true);
    expect(issues[0].message).toContain('object type "functions" has the name of the built-in Functions object ("Functions", functionsName in project.c3proj)');
    expect(issues[0].message).toContain("object class name 'functions' already used");
    expect(issues[1].message).toContain('family "SYSTEM" has the name of the built-in System object');
  });

  it('uses the project\'s functionsName', () => {
    expect(checkObjectClassNames({ objectTypes: tree(['Functions']), families: tree([]), functionsName: 'Fn' })).toEqual([]);
    const issues = checkObjectClassNames({ objectTypes: tree(['FN']), families: tree([]), functionsName: 'Fn' });
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('("Fn", functionsName in project.c3proj)');
  });

  it('names the clashing built-in for create_object and create_family', () => {
    expect(findBuiltinObjectClassClash('system', undefined)).toBe('System');
    expect(findBuiltinObjectClassClash('FUNCTIONS', undefined)).toBe('Functions');
    expect(findBuiltinObjectClassClash('Functions', 'Fn')).toBeUndefined();
    expect(findBuiltinObjectClassClash('fn', 'Fn')).toBe('Fn');
    expect(findBuiltinObjectClassClash('Hero', 'Fn')).toBeUndefined();
    expect(builtinObjectClassNames('')).toEqual(['System', 'Functions']);
  });
});

// ─── Rule 5: family plugin homogeneity ──────────────────────

describe('checkFamilyPlugins', () => {
  const objects = new Map<string, Record<string, unknown>>([
    ['A', { name: 'A', 'plugin-id': 'Sprite' }],
    ['B', { name: 'B', 'plugin-id': 'Sprite' }],
    ['T', { name: 'T', 'plugin-id': 'Text' }],
  ]);

  it('accepts a family whose members all use its plugin', () => {
    expect(checkFamilyPlugins(new Map([['F', { name: 'F', 'plugin-id': 'Sprite', members: ['A', 'B'] }]]), objects)).toEqual([]);
  });

  it('rejects a member with a different plugin', () => {
    const issues = checkFamilyPlugins(new Map([['F', { name: 'F', 'plugin-id': 'Sprite', members: ['A', 'T'] }]]), objects);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('error');
    expect(issues[0].location).toContain('member "T"');
    expect(issues[0].message).toContain('"wrong plugin"');
  });

  it('blames the member that differs from the family plugin, even when it is listed first', () => {
    const issues = checkFamilyPlugins(new Map([['F', { name: 'F', 'plugin-id': 'Sprite', members: ['T', 'A', 'B'] }]]), objects);
    expect(issues.map(i => i.location)).toEqual(['families/F > member "T"']);
  });

  it('only warns when all members agree with each other but not with the family plugin-id', () => {
    const issues = checkFamilyPlugins(new Map([['F', { name: 'F', 'plugin-id': 'Text', members: ['A', 'B'] }]]), objects);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
  });

  it('compares members with each other when the family has no plugin-id', () => {
    const issues = checkFamilyPlugins(new Map([['F', { name: 'F', members: ['A', 'T'] }]]), objects);
    expect(issues).toHaveLength(1);
  });

  it('skips members that do not exist', () => {
    expect(checkFamilyPlugins(new Map([['F', { name: 'F', 'plugin-id': 'Sprite', members: ['A', 'Ghost'] }]]), objects)).toEqual([]);
  });
});

// ─── Rule 6: duplicate SIDs ─────────────────────────────────

describe('isLoadBreakingSidDuplicate', () => {
  it('is true when two object types or families share a SID', () => {
    expect(isLoadBreakingSidDuplicate(['object', 'object'])).toBe(true);
    expect(isLoadBreakingSidDuplicate(['object', 'family', 'behavior'])).toBe(true);
  });

  it('is false for behavior and instance variable SID clashes (the loader has no check for them)', () => {
    expect(isLoadBreakingSidDuplicate(['instance-variable', 'instance-variable'])).toBe(false);
    expect(isLoadBreakingSidDuplicate(['object', 'family-behavior'])).toBe(false);
    expect(isLoadBreakingSidDuplicate(['behavior', 'family-instance-variable', 'other'])).toBe(false);
  });

  it('is false for animation and frame SIDs (a Scirra example repeats one and opens fine)', () => {
    expect(isLoadBreakingSidDuplicate(['animation', 'animation'])).toBe(false);
    expect(isLoadBreakingSidDuplicate(['animation', 'frame'])).toBe(false);
  });

  it('is false for other duplicate kinds', () => {
    expect(isLoadBreakingSidDuplicate(['object', 'other'])).toBe(false);
    expect(isLoadBreakingSidDuplicate(['other', 'other'])).toBe(false);
    expect(isLoadBreakingSidDuplicate(['singleglobal-inst', 'object'])).toBe(false);
  });
});

describe('classifySidDuplicate', () => {
  it('separates object class SID collisions from other object file collisions', () => {
    expect(classifySidDuplicate(['object', 'family'])).toBe('object-class');
    expect(classifySidDuplicate(['object', 'object', 'behavior'])).toBe('object-class');
    expect(classifySidDuplicate(['object', 'instance-variable'])).toBe('object-file');
    expect(classifySidDuplicate(['behavior', 'behavior'])).toBe('object-file');
    expect(classifySidDuplicate(['frame', 'frame'])).toBeNull();
    expect(classifySidDuplicate(['object', 'other'])).toBeNull();
  });

  it('groups event, condition, action and layout instance clashes', () => {
    expect(classifySidDuplicate(['action', 'action'])).toBe('event-or-instance');
    expect(classifySidDuplicate(['event', 'condition', 'action'])).toBe('event-or-instance');
    expect(classifySidDuplicate(['layout-instance', 'layout-instance'])).toBe('event-or-instance');
    // Mixed with anything else, the clash gets the generic wording.
    expect(classifySidDuplicate(['action', 'object'])).toBeNull();
    expect(classifySidDuplicate(['layout', 'layer'])).toBeNull();
  });

  it('flags any clash involving a function or custom action parameter (the loader checks those)', () => {
    expect(classifySidDuplicate(['function-parameter', 'function-parameter'])).toBe('parameter');
    expect(classifySidDuplicate(['parameter', 'action'])).toBe('parameter');
    expect(classifySidDuplicate(['behavior', 'behavior', 'function-parameter'])).toBe('parameter');
    expect(classifySidDuplicate(['object', 'family', 'function-parameter'])).toBe('object-class');
  });
});
