import { describe, it, expect } from 'vitest';
import {
  findGroupByPath,
  validateObjectClasses,
  collectObjectRefs,
  buildBlockEvent,
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
