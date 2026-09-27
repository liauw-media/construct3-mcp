import { describe, it, expect } from 'vitest';
import {
  findGroupByPath,
  resolveGroupPath,
  describeGroupPathProblem,
  isInFunctionBlock,
  validateObjectClasses,
  collectObjectRefs,
  buildBlockEvent,
  resolveBehaviorType,
  findEventsBySid,
  collectEventSids,
  eventSidsMatchingSeveral,
  parseEventPath,
  resolveEventBySid,
  countDescendants,
  summarizeEvents,
  MAX_NESTING_DEPTH,
  MAX_TOTAL_EVENTS,
} from '../../src/tools/event-helpers.js';
import type { ObjectRef } from '../../src/tools/event-helpers.js';
import { buildEventOutline } from '../../src/construct3/analyzers/event-outline.js';
import { MockReader } from '../mocks/mock-reader.js';
import { MockIdGenerator } from '../mocks/mock-id-generator.js';

describe('findGroupByPath', () => {
  it('finds a top-level group', () => {
    const events = [
      { eventType: 'group', title: 'Movement', children: [] },
      { eventType: 'group', title: 'Combat', children: [] },
    ] as Record<string, unknown>[];
    const result = findGroupByPath(events, 'Movement');
    expect(result).toBeDefined();
    expect(result).toEqual([]);
  });

  it('finds a nested group', () => {
    const events = [
      {
        eventType: 'group', title: 'Movement', children: [
          { eventType: 'group', title: 'Collision', children: [{ eventType: 'block' }] },
        ],
      },
    ] as Record<string, unknown>[];
    const result = findGroupByPath(events, 'Movement > Collision');
    expect(result).toBeDefined();
    expect(result).toHaveLength(1);
  });

  it('returns null for missing group', () => {
    const events = [
      { eventType: 'group', title: 'Movement', children: [] },
    ] as Record<string, unknown>[];
    expect(findGroupByPath(events, 'NonExistent')).toBeNull();
  });

  it('returns null for partial path match', () => {
    const events = [
      { eventType: 'group', title: 'Movement', children: [] },
    ] as Record<string, unknown>[];
    expect(findGroupByPath(events, 'Movement > Collision')).toBeNull();
  });

  it('initializes missing children arrays', () => {
    const events = [
      { eventType: 'group', title: 'NoChildren' },
    ] as Record<string, unknown>[];
    const result = findGroupByPath(events, 'NoChildren');
    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);
  });
});

describe('resolveGroupPath (titles with outer whitespace)', () => {
  const group = (title: string, children: unknown[] = []) => ({ eventType: 'group', title, children, sid: 1 });
  const titleOf = (events: Record<string, unknown>[], path: string) => {
    const res = resolveGroupPath(events, path);
    if (!res.children) return res.problem;
    // Identify the group by the marker block it holds
    return (res.children[0] as Record<string, unknown> | undefined)?.marker;
  };
  const marked = (title: string, marker: string, children: unknown[] = []) =>
    group(title, [{ eventType: 'block', marker }, ...children]);

  it('finds a title with trailing whitespace by its trimmed text and as typed', () => {
    const events = [marked('Menu', 'menu'), marked('HUD ', 'hud')] as Record<string, unknown>[];
    expect(titleOf(events, 'HUD')).toBe('hud');
    expect(titleOf(events, 'HUD ')).toBe('hud');
    expect(titleOf(events, 'Menu')).toBe('menu');
  });

  it('finds such titles at any depth, also when the path is written with spaces around ">"', () => {
    const events = [marked(' Screens', 'screens', [marked('Pause  ', 'pause')])] as Record<string, unknown>[];
    expect(titleOf(events, 'Screens > Pause')).toBe('pause');
    expect(titleOf(events, 'Screens>Pause')).toBe('pause');
  });

  it('prefers an exact title over a trimmed match', () => {
    const events = [marked('HUD ', 'spaced'), marked('HUD', 'exact')] as Record<string, unknown>[];
    expect(titleOf(events, 'HUD')).toBe('exact');
  });

  it('refuses a trimmed match that fits several groups, unless the segment is typed with the exact whitespace', () => {
    const events = [marked('HUD ', 'trailing'), marked(' HUD', 'leading')] as Record<string, unknown>[];
    expect(titleOf(events, 'HUD')).toEqual({ kind: 'ambiguous', segment: 'HUD', parents: [], titles: ['HUD ', ' HUD'] });
    expect(titleOf(events, 'HUD ')).toBe('trailing');

    // One space on each side of ">" belongs to the separator
    const nested = [group('Top', [marked('HUD ', 'trailing'), marked(' HUD', 'leading')])] as Record<string, unknown>[];
    expect(titleOf(nested, 'Top > HUD ')).toBe('trailing');
    expect(titleOf(nested, 'Top >HUD ')).toBe('trailing');
    expect(titleOf(nested, 'Top >  HUD')).toBe('leading');
    expect(titleOf(nested, 'Top > HUD')).toMatchObject({ kind: 'ambiguous', parents: ['Top'] });
  });

  it('reaches a title that differs from a sibling\'s only by outer whitespace, as typed', () => {
    const events = [marked('HUD', 'plain'), marked('HUD ', 'trailing')] as Record<string, unknown>[];
    expect(titleOf(events, 'HUD')).toBe('plain');
    expect(titleOf(events, 'HUD ')).toBe('trailing');
    // Whitespace that fits neither title: ambiguous, not silently the trimmed one
    expect(titleOf(events, ' HUD')).toEqual({ kind: 'ambiguous', segment: 'HUD', parents: [], titles: ['HUD', 'HUD '] });

    const nested = [group('Top', [marked('HUD', 'plain'), marked('HUD ', 'trailing')])] as Record<string, unknown>[];
    expect(titleOf(nested, 'Top > HUD ')).toBe('trailing');
    expect(titleOf(nested, 'Top > HUD')).toBe('plain');
    expect(titleOf(nested, 'Top >  HUD')).toMatchObject({ kind: 'ambiguous', parents: ['Top'] });

    // Typed whitespace with only the trimmed title there still finds it
    expect(titleOf([marked('Panel', 'panel')] as Record<string, unknown>[], 'Panel ')).toBe('panel');
  });

  it('reports the level a segment was not found at, with the titles there', () => {
    const events = [group('Top', [group('A '), group('B')])] as Record<string, unknown>[];
    expect(resolveGroupPath(events, 'Top > C').problem).toEqual({ kind: 'not-found', segment: 'C', parents: ['Top'], titles: ['A ', 'B'] });
    expect(findGroupByPath(events, 'Top > C')).toBeNull();
  });

  it('describes problems with quoted titles, so whitespace shows', () => {
    const ambiguous = describeGroupPathProblem({ kind: 'ambiguous', segment: 'HUD', parents: ['Top'], titles: ['HUD ', ' HUD'] }, 'Top > HUD', 'Sheet');
    expect(ambiguous).toContain('Group path "Top > HUD" is ambiguous in "Sheet": 2 groups inside group "Top" have the title "HUD"');
    expect(ambiguous).toContain('"HUD ", " HUD"');
    const missing = describeGroupPathProblem({ kind: 'not-found', segment: 'X', parents: [], titles: [] }, 'X', 'Sheet');
    expect(missing).toBe('Group path "X" not found in "Sheet": no group titled "X" at the top level.\nNo groups at the top level of this event sheet.');
  });
});

describe('isInFunctionBlock', () => {
  // SID 6 is used twice, once inside the function and once outside
  const events = [
    { eventType: 'block', sid: 1, children: [{ eventType: 'block', sid: 2 }] },
    { eventType: 'group', sid: 3, children: [{ eventType: 'block', sid: 4 }, { eventType: 'block', sid: 6 }] },
    { eventType: 'function-block', sid: 5, children: [{ eventType: 'block', sid: 6, children: [{ eventType: 'block', sid: 7 }] }] },
  ] as Record<string, unknown>[];
  const at = (...path: number[]) => path.slice(1).reduce(
    (ev: any, i) => ev.children[i], events[path[0]]) as Record<string, unknown>;

  it('is true for a function block and its sub-events at any depth', () => {
    expect([at(2), at(2, 0), at(2, 0, 0)].map(ev => isInFunctionBlock(events, ev))).toEqual([true, true, true]);
  });

  it('is false elsewhere, also for an event that shares a SID with one in a function, and for foreign objects', () => {
    expect([at(0), at(0, 0), at(1), at(1, 0), at(1, 1), { eventType: 'block', sid: 6 }].map(ev => isInFunctionBlock(events, ev)))
      .toEqual([false, false, false, false, false, false]);
  });
});

describe('validateObjectClasses — built-in Functions object', () => {
  const setReturn = { objectClass: 'Functions', aceId: 'set-function-return-value', kind: 'action' as const };

  it('accepts its actions without errors or warnings', async () => {
    const reader = new MockReader();
    const refs = ['set-function-return-value', 'map-function', 'map-function-default', 'call-mapped-function']
      .map(aceId => ({ objectClass: 'Functions', aceId, kind: 'action' as const }));
    expect(await validateObjectClasses(reader as any, refs, { insideFunction: true })).toEqual({ errors: [], warnings: [] });
  });

  it('uses the name the project gives it (functionsName)', async () => {
    const reader = new MockReader() as any;
    const base = reader.getProject.bind(reader);
    reader.getProject = () => ({ ...base(), functionsName: 'Fn' });
    expect((await validateObjectClasses(reader, [{ ...setReturn, objectClass: 'Fn' }])).errors).toEqual([]);
    const { errors } = await validateObjectClasses(reader, [setReturn]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Unknown objectClass "Functions".');
    expect(errors[0]).toContain('This project names the built-in Functions object "Fn"');
  });

  it('warns about conditions, unknown actions and behaviors on it, and about its actions on System', async () => {
    const { errors, warnings } = await validateObjectClasses(new MockReader() as any, [
      { objectClass: 'Functions', aceId: 'is-mapped', kind: 'condition' },
      { objectClass: 'Functions', aceId: 'call-function', kind: 'action' },
      { objectClass: 'Functions', aceId: 'map-function', kind: 'action', behaviorType: 'Timer' },
      { objectClass: 'System', aceId: 'set-function-return-value', kind: 'action' },
    ]);
    expect(errors).toEqual([]);
    expect(warnings).toHaveLength(4);
    expect(warnings[0]).toContain('Condition "is-mapped" on "Functions": the built-in Functions object has no conditions on record');
    expect(warnings[1]).toContain('Action "call-function" on "Functions" is not a known action of the built-in Functions object');
    expect(warnings[2]).toContain('behaviorType "Timer" on "Functions": the built-in Functions object has no behaviors');
    expect(warnings[3]).toContain('Action "set-function-return-value" on "System": Construct 3 saves it on the built-in Functions object (objectClass "Functions")');
  });

  it('warns about Set return value outside a function block only when told where the event goes', async () => {
    const reader = new MockReader() as any;
    const outside = await validateObjectClasses(reader, [setReturn], { insideFunction: false });
    expect(outside.warnings).toHaveLength(1);
    expect(outside.warnings[0]).toContain('is not inside a function block');
    expect((await validateObjectClasses(reader, [setReturn], { insideFunction: true })).warnings).toEqual([]);
    expect((await validateObjectClasses(reader, [setReturn])).warnings).toEqual([]);
  });

  it('treats the name as the built-in Functions object even when an object type takes it (such a project does not load)', async () => {
    const reader = new MockReader({ objects: new Map([['Functions', { name: 'Functions', 'plugin-id': 'Sprite', sid: 1 }]]) });
    const { errors, warnings } = await validateObjectClasses(reader as any, [
      { objectClass: 'Functions', aceId: 'set-visible', kind: 'action' },
      setReturn,
    ], { insideFunction: false });
    expect(errors).toEqual([]);
    expect(warnings).toEqual([
      expect.stringContaining('Action "set-visible" on "Functions" is not a known action of the built-in Functions object'),
      expect.stringContaining('is not inside a function block'),
    ]);
  });
});

describe('validateObjectClasses', () => {
  it('accepts valid object classes', async () => {
    const reader = new MockReader({
      objects: new Map([['Player', { name: 'Player', 'plugin-id': 'Sprite', sid: 1 }]]),
    });
    const { errors, warnings } = await validateObjectClasses(
      reader as any,
      [{ objectClass: 'Player' }, { objectClass: 'System' }],
    );
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it('rejects unknown object classes', async () => {
    const reader = new MockReader();
    const { errors } = await validateObjectClasses(
      reader as any,
      [{ objectClass: 'NonExistent' }],
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Unknown objectClass "NonExistent"');
  });

  // Behavior fixtures mirror real C3 data (mapsandapps/construct-3-games
  // battlelands): Player has behaviors MoveTo and EightDir (named "8Direction");
  // family Entities (members Player, Enemy) has Tween, and the real event
  // sheets use objectClass "Enemy" + behaviorType "Tween".
  function behaviorReader() {
    return new MockReader({
      objects: new Map<string, Record<string, unknown>>([
        ['Player', {
          name: 'Player', 'plugin-id': 'Sprite', sid: 1,
          behaviorTypes: [
            { behaviorId: 'MoveTo', name: 'MoveTo', sid: 11 },
            { behaviorId: 'EightDir', name: '8Direction', sid: 12 },
          ],
        }],
        ['Enemy', { name: 'Enemy', 'plugin-id': 'Sprite', sid: 2, behaviorTypes: [] }],
        ['Wall', { name: 'Wall', 'plugin-id': 'Sprite', sid: 3 }],
      ]),
      families: new Map([
        ['Entities', {
          name: 'Entities', 'plugin-id': 'Sprite', sid: 4, members: ['Player', 'Enemy'],
          behaviorTypes: [{ behaviorId: 'Tween', name: 'Tween', sid: 41 }],
        }],
      ]),
    });
  }

  it('accepts a behaviorType defined on the object type without warnings', async () => {
    const { errors, warnings } = await validateObjectClasses(
      behaviorReader() as any,
      [{ objectClass: 'Player', behaviorType: '8Direction' }],
    );
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it('accepts a behaviorType inherited from a family the object belongs to', async () => {
    const { errors, warnings } = await validateObjectClasses(
      behaviorReader() as any,
      [{ objectClass: 'Enemy', behaviorType: 'Tween' }, { objectClass: 'Entities', behaviorType: 'Tween' }],
    );
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it('warns (does not error) when behaviorType is not on the object or its families', async () => {
    const { errors, warnings } = await validateObjectClasses(
      behaviorReader() as any,
      [{ objectClass: 'Player', behaviorType: 'Platform' }],
    );
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('behaviorType "Platform"');
    expect(warnings[0]).toContain('available: MoveTo, 8Direction, Tween');
  });

  it('suggests the behavior name when a behaviorId is passed', async () => {
    const { warnings } = await validateObjectClasses(
      behaviorReader() as any,
      [{ objectClass: 'Player', behaviorType: 'EightDir' }],
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Did you mean the behavior name "8Direction"');
  });

  it('checks family objectClasses against the family behaviors only', async () => {
    const { warnings } = await validateObjectClasses(
      behaviorReader() as any,
      [{ objectClass: 'Entities', behaviorType: '8Direction' }],
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('family "Entities"');
  });

  it('warns about behaviorType on System and on objects without behaviors', async () => {
    const { errors, warnings } = await validateObjectClasses(
      behaviorReader() as any,
      [{ objectClass: 'System', behaviorType: 'Platform' }, { objectClass: 'Wall', behaviorType: 'Solid' }],
    );
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('System has no behaviors');
    expect(warnings[1]).toContain('available: none');
  });

  it('says "could not be verified" when a family file is unreadable', async () => {
    const reader = behaviorReader();
    // Entities is listed in the project, but its file could not be read
    reader.readAllFamilies = async () => new Map();
    const { errors, warnings } = await validateObjectClasses(
      reader as any,
      [{ objectClass: 'Entities', behaviorType: 'Tween' }, { objectClass: 'Enemy', behaviorType: 'Tween' }],
    );
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('could not be verified (family file unreadable)');
    expect(warnings[1]).toContain('could not be verified');
    expect(warnings.join('\n')).not.toContain('available: none');
  });

  it('reports each object/behavior pair once', async () => {
    const { warnings } = await validateObjectClasses(
      behaviorReader() as any,
      [{ objectClass: 'Player', behaviorType: 'Nope' }, { objectClass: 'Player', behaviorType: 'Nope' }],
    );
    expect(warnings).toHaveLength(1);
  });

  it('warns once when the deprecated behavior-type alias was used', async () => {
    const { warnings } = await validateObjectClasses(
      behaviorReader() as any,
      [
        { objectClass: 'Player', behaviorType: '8Direction', usedLegacyKey: true },
        { objectClass: 'Player', behaviorType: 'MoveTo', usedLegacyKey: true },
      ],
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('deprecated "behavior-type"');
  });
});

describe('resolveBehaviorType', () => {
  it('returns the canonical behaviorType', () => {
    expect(resolveBehaviorType({ objectClass: 'Player', behaviorType: 'Platform' }))
      .toEqual({ behaviorType: 'Platform', usedLegacyKey: false });
  });

  it('normalizes the deprecated behavior-type alias', () => {
    expect(resolveBehaviorType({ objectClass: 'Player', 'behavior-type': 'Platform' }))
      .toEqual({ behaviorType: 'Platform', usedLegacyKey: true });
  });

  it('accepts both keys when they agree', () => {
    expect(resolveBehaviorType({ objectClass: 'Player', behaviorType: 'Platform', 'behavior-type': 'Platform' }).behaviorType)
      .toBe('Platform');
  });

  it('throws when both keys disagree', () => {
    expect(() => resolveBehaviorType({ id: 'flash', objectClass: 'Car', behaviorType: 'Car', 'behavior-type': 'Flash' }))
      .toThrow('Conflicting behavior keys');
  });

  it('treats a missing or empty value as no behavior', () => {
    expect(resolveBehaviorType({ objectClass: 'System' }).behaviorType).toBeUndefined();
    expect(resolveBehaviorType({ objectClass: 'System', behaviorType: '' }).behaviorType).toBeUndefined();
  });

  it('does not flag an empty deprecated alias as used (nothing is written for it)', () => {
    expect(resolveBehaviorType({ objectClass: 'System', 'behavior-type': '' }))
      .toEqual({ behaviorType: undefined, usedLegacyKey: false });
    expect(resolveBehaviorType({ objectClass: 'Player', behaviorType: 'Platform', 'behavior-type': '' }))
      .toEqual({ behaviorType: 'Platform', usedLegacyKey: false });
  });
});

describe('collectObjectRefs', () => {
  it('collects refs from conditions and actions', () => {
    const refs: ObjectRef[] = [];
    collectObjectRefs(
      [{ objectClass: 'Player', behaviorType: 'Platform' }],
      [{ objectClass: 'Enemy', id: 'destroy', sid: 1 }],
      [],
      refs,
    );
    expect(refs).toHaveLength(2);
    expect(refs[0]).toEqual({ objectClass: 'Player', behaviorType: 'Platform', kind: 'condition' });
    expect(refs[1]).toEqual({ objectClass: 'Enemy', aceId: 'destroy', kind: 'action' });
  });

  it('normalizes the deprecated behavior-type alias and flags it', () => {
    const refs: ObjectRef[] = [];
    collectObjectRefs(
      [{ objectClass: 'Player', 'behavior-type': 'Platform' }],
      [{ objectClass: 'Car', id: 'flash', 'behavior-type': 'Car' }],
      [],
      refs,
    );
    expect(refs).toEqual([
      { objectClass: 'Player', behaviorType: 'Platform', usedLegacyKey: true, kind: 'condition' },
      { objectClass: 'Car', aceId: 'flash', behaviorType: 'Car', usedLegacyKey: true, kind: 'action' },
    ]);
  });

  it('collects refs from nested children', () => {
    const refs: ObjectRef[] = [];
    collectObjectRefs(
      [],
      [],
      [{
        conditions: [{ objectClass: 'System', id: 'every-tick', sid: 1 }],
        actions: [{ objectClass: 'Bullet', id: 'destroy', sid: 2 }],
        children: [],
      }],
      refs,
    );
    expect(refs).toHaveLength(2);
    expect(refs[0].objectClass).toBe('System');
    expect(refs[1].objectClass).toBe('Bullet');
  });
});

describe('buildBlockEvent', () => {
  it('builds a simple block with conditions and actions', async () => {
    const reader = new MockReader({
      objects: new Map([['Player', { name: 'Player', 'plugin-id': 'Sprite', sid: 1 }]]),
    });
    const idGen = new MockIdGenerator();
    const counter = { count: 0, warnings: [] };

    const block = await buildBlockEvent(
      reader as any,
      idGen as any,
      {
        conditions: [{ id: 'on-start-of-layout', objectClass: 'System' }],
        actions: [{ id: 'set-instvar-value', objectClass: 'Player' }],
        children: [],
      },
      1,
      counter,
    );

    expect(block.eventType).toBe('block');
    expect(block.conditions).toHaveLength(1);
    expect(block.actions).toHaveLength(1);
    expect(block.sid).toBe(100_000_000_000_001);
    expect(counter.count).toBe(1);
  });

  it('builds block with children', async () => {
    const reader = new MockReader();
    const idGen = new MockIdGenerator();
    const counter = { count: 0, warnings: [] };

    const block = await buildBlockEvent(
      reader as any,
      idGen as any,
      {
        conditions: [{ id: 'on-start-of-layout', objectClass: 'System' }],
        actions: [],
        children: [{
          conditions: [{ id: 'compare-instance-variable', objectClass: 'System' }],
          actions: [],
          children: [],
        }],
      },
      1,
      counter,
    );

    expect(block.children).toHaveLength(1);
    expect(counter.count).toBe(2);
  });

  it('builds else block without conditions', async () => {
    const reader = new MockReader();
    const idGen = new MockIdGenerator();
    const counter = { count: 0, warnings: [] };

    const block = await buildBlockEvent(
      reader as any,
      idGen as any,
      {
        conditions: [],
        actions: [{ id: 'log', objectClass: 'System' }],
        isElse: true,
        children: [],
      },
      1,
      counter,
    );

    // Else is the editor's System "else" first condition, never a block key
    expect(block.conditions).toEqual([{ id: 'else', objectClass: 'System', sid: 100_000_000_000_002 }]);
    expect(block).not.toHaveProperty('isElse');
    expect(Object.keys(block.conditions[0])).toEqual(['id', 'objectClass', 'sid']);
  });

  it('builds script actions', async () => {
    const reader = new MockReader();
    const idGen = new MockIdGenerator();
    const counter = { count: 0, warnings: [] };

    const block = await buildBlockEvent(
      reader as any,
      idGen as any,
      {
        conditions: [{ id: 'on-start-of-layout', objectClass: 'System' }],
        actions: [{ type: 'script' as const, script: 'console.log("hi")' }],
        children: [],
      },
      1,
      counter,
    );

    expect(block.actions).toHaveLength(1);
    expect((block.actions[0] as any).type).toBe('script');
  });

  it('rejects nesting beyond MAX_NESTING_DEPTH', async () => {
    const reader = new MockReader();
    const idGen = new MockIdGenerator();
    const counter = { count: 0, warnings: [] };

    await expect(
      buildBlockEvent(
        reader as any,
        idGen as any,
        {
          conditions: [{ id: 'x', objectClass: 'System' }],
          actions: [],
          children: [],
        },
        MAX_NESTING_DEPTH + 1,
        counter,
      ),
    ).rejects.toThrow('maximum depth');
  });

  it('rejects exceeding MAX_TOTAL_EVENTS', async () => {
    const reader = new MockReader();
    const idGen = new MockIdGenerator();
    const counter = { count: MAX_TOTAL_EVENTS, warnings: [] };

    await expect(
      buildBlockEvent(
        reader as any,
        idGen as any,
        {
          conditions: [{ id: 'x', objectClass: 'System' }],
          actions: [],
          children: [],
        },
        1,
        counter,
      ),
    ).rejects.toThrow('maximum of');
  });

  it('accepts a top-level block without conditions and notes that it runs every tick', async () => {
    const reader = new MockReader();
    const idGen = new MockIdGenerator();
    const counter = { count: 0, warnings: [] as string[] };

    const block = await buildBlockEvent(
      reader as any,
      idGen as any,
      { conditions: [], actions: [{ id: 'a', objectClass: 'System' }], children: [] },
      1,
      counter,
    );

    expect(block.conditions).toEqual([]);
    expect(block).not.toHaveProperty('isElse');
    expect(counter.warnings.some(w => w.includes('every tick'))).toBe(true);
    expect(counter.warnings.some(w => /set isElse/.test(w))).toBe(false);
  });

  it('accepts sub-events without conditions silently, as the editor writes them', async () => {
    const reader = new MockReader();
    const idGen = new MockIdGenerator();
    const counter = { count: 0, warnings: [] as string[] };

    const block = await buildBlockEvent(
      reader as any,
      idGen as any,
      { conditions: [], actions: [], children: [{ conditions: [], actions: [{ id: 'a', objectClass: 'System' }] }] },
      2,
      counter,
    );

    expect(block.conditions).toEqual([]);
    expect((block.children![0] as any).conditions).toEqual([]);
    expect(counter.warnings).toEqual([]);
  });

  it('writes an else-if: the else condition first, the given conditions after it', async () => {
    const reader = new MockReader();
    const idGen = new MockIdGenerator();
    const counter = { count: 0, warnings: [] as string[] };

    const block = await buildBlockEvent(
      reader as any,
      idGen as any,
      {
        conditions: [{ id: 'x', objectClass: 'System' }],
        actions: [],
        isElse: true,
        children: [],
      },
      1,
      counter,
    );

    expect(block.conditions.map(c => c.id)).toEqual(['else', 'x']);
    expect(counter.warnings.some(w => /ignores conditions/.test(w))).toBe(false);
  });

  it('does not duplicate an explicit System else condition', async () => {
    const reader = new MockReader();
    const idGen = new MockIdGenerator();
    const counter = { count: 0, warnings: [] as string[] };

    const block = await buildBlockEvent(
      reader as any,
      idGen as any,
      { conditions: [{ id: 'else', objectClass: 'System' }, { id: 'x', objectClass: 'System' }], actions: [], isElse: true, children: [] },
      1,
      counter,
    );

    expect(block.conditions.map(c => c.id)).toEqual(['else', 'x']);
    expect(counter.warnings).toEqual([]);
  });

  it('warns when the else condition is not the first condition', async () => {
    const reader = new MockReader();
    const idGen = new MockIdGenerator();
    const counter = { count: 0, warnings: [] as string[] };

    await buildBlockEvent(
      reader as any,
      idGen as any,
      { conditions: [{ id: 'x', objectClass: 'System' }, { id: 'else', objectClass: 'System' }], actions: [], children: [] },
      1,
      counter,
    );

    expect(counter.warnings.some(w => w.includes('is condition 1'))).toBe(true);
  });

  it('leaves the placement of else sub-events to the load-time gate', async () => {
    const reader = new MockReader();
    const idGen = new MockIdGenerator();
    const counter = { count: 0, warnings: [] as string[] };

    const block = await buildBlockEvent(
      reader as any,
      idGen as any,
      {
        conditions: [{ id: 'x', objectClass: 'System' }],
        actions: [],
        children: [{ isElse: true }, { conditions: [{ id: 'y', objectClass: 'System' }] }, { isElse: true }],
      },
      1,
      counter,
    );

    expect((block.children as any[]).map(c => c.conditions[0]?.id)).toEqual(['else', 'y', 'else']);
    // The else-placement rule (checkEventLoadRules) reports the first one when the sheet is written
    expect(counter.warnings).toEqual([]);
  });

  it('drops a second System else condition in an else block instead of writing two', async () => {
    const reader = new MockReader();
    const idGen = new MockIdGenerator();

    for (const input of [
      { conditions: [{ id: 'x', objectClass: 'System' }, { id: 'else', objectClass: 'System' }], isElse: true },
      { conditions: [{ id: 'else', objectClass: 'System' }, { id: 'x', objectClass: 'System' }, { id: 'else', objectClass: 'System' }] },
    ]) {
      const counter = { count: 0, warnings: [] as string[] };
      const block = await buildBlockEvent(reader as any, idGen as any, { actions: [], children: [], ...input }, 1, counter);
      expect(block.conditions.map(c => c.id)).toEqual(['else', 'x']);
      expect(counter.warnings).toHaveLength(1);
      expect(counter.warnings[0]).toMatch(/dropped the System "else" condition given as condition/);
      expect(counter.warnings[0]).not.toMatch(/use isElse: true/);
    }
  });

  it('warns about isOr on first condition', async () => {
    const reader = new MockReader();
    const idGen = new MockIdGenerator();
    const counter = { count: 0, warnings: [] };

    await buildBlockEvent(
      reader as any,
      idGen as any,
      {
        conditions: [{ id: 'x', objectClass: 'System', isOr: true }],
        actions: [],
        children: [],
      },
      1,
      counter,
    );

    expect(counter.warnings.some(w => w.includes('isOr'))).toBe(true);
  });

  it('never writes isOr on a condition', async () => {
    const reader = new MockReader();
    const idGen = new MockIdGenerator();
    const counter = { count: 0, warnings: [] as string[] };

    const block = await buildBlockEvent(
      reader as any,
      idGen as any,
      { conditions: [{ id: 'x', objectClass: 'System', isOr: true }], actions: [], children: [] },
      1,
      counter,
    );

    expect(block.conditions[0]).not.toHaveProperty('isOr');
    expect(block).not.toHaveProperty('isOrBlock');
  });

  it('writes isOrBlock from the block input', async () => {
    const reader = new MockReader();
    const idGen = new MockIdGenerator();
    const counter = { count: 0, warnings: [] as string[] };

    const block = await buildBlockEvent(
      reader as any,
      idGen as any,
      {
        conditions: [{ id: 'a', objectClass: 'System' }, { id: 'b', objectClass: 'System' }],
        actions: [],
        isOrBlock: true,
        children: [{ conditions: [{ id: 'c', objectClass: 'System' }], isOrBlock: true }],
      },
      1,
      counter,
    );

    expect(block.isOrBlock).toBe(true);
    expect((block.children![0] as any).isOrBlock).toBe(true);
    expect(Object.keys(block)).toEqual(['eventType', 'conditions', 'actions', 'sid', 'children', 'isOrBlock']);
    expect(counter.warnings).toEqual([]);
  });

  it('refuses isOr on only some later conditions', async () => {
    const reader = new MockReader();
    const idGen = new MockIdGenerator();
    const counter = { count: 0, warnings: [] as string[] };

    await expect(buildBlockEvent(
      reader as any,
      idGen as any,
      {
        conditions: [{ id: 'a', objectClass: 'System' }, { id: 'b', objectClass: 'System' }, { id: 'c', objectClass: 'System', isOr: true }],
        actions: [],
        children: [],
      },
      1,
      counter,
    )).rejects.toThrow('only some conditions carry isOr');
  });

  it('refuses isOr flags that contradict isOrBlock: false', async () => {
    const reader = new MockReader();
    const idGen = new MockIdGenerator();
    const counter = { count: 0, warnings: [] as string[] };

    await expect(buildBlockEvent(
      reader as any,
      idGen as any,
      {
        conditions: [{ id: 'a', objectClass: 'System' }, { id: 'b', objectClass: 'System', isOr: true }],
        actions: [],
        isOrBlock: false,
        children: [],
      },
      1,
      counter,
    )).rejects.toThrow('isOrBlock is false');
  });

  it('sets isInverted, and maps isOr on every later condition to isOrBlock', async () => {
    const reader = new MockReader();
    const idGen = new MockIdGenerator();
    const counter = { count: 0, warnings: [] as string[] };

    const block = await buildBlockEvent(
      reader as any,
      idGen as any,
      {
        conditions: [
          { id: 'a', objectClass: 'System' },
          { id: 'b', objectClass: 'System', isInverted: true, isOr: true },
        ],
        actions: [],
        children: [],
      },
      1,
      counter,
    );

    expect(block.conditions[1].isInverted).toBe(true);
    expect(block.conditions[1]).not.toHaveProperty('isOr');
    expect(block.isOrBlock).toBe(true);
    expect(counter.warnings.some(w => w.includes('isOrBlock: true'))).toBe(true);
  });

  it('sets disabled on actions', async () => {
    const reader = new MockReader();
    const idGen = new MockIdGenerator();
    const counter = { count: 0, warnings: [] };

    const block = await buildBlockEvent(
      reader as any,
      idGen as any,
      {
        conditions: [{ id: 'a', objectClass: 'System' }],
        actions: [{ id: 'b', objectClass: 'System', disabled: true }],
        children: [],
      },
      1,
      counter,
    );

    expect((block.actions[0] as any).disabled).toBe(true);
  });

  it('writes disabled right after sid on actions and conditions, as the editor does', async () => {
    const reader = new MockReader();
    const idGen = new MockIdGenerator();
    const counter = { count: 0, warnings: [] as string[] };

    const block = await buildBlockEvent(
      reader as any,
      idGen as any,
      {
        conditions: [{ id: 'is-visible', objectClass: 'Sprite1', parameters: { a: '1' }, isInverted: true, disabled: true }],
        actions: [
          { id: 'tween-one-property', objectClass: 'Sprite1', behaviorType: 'Tween', parameters: { tags: '"tag1"' }, disabled: true },
          { id: 'set-position', objectClass: 'Sprite1', parameters: { x: '1', y: '2' }, disabled: true },
          { id: 'destroy', objectClass: 'Sprite1', disabled: true },
        ],
        children: [],
      },
      1,
      counter,
    );

    expect(Object.keys(block.conditions[0])).toEqual(['id', 'objectClass', 'sid', 'disabled', 'parameters', 'isInverted']);
    expect(Object.keys(block.actions[0])).toEqual(['id', 'objectClass', 'sid', 'disabled', 'behaviorType', 'parameters']);
    expect(Object.keys(block.actions[1])).toEqual(['id', 'objectClass', 'sid', 'disabled', 'parameters']);
    expect(Object.keys(block.actions[2])).toEqual(['id', 'objectClass', 'sid', 'disabled']);
  });

  it('writes script actions as lines with language javascript', async () => {
    const reader = new MockReader();
    const idGen = new MockIdGenerator();
    const counter = { count: 0, warnings: [] as string[] };

    const block = await buildBlockEvent(
      reader as any,
      idGen as any,
      {
        conditions: [],
        actions: [
          { type: 'script', script: 'const a = 1;\nconsole.log(a);' },
          { type: 'script', script: 'x();' },
          { type: 'script', script: 'a();\n' },
          { type: 'script', script: 'a();\r\nb();' },
          { type: 'script', script: ['a();', 'b();'], language: 'javascript', disabled: true },
        ],
        children: [],
      },
      2,
      counter,
    );

    expect(block.actions[0]).toEqual({ type: 'script', language: 'javascript', script: ['const a = 1;', 'console.log(a);'] });
    expect(Object.keys(block.actions[0])).toEqual(['type', 'language', 'script']);
    expect((block.actions[1] as any).script).toEqual(['x();']);
    expect((block.actions[2] as any).script).toEqual(['a();', '']);
    expect((block.actions[3] as any).script).toEqual(['a();', 'b();']);
    expect(block.actions[4]).toEqual({ type: 'script', language: 'javascript', script: ['a();', 'b();'], disabled: true });
    expect(Object.keys(block.actions[4])).toEqual(['type', 'language', 'script', 'disabled']);
  });

  it('writes comment rows among the actions without a SID', async () => {
    const reader = new MockReader();
    const idGen = new MockIdGenerator();
    const counter = { count: 0, warnings: [] as string[] };

    const block = await buildBlockEvent(
      reader as any,
      idGen as any,
      { conditions: [], actions: [{ type: 'comment', text: 'note 1' }, { id: 'a', objectClass: 'System' }], children: [] },
      2,
      counter,
    );

    expect(block.actions[0]).toEqual({ type: 'comment', text: 'note 1' });
    expect((block.actions[1] as any).sid).toBe(100_000_000_000_002);
  });

  it('writes function calls in the editor shape and checks them against the function block', async () => {
    const reader = new MockReader({
      eventSheets: new Map([['Sheet1', {
        name: 'Sheet1',
        events: [
          {
            eventType: 'function-block', functionName: 'fn1', sid: 1, conditions: [], actions: [],
            functionParameters: [
              { name: 'p1', type: 'number', initialValue: '0', comment: '', sid: 2 },
              { name: 'p2', type: 'boolean', initialValue: 'false', comment: '', sid: 3 },
            ],
          },
          { eventType: 'function-block', functionName: 'fn0', functionParameters: [], sid: 4, conditions: [], actions: [] },
        ],
      }]]),
    });
    const idGen = new MockIdGenerator();
    const counter = { count: 0, warnings: [] as string[] };

    const block = await buildBlockEvent(
      reader as any,
      idGen as any,
      {
        conditions: [],
        actions: [
          { callFunction: 'fn1', parameters: ['1', true] },
          { callFunction: 'FN0' },
          { callFunction: 'fn1', parameters: [2, false], disabled: true },
          { id: 'call-function', objectClass: 'System', callFunction: 'fn1', parameters: { 0: '1', 1: true } },
          { id: 'call-function', objectClass: 'System', callFunction: 'fn1', parameters: { p2: true, p1: '3' } },
        ],
        children: [],
      },
      2,
      counter,
    );

    expect(block.actions[0]).toEqual({ callFunction: 'fn1', sid: 100_000_000_000_002, parameters: ['1', true] });
    expect(Object.keys(block.actions[1])).toEqual(['callFunction', 'sid']);
    // Written with the function's own spelling, as editor saves spell every call
    expect(block.actions[1].callFunction).toBe('fn0');
    expect(block.actions[2]).toEqual({ callFunction: 'fn1', sid: 100_000_000_000_004, disabled: true, parameters: ['2', false] });
    expect(Object.keys(block.actions[2])).toEqual(['callFunction', 'sid', 'disabled', 'parameters']);
    expect(block.actions[3]).toEqual({ callFunction: 'fn1', sid: 100_000_000_000_005, parameters: ['1', true] });
    expect(block.actions[4]).toEqual({ callFunction: 'fn1', sid: 100_000_000_000_006, parameters: ['3', true] });
    expect(counter.warnings.filter(w => w.includes('id/objectClass were dropped'))).toHaveLength(2);
    expect(counter.warnings.filter(w => w.includes('defined as "fn0"'))).toHaveLength(1);
    // Arity and types match: no other warnings
    expect(counter.warnings).toHaveLength(3);
  });

  it('warns about unknown functions, wrong arity and argument types, refuses unmappable keys', async () => {
    const reader = new MockReader({
      eventSheets: new Map([['Sheet1', {
        name: 'Sheet1',
        events: [{
          eventType: 'function-block', functionName: 'fn1', sid: 1, conditions: [], actions: [],
          functionParameters: [{ name: 'p1', type: 'boolean', initialValue: 'false', comment: '', sid: 2 }],
        }],
      }]]),
    });
    const counter = { count: 0, warnings: [] as string[] };
    await buildBlockEvent(
      reader as any,
      new MockIdGenerator() as any,
      {
        conditions: [],
        actions: [{ callFunction: 'nope' }, { callFunction: 'fn1', parameters: ['1', '2'] }],
        children: [],
      },
      2,
      counter,
    );
    expect(counter.warnings.some(w => w.includes('no function block named "nope"'))).toBe(true);
    expect(counter.warnings.some(w => w.includes('takes 1 parameter(s), but 2'))).toBe(true);
    expect(counter.warnings.some(w => w.includes('"p1" of "fn1" is boolean'))).toBe(true);

    await expect(buildBlockEvent(
      reader as any,
      new MockIdGenerator() as any,
      {
        conditions: [],
        actions: [{ id: 'call-function', objectClass: 'System', callFunction: 'fn1', parameters: { 0: '1', 2: '3' } }],
        children: [],
      },
      2,
      { count: 0, warnings: [] },
    )).rejects.toThrow('without gaps');
    await expect(buildBlockEvent(
      reader as any,
      new MockIdGenerator() as any,
      {
        conditions: [],
        actions: [{ id: 'call-function', objectClass: 'System', callFunction: 'fn1', parameters: { other: '1' } }],
        children: [],
      },
      2,
      { count: 0, warnings: [] },
    )).rejects.toThrow('parameter names do not match');
  });

  // Regression for issue #16: C3 reads "behaviorType"; "behavior-type" made
  // the editor fail with "missing action id".
  it('writes behaviorType (never behavior-type) on conditions, actions and children', async () => {
    const reader = new MockReader();
    const idGen = new MockIdGenerator();
    const counter = { count: 0, warnings: [] };

    const block = await buildBlockEvent(
      reader as any,
      idGen as any,
      {
        conditions: [{ id: 'is-on-floor', objectClass: 'Player', behaviorType: 'Platform' }],
        actions: [{ id: 'simulate-control', objectClass: 'Player', behaviorType: 'Platform', parameters: { control: 'jump' } }],
        children: [{
          conditions: [{ id: 'is-moving', objectClass: 'Player', 'behavior-type': 'Platform' }],
          actions: [{ id: 'flash', objectClass: 'Car', 'behavior-type': 'Flash' }],
          children: [],
        }],
      },
      1,
      counter,
    );

    const json = JSON.stringify(block);
    expect(json).not.toContain('behavior-type');
    expect(block.conditions[0].behaviorType).toBe('Platform');
    expect((block.actions[0] as any).behaviorType).toBe('Platform');
    const child = block.children![0] as any;
    expect(child.conditions[0].behaviorType).toBe('Platform');
    expect(child.actions[0].behaviorType).toBe('Flash');
    // Key order matches what C3 writes: id, objectClass, sid, behaviorType, parameters
    expect(Object.keys(block.actions[0])).toEqual(['id', 'objectClass', 'sid', 'behaviorType', 'parameters']);
  });

  it('omits behaviorType for plugin and System ACEs', async () => {
    const reader = new MockReader();
    const idGen = new MockIdGenerator();
    const counter = { count: 0, warnings: [] };

    const block = await buildBlockEvent(
      reader as any,
      idGen as any,
      {
        conditions: [{ id: 'on-start-of-layout', objectClass: 'System' }],
        actions: [{ id: 'destroy', objectClass: 'Player' }],
        children: [],
      },
      1,
      counter,
    );

    expect('behaviorType' in block.conditions[0]).toBe(false);
    expect('behaviorType' in block.actions[0]).toBe(false);
  });

  it('rejects conflicting behaviorType and behavior-type values', async () => {
    const reader = new MockReader();
    const idGen = new MockIdGenerator();
    const counter = { count: 0, warnings: [] };

    await expect(
      buildBlockEvent(
        reader as any,
        idGen as any,
        {
          conditions: [{ id: 'x', objectClass: 'Player', behaviorType: 'Platform', 'behavior-type': 'Solid' }],
          actions: [],
          children: [],
        },
        1,
        counter,
      ),
    ).rejects.toThrow('Conflicting behavior keys');
  });
});

describe('findEventsBySid', () => {
  it('finds a top-level block by SID', () => {
    const events = [
      { eventType: 'block', sid: 100, conditions: [], actions: [] },
      { eventType: 'block', sid: 200, conditions: [], actions: [] },
    ] as Record<string, unknown>[];

    const [result, ...rest] = findEventsBySid(events, 200);
    expect(rest).toHaveLength(0);
    expect(result.event.sid).toBe(200);
    expect(result.index).toBe(1);
    expect(result.parentArray).toBe(events);
    expect(result.path).toBe('events[1]');
    expect(result.depth).toBe(0);
  });

  it('finds a deeply nested block inside a group', () => {
    const nestedBlock = { eventType: 'block', sid: 999, conditions: [], actions: [] };
    const events = [
      {
        eventType: 'group', sid: 100, title: 'Outer', children: [
          {
            eventType: 'group', sid: 200, title: 'Inner', children: [
              nestedBlock,
            ],
          },
        ],
      },
    ] as Record<string, unknown>[];

    const [result] = findEventsBySid(events, 999);
    expect(result.event).toBe(nestedBlock);
    expect(result.index).toBe(0);
    expect(result.path).toBe('events[0].children[0].children[0]');
    expect(result.depth).toBe(2);
  });

  it('returns no match for a nonexistent SID', () => {
    const events = [
      { eventType: 'block', sid: 100, conditions: [], actions: [] },
    ] as Record<string, unknown>[];

    expect(findEventsBySid(events, 999)).toEqual([]);
  });

  it('returns parentArray and index for safe splicing', () => {
    const innerChildren = [
      { eventType: 'block', sid: 10, conditions: [], actions: [] },
      { eventType: 'block', sid: 20, conditions: [], actions: [] },
      { eventType: 'block', sid: 30, conditions: [], actions: [] },
    ] as Record<string, unknown>[];
    const events = [
      { eventType: 'group', sid: 1, title: 'G', children: innerChildren },
    ] as Record<string, unknown>[];

    const [result] = findEventsBySid(events, 20);
    expect(result.parentArray).toBe(innerChildren);
    expect(result.index).toBe(1);

    // Test that splicing works correctly
    result.parentArray.splice(result.index, 1);
    expect(innerChildren).toHaveLength(2);
    expect(innerChildren[0].sid).toBe(10);
    expect(innerChildren[1].sid).toBe(30);
  });

  it('finds variable events by SID', () => {
    const events = [
      { eventType: 'variable', sid: 500, name: 'score', type: 'number' },
    ] as Record<string, unknown>[];

    const [result] = findEventsBySid(events, 500);
    expect(result.event.eventType).toBe('variable');
  });

  it('finds function-block events by SID', () => {
    const events = [
      { eventType: 'function-block', sid: 600, functionName: 'DoStuff', conditions: [], actions: [] },
    ] as Record<string, unknown>[];

    const [result] = findEventsBySid(events, 600);
    expect(result.event.functionName).toBe('DoStuff');
  });
});

// ─── Duplicate event SIDs (issue #30) ───────────────────────

const DUP_SID = 400000000000099;

const cond = (sid: number, value: string) => ({
  id: 'compare-instance-variable', objectClass: 'Player', sid,
  parameters: { 'instance-variable': 'health', comparison: 0, value },
});
const act = (sid: number, x: string) => ({
  id: 'set-x', objectClass: 'Player', sid, parameters: { x },
});

/** Three events share DUP_SID: nested under a block in a group, top level, and in a later group. */
function duplicateSidSheet(): Record<string, unknown>[] {
  return [
    {
      eventType: 'group', sid: 10, title: 'Movement', children: [
        {
          eventType: 'block', sid: 11, conditions: [cond(111, '1')], actions: [], children: [
            { eventType: 'block', sid: DUP_SID, conditions: [cond(112, '2')], actions: [act(113, '10')] },
          ],
        },
      ],
    },
    { eventType: 'block', sid: DUP_SID, conditions: [cond(121, '3')], actions: [act(122, '20')], disabled: true },
    {
      eventType: 'group', sid: 20, title: 'Combat', children: [
        { eventType: 'block', sid: DUP_SID, conditions: [cond(131, '4'), cond(132, '5')], actions: [act(133, '30')] },
      ],
    },
  ];
}

describe('findEventsBySid with duplicate SIDs', () => {
  it('returns every match in document order with its path and depth', () => {
    const events = duplicateSidSheet();
    const matches = findEventsBySid(events, DUP_SID);
    expect(matches.map(m => m.path)).toEqual([
      'events[0].children[0].children[0]',
      'events[1]',
      'events[2].children[0]',
    ]);
    expect(matches.map(m => m.depth)).toEqual([2, 0, 1]);
    expect(matches[1].event).toBe(events[1]);
    expect(matches[1].parentArray).toBe(events);
  });

  it('uses the same paths as the event outline (and so locate_event)', () => {
    const events = duplicateSidSheet();
    const outlinePaths = buildEventOutline('Sheet1', events).nodes.filter(n => n.sid === DUP_SID).map(n => n.path);
    expect(findEventsBySid(events, DUP_SID).map(m => m.path)).toEqual(outlinePaths);
  });
});

describe('collectEventSids', () => {
  it('collects the SIDs of the events and all their sub-events, not of conditions or actions', () => {
    const sids = collectEventSids(duplicateSidSheet());
    expect([...sids].sort((a, b) => a - b)).toEqual([10, 11, 20, DUP_SID]);
  });
});

describe('eventSidsMatchingSeveral', () => {
  it('returns the paths of each listed SID that more than one event has, in document order', () => {
    const events = duplicateSidSheet();
    const shared = eventSidsMatchingSeveral(events, new Set([DUP_SID, 10, 999]));
    expect([...shared.keys()]).toEqual([DUP_SID]);
    expect(shared.get(DUP_SID)).toEqual(findEventsBySid(events, DUP_SID).map(m => m.path));
  });

  it('ignores SIDs that are not listed, even when several events have them', () => {
    expect(eventSidsMatchingSeveral(duplicateSidSheet(), new Set([10, 20])).size).toBe(0);
  });
});

describe('parseEventPath', () => {
  it('parses top-level and nested event paths', () => {
    expect(parseEventPath('events[3]')).toEqual([3]);
    expect(parseEventPath('events[3].children[1].children[0]')).toEqual([3, 1, 0]);
    expect(parseEventPath(' events[3] .children[1] ')).toEqual([3, 1]);
  });

  it('rejects anything that is not an event path', () => {
    for (const path of ['', 'events', 'events[-1]', 'events[a]', 'children[1]', 'events[3]children[1]',
      'events[3].actions[0]', 'events[3].children[1].conditions[0]', 'events[1][2]']) {
      expect(parseEventPath(path), path).toBeNull();
    }
  });
});

describe('resolveEventBySid', () => {
  const options = { sheetName: 'Sheet1', action: 'update' };

  it('resolves a unique SID without eventPath', () => {
    const events = duplicateSidSheet();
    const result = resolveEventBySid(events, 11, options);
    expect('match' in result && result.match.path).toBe('events[0].children[0]');
  });

  it('refuses a SID shared by several events and lists every candidate', () => {
    const result = resolveEventBySid(duplicateSidSheet(), DUP_SID, options);
    expect('error' in result).toBe(true);
    const error = (result as { error: string }).error;
    expect(error).toContain(`SID ${DUP_SID} matches 3 events in sheet "Sheet1"; refusing to guess which one to update.`);
    const lines = error.split('\n');
    // Path, editor event number, enclosing group / parent event, one-line summary
    expect(lines[1]).toBe(
      '  - eventPath "events[0].children[0].children[0]": event 3, in group "Movement", sub-event of event 2: ' +
      'IF Player.compare-instance-variable(instance-variable=health, comparison=0, value=2) => DO Player.set-x(x=10)',
    );
    expect(lines[2]).toBe(
      '  - eventPath "events[1]": event 4, top level: ' +
      'IF Player.compare-instance-variable(instance-variable=health, comparison=0, value=3) [disabled] => DO Player.set-x(x=20)',
    );
    expect(lines[3]).toContain('  - eventPath "events[2].children[0]": event 6, in group "Combat": IF ');
    expect(error).toContain('eventPath');
    expect(error).toContain('locate_event');
  });

  it('picks one candidate with eventPath', () => {
    const events = duplicateSidSheet();
    const result = resolveEventBySid(events, DUP_SID, { ...options, eventPath: 'events[2].children[0]' });
    expect('match' in result).toBe(true);
    const { match } = result as { match: ReturnType<typeof findEventsBySid>[number] };
    expect(match.event).toBe((events[2].children as unknown[])[0]);
    expect(match.index).toBe(0);
  });

  it('refuses an eventPath that points at another event or nowhere', () => {
    const wrong = resolveEventBySid(duplicateSidSheet(), DUP_SID, { ...options, eventPath: 'events[0]' });
    expect((wrong as { error: string }).error).toContain('does not point at an event with SID');
    expect((wrong as { error: string }).error).toContain('it points at a group with SID 10');
    expect((wrong as { error: string }).error).toContain('events[2].children[0]');

    const nowhere = resolveEventBySid(duplicateSidSheet(), DUP_SID, { ...options, eventPath: 'events[9].children[0]' });
    expect((nowhere as { error: string }).error).toContain('no event exists at that path');
  });

  it('refuses a malformed eventPath', () => {
    const result = resolveEventBySid(duplicateSidSheet(), DUP_SID, { ...options, eventPath: 'events[1].actions[0]' });
    expect((result as { error: string }).error).toContain('is not an event path');
  });

  it('validates eventPath against a unique SID too', () => {
    const events = duplicateSidSheet();
    expect('match' in resolveEventBySid(events, 11, { ...options, eventPath: 'events[0].children[0]' })).toBe(true);
    const wrong = resolveEventBySid(events, 11, { ...options, eventPath: 'events[1]' });
    expect((wrong as { error: string }).error).toContain(`it points at a block with SID ${DUP_SID}`);
    expect((wrong as { error: string }).error).toContain('The event with this SID is:');
  });

  it('reports a SID that matches nothing as not found', () => {
    const result = resolveEventBySid(duplicateSidSheet(), 999, { ...options, eventPath: 'events[1]' });
    expect((result as { error: string }).error).toContain('Event with SID 999 not found in sheet "Sheet1"');
  });

  it('names the enclosing function or custom action of a candidate', () => {
    const events = [
      {
        eventType: 'function-block', sid: 30, functionName: 'Respawn', functionParameters: [], conditions: [], actions: [],
        children: [{ eventType: 'block', sid: DUP_SID, conditions: [cond(141, '1')], actions: [] }],
      },
      {
        eventType: 'custom-ace-block', sid: 40, aceType: 'action', objectClass: 'Enemy', aceName: 'Stun', conditions: [], actions: [],
        children: [{ eventType: 'block', sid: DUP_SID, conditions: [cond(151, '1')], actions: [] }],
      },
    ];
    const error = (resolveEventBySid(events, DUP_SID, options) as { error: string }).error;
    expect(error).toContain('"events[0].children[0]": event 2, in function "Respawn": IF');
    expect(error).toContain('"events[1].children[0]": event 4, in custom action Enemy.Stun: IF');
  });
});

describe('countDescendants', () => {
  it('returns 0 for events with no children', () => {
    const event = { eventType: 'block', sid: 1 } as Record<string, unknown>;
    expect(countDescendants(event)).toBe(0);
  });

  it('returns 0 for empty children array', () => {
    const event = { eventType: 'group', sid: 1, children: [] } as Record<string, unknown>;
    expect(countDescendants(event)).toBe(0);
  });

  it('counts direct children', () => {
    const event = {
      eventType: 'group', sid: 1, children: [
        { eventType: 'block', sid: 10 },
        { eventType: 'block', sid: 20 },
      ],
    } as Record<string, unknown>;
    expect(countDescendants(event)).toBe(2);
  });

  it('counts deeply nested children', () => {
    const event = {
      eventType: 'group', sid: 1, children: [
        {
          eventType: 'group', sid: 10, children: [
            { eventType: 'block', sid: 100 },
            { eventType: 'block', sid: 101 },
          ],
        },
        { eventType: 'block', sid: 20 },
      ],
    } as Record<string, unknown>;
    // 3 direct + nested: group(10) + block(100) + block(101) + block(20) = 4
    expect(countDescendants(event)).toBe(4);
  });
});

describe('summarizeEvents', () => {
  it('summarizes blocks with SIDs', () => {
    const events = [
      { eventType: 'block', sid: 100, conditions: [1, 2], actions: [1] },
    ] as Record<string, unknown>[];
    const summary = summarizeEvents(events);
    expect(summary).toContain('block');
    expect(summary).toContain('SID 100');
    expect(summary).toContain('2 condition(s)');
  });

  it('summarizes groups', () => {
    const events = [
      { eventType: 'group', sid: 50, title: 'Movement', children: [1, 2, 3] },
    ] as Record<string, unknown>[];
    const summary = summarizeEvents(events);
    expect(summary).toContain('group "Movement"');
    expect(summary).toContain('3 children');
  });

  it('truncates long lists', () => {
    const events = Array.from({ length: 15 }, (_, i) => ({
      eventType: 'block', sid: i, conditions: [], actions: [],
    })) as Record<string, unknown>[];
    const summary = summarizeEvents(events, 5);
    expect(summary).toContain('10 more');
  });
});
