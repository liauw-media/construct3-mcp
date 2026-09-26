/**
 * Unit tests for the event outline analyzer (editor event numbers <-> JSON paths).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildEventOutline,
  locateEvent,
  renderOutline,
  NUMBERING_RULE,
  OUTLINE_PAGE_CHAR_BUDGET,
  type OutlinePage,
  type OutlineRenderOptions,
  type SheetOutline,
} from '../../src/construct3/analyzers/event-outline.js';
import {
  nestedSheet,
  actionHeavyEvents,
  eventsFromSkeleton,
  skeletonNumbers,
  FPS1_MAIN_SKELETON,
  FPS2_APLAYER_SKELETON,
} from '../mocks/event-sheets.js';

const block = (sid: number, extra: Record<string, unknown> = {}) =>
  ({ eventType: 'block', sid, conditions: [], actions: [], ...extra });

describe('buildEventOutline', () => {
  it('numbers events in display order and skips variables, includes and comments', () => {
    const outline = buildEventOutline('es_game', nestedSheet().events);
    expect(outline.totalEvents).toBe(13);
    expect(outline.truncated).toBe(false);
    // The only warning: the sample's legacy "behavior-type" condition (issue #16)
    expect(outline.warnings).toHaveLength(1);
    expect(outline.warnings[0]).toContain('legacy "behavior-type" key (events[3].children[0].children[0].conditions[0])');
    expect(outline.nodes.map(n => [n.number, n.path])).toEqual([
      [null, 'events[0]'],
      [null, 'events[1]'],
      [null, 'events[2]'],
      [1, 'events[3]'],
      [2, 'events[3].children[0]'],
      [3, 'events[3].children[0].children[0]'],
      [4, 'events[3].children[0].children[1]'],
      [null, 'events[3].children[1]'],
      [null, 'events[3].children[2]'],
      [5, 'events[3].children[3]'],
      [6, 'events[3].children[4]'],
      [7, 'events[3].children[4].children[0]'],
      [8, 'events[4]'],
      [9, 'events[4].children[0]'],
      [10, 'events[5]'],
      [11, 'events[5].children[0]'],
      [12, 'events[6]'],
      [13, 'events[7]'],
    ]);
  });

  it.each([
    ['FirstPersonShooter1 Main (groups, sub-events, else, functions in groups)', FPS1_MAIN_SKELETON, 25],
    ['FirstPersonShooter2 aPlayer (custom ACE bodies with variables and else chains)', FPS2_APLAYER_SKELETON, 21],
  ])('matches the display numbers the editor exported for %s', (_label, skeleton, total) => {
    const outline = buildEventOutline('real', eventsFromSkeleton(skeleton));
    expect(outline.totalEvents).toBe(total);
    expect(outline.warnings).toEqual([]);
    expect(outline.nodes.map(n => n.number)).toEqual(skeletonNumbers(skeleton));
  });

  it('classifies node kinds, depth, sid and nesting context', () => {
    const outline = buildEventOutline('es_game', nestedSheet().events);
    const byNumber = new Map(outline.nodes.filter(n => n.number !== null).map(n => [n.number, n]));
    expect(byNumber.get(1)!.kind).toBe('group');
    expect(byNumber.get(4)!.kind).toBe('else');
    expect(byNumber.get(8)!.kind).toBe('function');
    expect(byNumber.get(10)!.kind).toBe('custom-ace');
    expect(byNumber.get(12)!.kind).toBe('script');
    expect(byNumber.get(12)!.sid).toBeUndefined();
    expect(byNumber.get(7)!).toMatchObject({ depth: 2, sid: 16, enclosingGroups: ['Movement', 'Nested'] });
    expect(byNumber.get(9)!.enclosingFunction).toBe('DoThing');
    expect(byNumber.get(11)!.enclosingFunction).toBe('Player.jump');
    expect(byNumber.get(1)!.enclosingGroups).toEqual([]);
    expect(byNumber.get(5)!.disabled).toBe(true);
    expect(byNumber.get(10)!.conditions.map(c => [c.path, c.disabled])).toEqual([
      ['events[5].conditions[0]', false],
      ['events[5].conditions[1]', true],
    ]);
  });

  it('renders headers for every node kind, including the own conditions of functions and custom ACEs', () => {
    const outline = buildEventOutline('es_game', nestedSheet().events);
    expect(outline.nodes.map(n => n.header)).toEqual([
      'VAR Score: number = 0',
      'INCLUDE Common',
      'COMMENT: Main logic',
      'GROUP [Movement]',
      'IF System.on-start-of-layout()',
      'IF NOT Player[Platform].is-on-floor() [legacy behavior-type]',
      'ELSE',
      'COMMENT: sub comment',
      'VAR speed: number = 5 [static]',
      'IF Keyboard.key-is-down(key=37) OR Keyboard.key-is-down(key=39) [disabled]',
      'GROUP [Nested] (inactive on start)',
      'IF Keyboard.key-is-down(key=32)',
      'FUNCTION DoThing(a: number) -> number [async] IF System.for-each(object=Enemy)',
      'IF (no conditions)',
      'CUSTOM ACTION Player.jump() IF Player[Platform].is-on-floor() AND ' +
        'Player.compare-instance-variable(instance-variable=lives, comparison=4, value=0) [disabled]',
      'IF (no conditions)',
      'SCRIPT BLOCK: const x = 1; (+1 lines)',
      'IF System.every-tick()',
    ]);
  });

  it('joins a function block\'s own conditions with OR when isOrBlock is set', () => {
    const outline = buildEventOutline('s', [{
      eventType: 'function-block', functionName: 'F', functionParameters: [], sid: 1, isOrBlock: true,
      conditions: [
        { id: 'key-is-down', objectClass: 'Keyboard', sid: 2, parameters: { key: 37 } },
        { id: 'key-is-down', objectClass: 'Keyboard', sid: 3, parameters: { key: 39 } },
      ],
      actions: [],
    }]);
    expect(outline.nodes[0].header).toBe('FUNCTION F() IF Keyboard.key-is-down(key=37) OR Keyboard.key-is-down(key=39)');
  });

  it('renders actions: behaviors, function calls, custom actions, scripts (string or lines), comments', () => {
    const outline = buildEventOutline('es_game', nestedSheet().events);
    const byNumber = new Map(outline.nodes.filter(n => n.number !== null).map(n => [n.number, n]));
    expect(byNumber.get(2)!.actions.map(a => a.text)).toEqual([
      'DO Player[Platform].set-max-speed(max-speed=300)',
      'CALL Spawn("Enemy", 3)',
      'SCRIPT: runtime.globalVars.Score = 0; (+1 lines)',
    ]);
    expect(byNumber.get(5)!.actions[0].text).toBe('DO Player.set-x(x=Self.X + 1) [disabled]');
    expect(byNumber.get(8)!.actions.map(a => [a.kind, a.text, a.path])).toEqual([
      ['script', 'SCRIPT: // hi (+1 lines)', 'events[4].actions[0]'],
      ['comment', 'COMMENT: return twice a', 'events[4].actions[1]'],
      ['action', 'DO Functions.set-function-return-value(value=a * 2)', 'events[4].actions[2]'],
    ]);
    expect(byNumber.get(11)!.actions[0].text).toBe('CALL Player.land()');
    expect(byNumber.get(9)!.actions[0].text).toBe('CALL Other()');
  });

  it('names the class whose custom action runs when customActionObjectClass differs from objectClass', () => {
    // Shape of Scirra's "custom action overrides" example: the monkey override calls the Animals original.
    const outline = buildEventOutline('s', [
      {
        eventType: 'custom-ace-block', aceType: 'action', aceName: 'PlayAnimation', objectClass: 'monkey',
        functionParameters: [], sid: 1, conditions: [],
        actions: [
          { customAction: 'PlayAnimation', objectClass: 'monkey', customActionObjectClass: 'Animals', sid: 2, disabled: true },
        ],
      },
      block(3, {
        actions: [
          { customAction: 'PlayAnimation', objectClass: 'monkey', customActionObjectClass: 'Animals', sid: 4 },
          { customAction: 'spawn', objectClass: 'Player', customActionObjectClass: 'fPlayer', sid: 5, parameters: { x: '10' } },
          { customAction: 'PlayAnimation', objectClass: 'Animals', customActionObjectClass: 'Animals', sid: 6 },
          { customAction: 'PlayAnimation', objectClass: 'monkey', sid: 7 },
        ],
      }),
    ]);
    expect(outline.nodes[0].header).toBe('CUSTOM ACTION monkey.PlayAnimation()');
    expect(outline.nodes[0].actions[0].text).toBe('CALL monkey.PlayAnimation (Animals)() [disabled]');
    expect(outline.nodes[1].actions.map(a => a.text)).toEqual([
      'CALL monkey.PlayAnimation (Animals)()',
      'CALL Player.spawn (fPlayer)(x=10)',
      'CALL Animals.PlayAnimation()',
      'CALL monkey.PlayAnimation()',
    ]);
  });

  it('truncates long parameter values', () => {
    const outline = buildEventOutline('s', [{
      eventType: 'block', sid: 1, conditions: [],
      actions: [{ id: 'set-text', objectClass: 'Label', sid: 2, parameters: { text: `"${'x'.repeat(100)}"` } }],
    }]);
    const text = outline.nodes[0].actions[0].text;
    expect(text.length).toBeLessThan(80);
    expect(text).toContain('…');
  });

  it('counts unknown event types as numbered and warns', () => {
    const outline = buildEventOutline('s', [
      { eventType: 'hologram', sid: 1 },
      block(2),
    ]);
    expect(outline.nodes.map(n => n.number)).toEqual([1, 2]);
    expect(outline.nodes[0].kind).toBe('unknown');
    expect(outline.warnings[0]).toContain('unknown eventType "hologram"');
  });

  it('skips non-object entries and tolerates a missing events array', () => {
    const outline = buildEventOutline('s', [null, block(2)]);
    expect(outline.totalEvents).toBe(1);
    expect(outline.nodes[0].path).toBe('events[1]');
    expect(outline.warnings[0]).toContain('events[0] is not an event object');

    const empty = buildEventOutline('s', undefined);
    expect(empty.totalEvents).toBe(0);
    expect(empty.warnings[0]).toContain('no events array');
  });

  it('keeps the JSON index and path of conditions and actions after a non-object entry', () => {
    const outline = buildEventOutline('s', [block(1, {
      conditions: ['bad', { id: 'every-tick', objectClass: 'System', sid: 2 }],
      actions: [null, { id: 'destroy', objectClass: 'A', sid: 3 }],
    })]);
    const [node] = outline.nodes;
    expect(node.conditions.map(c => [c.index, c.path])).toEqual([[1, 'events[0].conditions[1]']]);
    expect(node.actions.map(a => [a.index, a.path])).toEqual([[1, 'events[0].actions[1]']]);
    expect(outline.warnings).toEqual([
      'events[0].conditions[0] is not an object; skipped, so later condition numbers in this event may be off.',
      'events[0].actions[0] is not an object; skipped, so later action numbers in this event may be off.',
    ]);
    const loc = locateEvent(outline, 1, { actionNumber: 1, conditionNumber: 1 });
    expect(loc.action).toMatchObject({ index: 1, path: 'events[0].actions[1]', text: 'DO A.destroy()' });
    expect(loc.condition).toMatchObject({ index: 1, path: 'events[0].conditions[1]' });
  });

  it('shows the non-standard isElse and isOr flags as stored, marked, with one warning each', () => {
    const outline = buildEventOutline('s', [
      block(1, { conditions: [{ id: 'every-tick', objectClass: 'System', sid: 3 }] }),
      block(2, { isElse: true }),
      block(4, {
        conditions: [
          { id: 'key-is-down', objectClass: 'Keyboard', sid: 5, parameters: { key: 37 } },
          { id: 'key-is-down', objectClass: 'Keyboard', sid: 6, isOr: true, parameters: { key: 39 } },
        ],
      }),
    ]);
    expect(outline.nodes.map(n => n.number)).toEqual([1, 2, 3]);
    expect(outline.nodes[1]).toMatchObject({ kind: 'block', header: 'IF (no conditions) [non-standard isElse]' });
    expect(outline.nodes[2].header).toBe(
      'IF Keyboard.key-is-down(key=37) AND Keyboard.key-is-down(key=39) [non-standard isOr]',
    );
    expect(outline.warnings).toHaveLength(2);
    expect(outline.warnings[0]).toContain('1 block(s) carry isElse: true (events[1])');
    expect(outline.warnings[0]).toContain('Construct 3 may ignore the flag');
    expect(outline.warnings[1]).toContain('1 condition(s) carry isOr: true (events[2].conditions[1])');
  });

  it('numbers a script block nested two levels deep at its depth-first position, and disabled events', () => {
    // Shape verified against editor exports: block > block > script block, then a later sibling.
    const events = [
      block(1, {
        children: [
          block(2),
          block(3, { children: [{ eventType: 'script', language: 'javascript', script: 'x()' }] }),
          block(5),
        ],
      }),
      block(6, { disabled: true, children: [block(7)] }),
    ];
    const outline = buildEventOutline('Sheet1', events);
    expect(outline.warnings).toEqual([]);
    expect(outline.nodes.map(n => n.number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(outline.nodes[3]).toMatchObject({ number: 4, kind: 'script', depth: 2, path: 'events[0].children[1].children[0]' });
    expect(outline.nodes[4]).toMatchObject({ number: 5, sid: 5, path: 'events[0].children[2]' });
    // Disabled events, also those disabled only through a parent, keep their numbers.
    expect(outline.nodes[5]).toMatchObject({ number: 6, sid: 6, disabled: true });
    expect(outline.nodes[6]).toMatchObject({ number: 7, sid: 7, disabled: false, depth: 1 });
  });

  it('marks ACEs whose behavior is only under the legacy "behavior-type" key (issue #16), with one warning', () => {
    const outline = buildEventOutline('s', [
      block(1, {
        conditions: [
          { id: 'is-moving', objectClass: 'Car', sid: 2, 'behavior-type': 'Car' },
          // Leftover legacy key next to behaviorType: C3 reads behaviorType, so not marked
          { id: 'is-on-floor', objectClass: 'Player', sid: 3, behaviorType: 'Platform', 'behavior-type': 'Platform' },
        ],
        actions: [
          { id: 'flash', objectClass: 'Car', sid: 4, 'behavior-type': 'Flash' },
          { id: 'simulate-control', objectClass: 'Player', sid: 5, behaviorType: 'Platform' },
          { type: 'script', script: ['runtime.x = 1;'] },
        ],
      }),
    ]);
    const [node] = outline.nodes;
    expect(node.conditions.map(c => c.text)).toEqual([
      'Car[Car].is-moving() [legacy behavior-type]',
      'Player[Platform].is-on-floor()',
    ]);
    expect(node.actions.map(a => a.text)).toEqual([
      'DO Car[Flash].flash() [legacy behavior-type]',
      'DO Player[Platform].simulate-control()',
      'SCRIPT: runtime.x = 1;',
    ]);
    expect(outline.warnings).toHaveLength(1);
    expect(outline.warnings[0]).toContain('2 condition(s)/action(s) name their behavior only under the legacy "behavior-type" key (events[0].conditions[0], events[0].actions[0])');
    expect(outline.warnings[0]).toContain('fix_legacy_behavior_keys');
  });

  it('stops the walk below the depth limit instead of giving later events wrong numbers', () => {
    // A chain of 61 nested blocks, then a top-level sibling (display number 62).
    let chain: Record<string, unknown> = block(61);
    for (let sid = 60; sid >= 1; sid--) chain = block(sid, { children: [chain] });
    const outline = buildEventOutline('deep', [chain, block(62)]);
    expect(outline.truncated).toBe(true);
    expect(outline.totalEvents).toBe(51);
    expect(outline.nodes.map(n => n.sid)).toEqual(Array.from({ length: 51 }, (_, i) => i + 1));
    expect(outline.warnings[0]).toContain('nested deeper than 50 levels; the outline stops after event 51');
    expect(locateEvent(outline, 51).event.sid).toBe(51);
    expect(() => locateEvent(outline, 52)).toThrow(
      'Event 52 is out of range for event sheet "deep": it has 51 numbered events (1-51) before the outline stopped early (see warnings).',
    );
  });

  it('stops at the node limit and says so', () => {
    const events = Array.from({ length: 100_001 }, (_, i) => block(i + 1));
    const outline = buildEventOutline('huge', events);
    expect(outline.truncated).toBe(true);
    expect(outline.totalEvents).toBe(100_000);
    expect(outline.warnings[0]).toContain('traversal limit reached (100000 nodes); the outline stops after event 100000');
    expect(() => locateEvent(outline, 100_001)).toThrow('before the outline stopped early');
  });

  it('produces no warnings on the editor-verified minimal fixture (an empty sheet)', () => {
    const file = join(__dirname, '..', 'fixtures', 'c3-loadable-minimal', 'eventSheets', 'MainSheet.json');
    const sheet = JSON.parse(readFileSync(file, 'utf-8'));
    const outline = buildEventOutline(sheet.name, sheet.events);
    expect(outline.totalEvents).toBe(0);
    expect(outline.warnings).toEqual([]);
    expect(() => locateEvent(outline, 1)).toThrow('it has no numbered events');
  });
});

describe('locateEvent', () => {
  const outline = () => buildEventOutline('es_game', nestedSheet().events);

  it('maps an event number to path, sid, context and neighbours', () => {
    const loc = locateEvent(outline(), 7);
    expect(loc.event).toMatchObject({
      number: 7,
      path: 'events[3].children[4].children[0]',
      sid: 16,
      kind: 'block',
      eventType: 'block',
      depth: 2,
      enclosingGroups: ['Movement', 'Nested'],
      summary: 'IF Keyboard.key-is-down(key=32) => DO Player[Platform].simulate-control(control=jump)',
      conditions: ['1: Keyboard.key-is-down(key=32)'],
      actions: ['1: DO Player[Platform].simulate-control(control=jump)'],
    });
    expect(loc.previousEvent).toEqual({
      number: 6, path: 'events[3].children[4]', kind: 'group', summary: 'GROUP [Nested] (inactive on start)',
    });
    expect(loc.nextEvent).toMatchObject({ number: 8, path: 'events[4]', kind: 'function' });
    expect(loc.totalEvents).toBe(13);
    expect(loc.numbering).toBe(NUMBERING_RULE);
    expect(loc.condition).toBeUndefined();
    expect(loc.action).toBeUndefined();
    expect(loc.notes).toEqual([]);
  });

  it('has no previous event for event 1 and no next event for the last one', () => {
    expect(locateEvent(outline(), 1).previousEvent).toBeNull();
    const last = locateEvent(outline(), 13);
    expect(last.nextEvent).toBeNull();
    expect(last.previousEvent).toMatchObject({ number: 12, path: 'events[6]', kind: 'script' });
  });

  it('resolves a 1-based action number to actions[M-1] and names the 0-based reading', () => {
    const loc = locateEvent(outline(), 2, { actionNumber: 2 });
    expect(loc.action).toEqual({
      number: 2,
      index: 1,
      path: 'events[3].children[0].actions[1]',
      kind: 'call',
      sid: 112,
      disabled: false,
      text: 'CALL Spawn("Enemy", 3)',
    });
    expect(loc.notes).toHaveLength(1);
    expect(loc.notes[0]).toContain('Action 2 is read 1-based, as runtime script errors');
    expect(loc.notes[0]).toContain('editor load errors (e.g. "Empty expression") count actions from 0 (not verified)');
    expect(loc.notes[0]).toContain(
      'read that way (actionIndexBase=0), action 2 is events[3].children[0].actions[2]: SCRIPT: runtime.globalVars.Score = 0; (+1 lines).',
    );
  });

  it('says when the 0-based reading has no such action', () => {
    const loc = locateEvent(outline(), 2, { actionNumber: 3 });
    expect(loc.action).toMatchObject({ index: 2, kind: 'script' });
    expect(loc.notes[0]).toContain('action 3 is no such action');
  });

  it('reads action numbers 0-based with actionIndexBase=0', () => {
    const loc = locateEvent(outline(), 2, { actionNumber: 0, actionIndexBase: 0 });
    expect(loc.action).toMatchObject({ number: 0, index: 0, path: 'events[3].children[0].actions[0]' });
    expect(loc.event.actions).toEqual([
      '0: DO Player[Platform].set-max-speed(max-speed=300)',
      '1: CALL Spawn("Enemy", 3)',
      '2: SCRIPT: runtime.globalVars.Score = 0; (+1 lines)',
    ]);
    expect(loc.notes[0]).toContain('Action 0 is read 0-based (actionIndexBase=0)');
    expect(loc.notes[0]).toContain('Runtime script errors count actions from 1 (verified); read that way, action 0 is no such action.');
    expect(() => locateEvent(outline(), 2, { actionNumber: 3, actionIndexBase: 0 })).toThrow('has 3 action(s) (0-2)');
  });

  it('rejects action 0 in the default 1-based reading with a hint', () => {
    expect(() => locateEvent(outline(), 2, { actionNumber: 0 })).toThrow(
      'Action 0 is out of range: event 2 in "es_game" has 3 action(s) (1-3). If the number is 0-based, set actionIndexBase=0.',
    );
  });

  it('resolves actions in a function block\'s own action list', () => {
    const loc = locateEvent(outline(), 8, { actionNumber: 3 });
    expect(loc.event.path).toBe('events[4]');
    expect(loc.action).toMatchObject({ index: 2, path: 'events[4].actions[2]', sid: 202 });
  });

  it('resolves a function block\'s own condition', () => {
    const loc = locateEvent(outline(), 8, { conditionNumber: 1 });
    expect(loc.condition).toMatchObject({ index: 0, path: 'events[4].conditions[0]', sid: 203, text: 'System.for-each(object=Enemy)' });
    expect(loc.event.summary.startsWith('FUNCTION DoThing(a: number) -> number [async] IF System.for-each(object=Enemy) => ')).toBe(true);
  });

  it('resolves a 1-based condition number and notes the assumption', () => {
    const loc = locateEvent(outline(), 5, { conditionNumber: 2 });
    expect(loc.condition).toMatchObject({
      number: 2, index: 1, path: 'events[3].children[3].conditions[1]', sid: 141, text: 'Keyboard.key-is-down(key=39)',
    });
    expect(loc.notes.join(' ')).toContain('1-based');
  });

  it('counts action comment rows, as the CommandAndConstruct export shows', () => {
    // Shape of "Multiplayer join events" event 5: four ACEs, a comment row, then a script.
    // The export gives the script debug index 5 (MultiplayerJoinEvents_Event5_Act6), so action 6 = actions[5].
    const events = [
      { eventType: 'variable', name: 'x', type: 'number', initialValue: '0', sid: 1 },
      block(2), block(3), block(4), block(5, { children: [] }),
      {
        eventType: 'function-block', functionName: 'StartJoinAttempt', functionParameters: [], sid: 6, conditions: [],
        actions: [
          { id: 'set-enabled', objectClass: 'JoinCode', sid: 7, parameters: { mode: 'disabled' } },
          { id: 'set-enabled', objectClass: 'JoinButton', sid: 8, parameters: { mode: 'disabled' } },
          { id: 'set-text', objectClass: 'Status', sid: 9, parameters: { text: '"Connecting..."' } },
          { id: 'connect', objectClass: 'Multiplayer', sid: 10, parameters: { server: '"wss://example"' } },
          { type: 'comment', text: 'Set the gameMode global' },
          { type: 'script', language: 'javascript', script: ['Globals.gameMode = "multiplayer-peer";'] },
        ],
      },
    ];
    const loc = locateEvent(buildEventOutline('Multiplayer join events', events), 5, { actionNumber: 6 });
    expect(loc.event.path).toBe('events[5]');
    expect(loc.action).toMatchObject({ index: 5, kind: 'script', path: 'events[5].actions[5]' });
    expect(loc.notes).toHaveLength(1);
  });

  it('counts disabled action rows, as exports keep the script\'s debug index', () => {
    // Exports drop disabled actions, but a script after two disabled rows keeps debug index 2 ("action 3").
    const events = [block(1, {
      actions: [
        { id: 'wait', objectClass: 'System', sid: 11, disabled: true, parameters: { seconds: '1' } },
        { id: 'wait', objectClass: 'System', sid: 12, disabled: true, parameters: { seconds: '1' } },
        { type: 'script', language: 'javascript', script: 'y()' },
      ],
    })];
    const o = buildEventOutline('Sheet1', events);
    const expected = { number: 3, index: 2, kind: 'script', path: 'events[0].actions[2]', text: 'SCRIPT: y()' };
    expect(locateEvent(o, 1, { actionNumber: 3 }).action).toMatchObject(expected);
    // countActionComments only skips comment rows; disabled rows always count.
    expect(locateEvent(o, 1, { actionNumber: 3, countActionComments: false }).action).toMatchObject(expected);
    expect(locateEvent(o, 1).event.actions).toEqual([
      '1: DO System.wait(seconds=1) [disabled]',
      '2: DO System.wait(seconds=1) [disabled]',
      '3: SCRIPT: y()',
    ]);
    expect(NUMBERING_RULE).toContain('Action M is actions[M-1], comment and disabled rows included');
  });

  it('flags an action number that lands on a comment row', () => {
    const loc = locateEvent(outline(), 13, { actionNumber: 1 });
    expect(loc.action).toMatchObject({ index: 0, kind: 'comment', path: 'events[7].actions[0]' });
    expect(loc.event.actions).toEqual([
      '1: COMMENT: log the frame',
      '2: SCRIPT: console.log(runtime.tickCount);',
      '3: DO System.add-to-eventvar(variable=Score, value=1)',
    ]);
    expect(loc.notes).toHaveLength(2);
    expect(loc.notes[0]).toContain('action 1 is events[7].actions[1]: SCRIPT: console.log(runtime.tickCount);');
    expect(loc.notes[1]).toBe('Action 1 is a comment row, which cannot raise an error: check the number and actionIndexBase.');
  });

  it('skips action comment rows when countActionComments is false and names the verified reading', () => {
    const loc = locateEvent(outline(), 13, { actionNumber: 1, countActionComments: false });
    expect(loc.action).toMatchObject({ number: 1, index: 1, kind: 'script', path: 'events[7].actions[1]' });
    expect(loc.event.actions[0]).toBe('-: COMMENT: log the frame');
    expect(loc.notes[1]).toBe(
      'countActionComments=false skips comment rows, but runtime script errors count them (verified); ' +
      'counting them, action 1 is events[7].actions[0]: COMMENT: log the frame.',
    );
    expect(() => locateEvent(outline(), 13, { actionNumber: 3, countActionComments: false })).toThrow(
      'Action 3 is out of range: event 13 in "es_game" has 2 action(s) (1-2). ' +
      'countActionComments=false skipped 1 comment row(s); counting them, as runtime script errors do (verified), ' +
      'action 3 is events[7].actions[2]: DO System.add-to-eventvar(variable=Score, value=1).',
    );
  });

  it('says when an event\'s actions are only comment rows that countActionComments=false skips', () => {
    const events = [block(1, { actions: [{ type: 'comment', text: 'a' }, { type: 'comment', text: 'b' }] })];
    const run = () => locateEvent(buildEventOutline('s', events), 1, { actionNumber: 1, countActionComments: false });
    expect(run).toThrow(
      'Event 1 in "s" (IF (no conditions)) has only comment rows in its actions (2), and countActionComments=false skips them. ' +
      'Runtime script errors count comment rows (verified), but a comment row cannot raise an error: check the event number.',
    );
    expect(run).not.toThrow('has no actions');
  });

  it('names the reading with comment rows when an action is out of range only without them', () => {
    const events = [block(1, { actions: [{ type: 'comment', text: 'a' }, { id: 'destroy', objectClass: 'E', sid: 2 }] })];
    const o = buildEventOutline('s', events);
    expect(() => locateEvent(o, 1, { actionNumber: 2, countActionComments: false })).toThrow(
      'Action 2 is out of range: event 1 in "s" has 1 action(s) (1-1). ' +
      'countActionComments=false skipped 1 comment row(s); counting them, as runtime script errors do (verified), ' +
      'action 2 is events[0].actions[1]: DO E.destroy().',
    );
    expect(() => locateEvent(o, 1, { actionNumber: 5, countActionComments: false })).toThrow(
      'counting them, as runtime script errors do (verified), the event has 2 action(s) (1-2).',
    );
  });

  it('adds no comment-row note when no comment row is involved', () => {
    const loc = locateEvent(outline(), 8, { actionNumber: 1 });
    expect(loc.notes).toHaveLength(1);
    expect(loc.notes[0]).not.toContain('comment row');
  });

  it('throws a clear error when the event number is out of range', () => {
    expect(() => locateEvent(outline(), 14)).toThrow(
      'Event 14 is out of range for event sheet "es_game": it has 13 numbered events (1-13).',
    );
    expect(() => locateEvent(outline(), 0)).toThrow('out of range');
  });

  it('throws when the condition or action does not exist', () => {
    expect(() => locateEvent(outline(), 2, { actionNumber: 4 })).toThrow(
      'Action 4 is out of range: event 2 in "es_game" has 3 action(s) (1-3).',
    );
    expect(() => locateEvent(outline(), 2, { conditionNumber: 2 })).toThrow('has 1 condition(s) (1-1)');
    expect(() => locateEvent(outline(), 1, { actionNumber: 1 })).toThrow('(GROUP [Movement]) has no actions');
    expect(() => locateEvent(outline(), 9, { conditionNumber: 1 })).toThrow('has no conditions');
  });
});

describe('renderOutline', () => {
  const outline = () => buildEventOutline('es_game', nestedSheet().events);

  it('renders a readable, numbered outline with unnumbered rows marked "-"', () => {
    const page = renderOutline(outline());
    expect(page).toMatchObject({ firstEvent: 1, lastEvent: 13, nextStartEvent: null, stoppedBy: 'end' });
    expect(page.text.split('\n').slice(0, 2)).toEqual([
      'Event sheet "es_game": 13 numbered event(s), 5 unnumbered row(s) (variables, includes, comments).',
      'Showing events 1-13.',
    ]);
    const body = page.text.split('\n\n').slice(1).join('\n\n');
    expect(body.split('\n')).toEqual([
      ' - VAR Score: number = 0',
      ' - INCLUDE Common',
      ' - COMMENT: Main logic',
      ' 1 GROUP [Movement]',
      ' 2   IF System.on-start-of-layout()',
      '         DO Player[Platform].set-max-speed(max-speed=300)',
      '         CALL Spawn("Enemy", 3)',
      '         SCRIPT: runtime.globalVars.Score = 0; (+1 lines)',
      ' 3     IF NOT Player[Platform].is-on-floor() [legacy behavior-type]',
      ' 4     ELSE',
      '           DO Enemy.destroy()',
      ' -   COMMENT: sub comment',
      ' -   VAR speed: number = 5 [static]',
      ' 5   IF Keyboard.key-is-down(key=37) OR Keyboard.key-is-down(key=39) [disabled]',
      '         DO Player.set-x(x=Self.X + 1) [disabled]',
      ' 6   GROUP [Nested] (inactive on start)',
      ' 7     IF Keyboard.key-is-down(key=32)',
      '           DO Player[Platform].simulate-control(control=jump)',
      ' 8 FUNCTION DoThing(a: number) -> number [async] IF System.for-each(object=Enemy)',
      '       SCRIPT: // hi (+1 lines)',
      '       COMMENT: return twice a',
      '       DO Functions.set-function-return-value(value=a * 2)',
      ' 9   IF (no conditions)',
      '         CALL Other()',
      '10 CUSTOM ACTION Player.jump() IF Player[Platform].is-on-floor() AND ' +
        'Player.compare-instance-variable(instance-variable=lives, comparison=4, value=0) [disabled]',
      '11   IF (no conditions)',
      '         CALL Player.land()',
      '12 SCRIPT BLOCK: const x = 1; (+1 lines)',
      '13 IF System.every-tick()',
      '       COMMENT: log the frame',
      '       SCRIPT: console.log(runtime.tickCount);',
      '       DO System.add-to-eventvar(variable=Score, value=1)',
    ]);
    expect(page.text).toContain('Event sheet "es_game": 13 numbered event(s), 5 unnumbered row(s)');
    expect(page.text).toContain('Showing events 1-13.');
    expect(page.text).toContain(`Numbering: ${NUMBERING_RULE}`);
    expect(page.text).toContain('"Obj.action (Family)" = the family\'s custom action run on Obj');
  });

  it('pages by event number and names the enclosing rows of a page that starts inside them', () => {
    const first = renderOutline(outline(), { limit: 5 });
    expect(first).toMatchObject({ firstEvent: 1, lastEvent: 5, nextStartEvent: 6, stoppedBy: 'limit' });
    expect(first.text.split('\n')[1]).toBe('Showing events 1-5. Next page: startEvent=6.');
    expect(first.text).not.toContain(' 6   GROUP [Nested]');

    const second = renderOutline(outline(), { startEvent: 6, limit: 3 });
    expect(second).toMatchObject({ firstEvent: 6, lastEvent: 8, nextStartEvent: 9 });
    const lines = second.text.split('\n');
    const body = lines.slice(lines.indexOf('') + 1);
    expect(body[0]).toBe('   (inside event 1: GROUP [Movement])');
    expect(body[1]).toBe(' 6   GROUP [Nested] (inactive on start)');
    expect(lines).toContain(' 8 FUNCTION DoThing(a: number) -> number [async] IF System.for-each(object=Enemy)');
    expect(lines).not.toContain(' - VAR Score: number = 0');
    expect(lines).not.toContain(' 9   IF (no conditions)');
  });

  it('hides events deeper than maxDepth but keeps their numbers', () => {
    const page = renderOutline(outline(), { maxDepth: 0 });
    const lines = page.text.split('\n');
    expect(lines).toContain(' 1 GROUP [Movement]');
    expect(lines).toContain('     … events 2-7 and 2 unnumbered row(s) hidden (maxDepth=0)');
    expect(lines).toContain(' 8 FUNCTION DoThing(a: number) -> number [async] IF System.for-each(object=Enemy)');
    expect(lines).toContain('     … event 9 hidden (maxDepth=0)');
    expect(lines).toContain('13 IF System.every-tick()');
    expect(page.text).toContain('Events deeper than level 0 are hidden and do not count toward limit.');
  });

  it('counts only shown events toward limit when maxDepth is set', () => {
    const children = Array.from({ length: 150 }, (_, i) => block(100 + i));
    const events = [
      { eventType: 'group', title: 'G', sid: 1, children },
      ...Array.from({ length: 5 }, (_, i) => block(500 + i, { conditions: [{ id: 'every-tick', objectClass: 'System', sid: 600 + i }] })),
    ];
    const big = buildEventOutline('big', events);
    expect(big.totalEvents).toBe(156);

    const page1 = renderOutline(big, { maxDepth: 0, limit: 3 });
    expect(page1).toMatchObject({ firstEvent: 1, lastEvent: 153, nextStartEvent: 154 });
    const body1 = page1.text.split('\n').slice(page1.text.split('\n').indexOf('') + 1);
    expect(body1).toEqual([
      '  1 GROUP [G]',
      '      … events 2-151 hidden (maxDepth=0)',
      '152 IF System.every-tick()',
      '153 IF System.every-tick()',
    ]);

    const page2 = renderOutline(big, { maxDepth: 0, limit: 3, startEvent: 154 });
    expect(page2).toMatchObject({ firstEvent: 154, lastEvent: 156, nextStartEvent: null });
  });

  it('names the enclosing row when a page starts inside a hidden region', () => {
    const events = [{ eventType: 'group', title: 'G', sid: 1, children: [block(2), block(3)] }, block(4)];
    const page = renderOutline(buildEventOutline('s', events), { maxDepth: 0, startEvent: 3 });
    const lines = page.text.split('\n');
    expect(lines.slice(lines.indexOf('') + 1)).toEqual([
      '  (inside event 1: GROUP [G])',
      '    … event 3 hidden (maxDepth=0)',
      '4 IF (no conditions)',
    ]);
  });

  it('lists at most 50 actions per event, then says how many more there are', () => {
    const actions = (count: number) =>
      Array.from({ length: count }, (_, i) => ({ id: 'set-x', objectClass: 'P', sid: 1000 + i, parameters: { x: i } }));
    const events = [block(1, { actions: actions(60) }), block(2, { actions: actions(50) })];
    const o = buildEventOutline('s', events);

    const page1 = renderOutline(o, { limit: 1 });
    expect(page1).toMatchObject({ firstEvent: 1, lastEvent: 1, nextStartEvent: 2 });
    const body1 = page1.text.split('\n').slice(page1.text.split('\n').indexOf('') + 1);
    expect(body1).toHaveLength(52);
    expect(body1[0]).toBe('1 IF (no conditions)');
    expect(body1[50]).toBe('      DO P.set-x(x=49)');
    expect(body1[51]).toBe(
      '      … (+10 more actions; locate_event with actionNumber shows any of them, get_eventsheet_details has the whole sheet)',
    );

    const page2 = renderOutline(o, { startEvent: 2 });
    const body2 = page2.text.split('\n').slice(page2.text.split('\n').indexOf('') + 1);
    expect(body2).toHaveLength(51);
    expect(body2.at(-1)).toBe('      DO P.set-x(x=49)');
    expect(page2.text).not.toContain('more actions');
  });

  it('lists at most 50 conditions in an event header', () => {
    const conditions = Array.from({ length: 52 }, (_, i) => ({ id: 'compare', objectClass: 'System', sid: 10 + i, parameters: { v: i } }));
    const o = buildEventOutline('s', [block(1, { conditions })]);
    const header = o.nodes[0].header;
    expect(header.startsWith('IF System.compare(v=0) AND System.compare(v=1) AND ')).toBe(true);
    expect(header.endsWith('AND System.compare(v=49) … (+2 more conditions)')).toBe(true);
    expect(header).not.toContain('System.compare(v=50)');
    expect(renderOutline(o).text.split('\n')).toContain(`1 ${header}`);
  });

  it('throws when startEvent is past the last event', () => {
    expect(() => renderOutline(outline(), { startEvent: 14 })).toThrow(
      'startEvent 14 is out of range for event sheet "es_game": it has 13 numbered events.',
    );
  });

  it('renders an empty sheet without error', () => {
    const page = renderOutline(buildEventOutline('Empty', []));
    expect(page).toMatchObject({ firstEvent: null, lastEvent: null, nextStartEvent: null, stoppedBy: 'end' });
    expect(page.text).toContain('No numbered events in this range.');
  });
});

/** Numbered and unnumbered ("-") rows of a page in order; action, "(inside …)" and hidden lines are left out. */
function pageRows(page: OutlinePage, totalEvents: number): Array<{ number: number | null; text: string }> {
  const lines = page.text.split('\n');
  const width = Math.max(String(totalEvents).length, 1);
  return lines.slice(lines.indexOf('') + 1)
    .map(line => ({ lead: line.slice(0, width).trim(), text: line.slice(width + 1).trim() }))
    .filter(row => row.lead !== '')
    .map(row => ({ number: row.lead === '-' ? null : Number(row.lead), text: row.text }));
}

/** Every page from event 1 on, following nextStartEvent. */
function allPages(outline: SheetOutline, options: OutlineRenderOptions): OutlinePage[] {
  const pages: OutlinePage[] = [];
  let startEvent = 1;
  for (let guard = 0; guard < 1000; guard++) {
    const page = renderOutline(outline, { ...options, startEvent });
    pages.push(page);
    if (page.nextStartEvent === null) return pages;
    expect(page.nextStartEvent).toBeGreaterThan(startEvent);
    startEvent = page.nextStartEvent;
  }
  throw new Error('paging did not end within 1000 pages');
}

describe('renderOutline size budget', () => {
  const heavy = () => buildEventOutline('Sheet1', actionHeavyEvents());

  it('ends a page at an event boundary once the next event would pass the budget', () => {
    const outline = heavy();
    // Without the budget, the default page of 100 events is about three times the budget.
    expect(renderOutline(outline, { maxChars: Infinity }).text.length).toBeGreaterThan(3 * OUTLINE_PAGE_CHAR_BUDGET);

    const page = renderOutline(outline);
    expect(page.text.length).toBeLessThanOrEqual(OUTLINE_PAGE_CHAR_BUDGET);
    expect(page.text.length).toBeGreaterThan(OUTLINE_PAGE_CHAR_BUDGET - 2_000);
    expect(page).toMatchObject({ firstEvent: 1, stoppedBy: 'size' });
    expect(page.lastEvent).toBeLessThan(100);
    expect(page.nextStartEvent).toBe(page.lastEvent! + 1);
    expect(page.text.split('\n')[1]).toBe(
      `Showing events 1-${page.lastEvent}. Page ended at the ~40000-character size budget before limit=100 was reached. ` +
      `Next page: startEvent=${page.nextStartEvent}.`,
    );
    const shown = pageRows(page, outline.totalEvents).filter(row => row.number !== null);
    expect(shown.at(-1)!.number).toBe(page.lastEvent);
  });

  it('pages through a whole sheet within the budget, every event and unnumbered row exactly once', () => {
    const outline = heavy();
    expect(outline.totalEvents).toBe(311);
    // One page of limit=1000 would be about nine times the budget.
    expect(renderOutline(outline, { limit: 1000, maxChars: Infinity }).text.length).toBeGreaterThan(9 * OUTLINE_PAGE_CHAR_BUDGET);

    const pages = allPages(outline, { limit: 1000 });
    expect(pages.length).toBeGreaterThan(9);
    for (const page of pages) expect(page.text.length).toBeLessThanOrEqual(OUTLINE_PAGE_CHAR_BUDGET);
    expect(pages.slice(0, -1).every(page => page.stoppedBy === 'size')).toBe(true);
    expect(pages.at(-1)).toMatchObject({ stoppedBy: 'end', lastEvent: 311, nextStartEvent: null });

    const rows = pages.flatMap(page => pageRows(page, outline.totalEvents));
    expect(rows.filter(row => row.number !== null).map(row => row.number))
      .toEqual(Array.from({ length: 311 }, (_, i) => i + 1));
    const unnumbered = outline.nodes.filter(node => node.number === null).map(node => node.header);
    expect(unnumbered).toHaveLength(14); // 6 variables, 7 comments, 1 comment in the group
    expect(new Set(unnumbered).size).toBe(unnumbered.length);
    expect(rows.filter(row => row.number === null).map(row => row.text)).toEqual(unnumbered);
  });

  it('always shows at least one event, even one larger than the budget, so paging moves forward', () => {
    const outline = buildEventOutline('Sheet1', actionHeavyEvents(3, 50));
    const pages = allPages(outline, { maxChars: 2000 });
    expect(pages.map(page => [page.firstEvent, page.lastEvent, page.nextStartEvent, page.stoppedBy])).toEqual([
      [1, 1, 2, 'size'],
      [2, 2, 3, 'size'],
      [3, 3, null, 'end'],
    ]);
    expect(pages[0].text.split('\n')[1]).toBe(
      'Showing events 1-1. Page ended at the ~2000-character size budget before limit=100 was reached. Next page: startEvent=2.',
    );
    // Each event keeps its whole action list (50 lines) on its page.
    expect(pages[0].text.split('\n').filter(line => line.includes('DO System.set-eventvar-value'))).toHaveLength(50);
    // A header alone over the budget still leaves one event per page.
    expect(allPages(outline, { maxChars: 0 }).map(page => page.firstEvent)).toEqual([1, 2, 3]);
  });

  it('never ends a page at a hidden event, whatever the budget', () => {
    const outline = heavy();
    // Events 102-111 are the group's children (depth 1), hidden with maxDepth=0.
    const byNumber = new Map(outline.nodes.filter(node => node.number !== null).map(node => [node.number, node]));
    expect(byNumber.get(101)!.kind).toBe('group');
    const expectedShown = Array.from({ length: 311 }, (_, i) => i + 1).filter(n => n < 102 || n > 111);

    for (let maxChars = 3_000; maxChars <= 9_000; maxChars += 250) {
      const pages = allPages(outline, { maxDepth: 0, limit: 1000, maxChars });
      for (const page of pages.slice(0, -1)) {
        expect(page.stoppedBy).toBe('size');
        expect(byNumber.get(page.nextStartEvent!)!.depth).toBe(0);
      }
      const rows = pages.flatMap(page => pageRows(page, outline.totalEvents));
      expect(rows.filter(row => row.number !== null).map(row => row.number)).toEqual(expectedShown);
      const hiddenLines = pages.flatMap(page => page.text.split('\n').filter(line => line.includes('hidden (maxDepth=0)')));
      expect(hiddenLines).toEqual(['      … events 102-111 and 1 unnumbered row(s) hidden (maxDepth=0)']);
      const groupPage = pages.find(page => page.text.includes('101 GROUP [Group1]'))!;
      expect(groupPage.text).toContain('… events 102-111 and 1 unnumbered row(s) hidden');
    }
  });

  it('leaves pages under the budget as they were', () => {
    const outline = buildEventOutline('es_game', nestedSheet().events);
    const optionSets: OutlineRenderOptions[] = [
      {}, { limit: 5 }, { startEvent: 6, limit: 3 }, { maxDepth: 0 }, { maxDepth: 1, limit: 2 }, { limit: 1000 },
    ];
    for (const options of optionSets) {
      const page = renderOutline(outline, options);
      expect(page.stoppedBy).not.toBe('size');
      expect(page.text).not.toContain('size budget');
      expect(page).toEqual(renderOutline(outline, { ...options, maxChars: Infinity }));
    }
  });
});
