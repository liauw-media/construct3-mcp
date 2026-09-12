import { describe, it, expect } from 'vitest';
import {
  findGroupByPath,
  validateObjectClasses,
  collectObjectRefs,
  buildBlockEvent,
  findEventBySid,
  countDescendants,
  summarizeEvents,
  MAX_NESTING_DEPTH,
  MAX_TOTAL_EVENTS,
} from '../../src/tools/event-helpers.js';
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

  it('warns about behavior-type usage', async () => {
    const reader = new MockReader({
      objects: new Map([['Player', { name: 'Player', 'plugin-id': 'Sprite', sid: 1 }]]),
    });
    const { errors, warnings } = await validateObjectClasses(
      reader as any,
      [{ objectClass: 'Player', 'behavior-type': 'Platform' }],
    );
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Behavior-type "Platform"');
  });
});

describe('collectObjectRefs', () => {
  it('collects refs from conditions and actions', () => {
    const refs: Array<{ objectClass: string; 'behavior-type'?: string }> = [];
    collectObjectRefs(
      [{ objectClass: 'Player', 'behavior-type': 'Platform' }],
      [{ objectClass: 'Enemy', id: 'destroy', sid: 1 }],
      [],
      refs,
    );
    expect(refs).toHaveLength(2);
    expect(refs[0].objectClass).toBe('Player');
    expect(refs[1].objectClass).toBe('Enemy');
  });

  it('collects refs from nested children', () => {
    const refs: Array<{ objectClass: string; 'behavior-type'?: string }> = [];
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

    expect(block.isElse).toBe(true);
  });

  it('builds script actions in C3 canonical shape (language tag + line array)', async () => {
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
    const scriptAct = block.actions[0] as any;
    expect(scriptAct.type).toBe('script');
    expect(scriptAct.language).toBe('javascript');
    expect(scriptAct.script).toEqual(['console.log("hi")']);
  });

  it('splits multi-line script strings into lines', async () => {
    const reader = new MockReader();
    const idGen = new MockIdGenerator();
    const counter = { count: 0, warnings: [] };

    const block = await buildBlockEvent(
      reader as any,
      idGen as any,
      {
        conditions: [{ id: 'on-start-of-layout', objectClass: 'System' }],
        actions: [{ type: 'script' as const, script: 'const a = 1;\r\nif (a) {\n  doIt();\n}' }],
        children: [],
      },
      1,
      counter,
    );

    expect((block.actions[0] as any).script).toEqual(['const a = 1;', 'if (a) {', '  doIt();', '}']);
  });

  it('passes script line arrays through unchanged', async () => {
    const reader = new MockReader();
    const idGen = new MockIdGenerator();
    const counter = { count: 0, warnings: [] };

    const lines = ['if (x) {', '  y();', '}'];
    const block = await buildBlockEvent(
      reader as any,
      idGen as any,
      {
        conditions: [{ id: 'on-start-of-layout', objectClass: 'System' }],
        actions: [{ type: 'script' as const, script: lines }],
        children: [],
      },
      1,
      counter,
    );

    expect((block.actions[0] as any).script).toEqual(lines);
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

  it('rejects non-else block without conditions', async () => {
    const reader = new MockReader();
    const idGen = new MockIdGenerator();
    const counter = { count: 0, warnings: [] };

    await expect(
      buildBlockEvent(
        reader as any,
        idGen as any,
        {
          conditions: [],
          actions: [],
          children: [],
        },
        1,
        counter,
      ),
    ).rejects.toThrow('no conditions');
  });

  it('warns about else block with conditions', async () => {
    const reader = new MockReader();
    const idGen = new MockIdGenerator();
    const counter = { count: 0, warnings: [] };

    await buildBlockEvent(
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

    expect(counter.warnings.some(w => w.includes('Else block'))).toBe(true);
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

  it('sets isInverted and isOr on conditions', async () => {
    const reader = new MockReader();
    const idGen = new MockIdGenerator();
    const counter = { count: 0, warnings: [] };

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
    expect(block.conditions[1].isOr).toBe(true);
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
});

describe('findEventBySid', () => {
  it('finds a top-level block by SID', () => {
    const events = [
      { eventType: 'block', sid: 100, conditions: [], actions: [] },
      { eventType: 'block', sid: 200, conditions: [], actions: [] },
    ] as Record<string, unknown>[];

    const result = findEventBySid(events, 200);
    expect(result).not.toBeNull();
    expect(result!.event.sid).toBe(200);
    expect(result!.index).toBe(1);
    expect(result!.parentArray).toBe(events);
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

    const result = findEventBySid(events, 999);
    expect(result).not.toBeNull();
    expect(result!.event).toBe(nestedBlock);
    expect(result!.index).toBe(0);
  });

  it('returns null for nonexistent SID', () => {
    const events = [
      { eventType: 'block', sid: 100, conditions: [], actions: [] },
    ] as Record<string, unknown>[];

    expect(findEventBySid(events, 999)).toBeNull();
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

    const result = findEventBySid(events, 20);
    expect(result).not.toBeNull();
    expect(result!.parentArray).toBe(innerChildren);
    expect(result!.index).toBe(1);

    // Test that splicing works correctly
    result!.parentArray.splice(result!.index, 1);
    expect(innerChildren).toHaveLength(2);
    expect(innerChildren[0].sid).toBe(10);
    expect(innerChildren[1].sid).toBe(30);
  });

  it('finds variable events by SID', () => {
    const events = [
      { eventType: 'variable', sid: 500, name: 'score', type: 'number' },
    ] as Record<string, unknown>[];

    const result = findEventBySid(events, 500);
    expect(result).not.toBeNull();
    expect(result!.event.eventType).toBe('variable');
  });

  it('finds function-block events by SID', () => {
    const events = [
      { eventType: 'function-block', sid: 600, functionName: 'DoStuff', conditions: [], actions: [] },
    ] as Record<string, unknown>[];

    const result = findEventBySid(events, 600);
    expect(result).not.toBeNull();
    expect(result!.event.functionName).toBe('DoStuff');
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
