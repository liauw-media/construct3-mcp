import { describe, it, expect } from 'vitest';
import { scanLegacyEventShapes, describeLegacyEventShapeHit } from '../../src/construct3/analyzers/legacy-event-shapes.js';
import { collectFunctionSignatures } from '../../src/construct3/event-shapes.js';
import type { C3Event } from '../../src/construct3/types.js';

const cond = (id: string, sid: number, extra: Record<string, unknown> = {}) => ({ id, objectClass: 'System', sid, ...extra });
const block = (sid: number, conditions: unknown[] = [], extra: Record<string, unknown> = {}) =>
  ({ eventType: 'block', sid, conditions, actions: [], ...extra });

const fn1 = {
  eventType: 'function-block', functionName: 'fn1', sid: 900, conditions: [], actions: [],
  functionParameters: [
    { name: 'p1', type: 'number', initialValue: '0', comment: '', sid: 901 },
    { name: 'p2', type: 'boolean', initialValue: 'false', comment: '', sid: 902 },
  ],
};

let nextSid = 5000;
const newSid = async () => nextSid++;

describe('scanLegacyEventShapes: isElse', () => {
  it('puts a System else condition first on a condition-less block after a block', async () => {
    const events = [block(1, [cond('x', 2)]), block(3, [], { isElse: true })] as unknown as C3Event[];
    const dry = await scanLegacyEventShapes(events);
    expect(dry.fixable).toHaveLength(1);
    expect(dry.fixable[0]).toMatchObject({ kind: 'isElse', path: 'events[1]', sid: 3 });
    expect(events[1]).toHaveProperty('isElse');

    nextSid = 5000;
    const applied = await scanLegacyEventShapes(events, { apply: true, newSid });
    expect(applied.fixable).toHaveLength(1);
    expect(events[1]).not.toHaveProperty('isElse');
    expect((events[1] as any).conditions).toEqual([{ id: 'else', objectClass: 'System', sid: 5000 }]);
  });

  it('reports an isElse block with no block before it, not counting comments', async () => {
    const events = [
      block(3, [], { isElse: true }),
      { eventType: 'group', sid: 4, title: 'G', children: [{ eventType: 'comment', text: 'c' }, block(5, [], { isElse: true })] },
      { eventType: 'variable', name: 'v', sid: 6 },
      { eventType: 'comment', text: 'c' },
      block(7, [], { isElse: true }),
    ] as unknown as C3Event[];
    const scan = await scanLegacyEventShapes(events, { apply: true, newSid });
    expect(scan.fixable).toHaveLength(0);
    expect(scan.manual.map(h => h.path)).toEqual(['events[0]', 'events[4]', 'events[1].children[1]']);
    expect(scan.manual[0].detail).toContain('no event comes before it');
    expect(scan.manual[1].detail).toContain('the event before it is a variable');
    expect(scan.manual[2].detail).toContain('no event comes before it (comments aside)');
    expect(events[0]).toHaveProperty('isElse', true);
  });

  it('converts an isElse block that a comment separates from its block', async () => {
    const events = [
      block(1, [cond('x', 2)]),
      { eventType: 'comment', text: 'c' },
      block(3, [], { isElse: true }),
    ] as unknown as C3Event[];
    nextSid = 5000;
    const scan = await scanLegacyEventShapes(events, { apply: true, newSid });
    expect(scan.manual).toEqual([]);
    expect(scan.fixable.map(h => [h.kind, h.path])).toEqual([['isElse', 'events[2]']]);
    expect(events[2]).not.toHaveProperty('isElse');
    expect((events[2] as any).conditions).toEqual([{ id: 'else', objectClass: 'System', sid: 5000 }]);

    // A comment does not hide a trigger on the block before it
    const triggered = [
      block(1, [cond('on-start-of-layout', 2)]),
      { eventType: 'comment', text: 'c' },
      block(3, [], { isElse: true }),
    ] as unknown as C3Event[];
    const refused = await scanLegacyEventShapes(triggered, { apply: true, newSid });
    expect(refused.manual[0].detail).toContain('triggered by "on-start-of-layout"');
  });

  it('reports an isElse block right after a triggered block (Else only follows non-triggered events)', async () => {
    const events = [
      block(1, [cond('on-start-of-layout', 2)]),
      block(3, [], { isElse: true }),
      block(4, [cond('every-tick', 5)], { isOrBlock: true }),
      block(6, [], { isElse: true }),
    ] as unknown as C3Event[];
    (events[2] as any).conditions.push(cond('on-layout-end', 7));
    const scan = await scanLegacyEventShapes(events, { apply: true, newSid });
    expect(scan.fixable).toHaveLength(0);
    expect(scan.manual.map(h => h.path)).toEqual(['events[1]', 'events[3]']);
    expect(scan.manual[0].detail).toContain('triggered by "on-start-of-layout"');
    expect(scan.manual[1].detail).toContain('triggered by "on-layout-end"');
    expect(events[1]).toHaveProperty('isElse', true);
    expect((events[1] as any).conditions).toEqual([]);
  });

  it('says that converting isElse can change what the event does', async () => {
    const events = [block(1, [cond('x', 2)]), block(3, [], { isElse: true }), block(4, [cond('else', 5)], { isElse: true })] as unknown as C3Event[];
    const scan = await scanLegacyEventShapes(events);
    const [convert, dropOnly] = scan.fixable;
    expect(convert.changesBehavior).toBe(true);
    expect(convert.detail).toMatch(/ran like an ordinary block/);
    expect(convert.detail).toMatch(/Test the event in the game/);
    expect(dropOnly.changesBehavior).toBeUndefined();
  });

  it('reports an isElse block with conditions (else-if or ordinary block is a decision)', async () => {
    const events = [block(1, [cond('x', 2)]), block(3, [cond('y', 4)], { isElse: true })] as unknown as C3Event[];
    const scan = await scanLegacyEventShapes(events, { apply: true, newSid });
    expect(scan.manual).toHaveLength(1);
    expect(scan.manual[0].detail).toContain('else-if');
    expect((events[1] as any).conditions).toHaveLength(1);
  });

  it('drops isElse where it has no effect', async () => {
    const events = [
      block(1, [cond('x', 2)]),
      block(3, [cond('else', 4)], { isElse: true }),
      block(5, [cond('z', 6)], { isElse: false }),
    ] as unknown as C3Event[];
    const scan = await scanLegacyEventShapes(events, { apply: true, newSid });
    expect(scan.fixable).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain('isElse');
    expect((events[1] as any).conditions).toHaveLength(1);
  });
});

describe('scanLegacyEventShapes: isOr', () => {
  it('turns isOr on every later condition into isOrBlock', async () => {
    const events = [block(1, [cond('a', 2), cond('b', 3, { isOr: true }), cond('c', 4, { isOr: true })])] as unknown as C3Event[];
    const scan = await scanLegacyEventShapes(events, { apply: true, newSid });
    expect(scan.fixable).toHaveLength(1);
    expect((events[0] as any).isOrBlock).toBe(true);
    expect(JSON.stringify(events)).not.toContain('"isOr"');
  });

  it('drops isOr that never had an effect, keeping an AND block', async () => {
    const events = [
      block(1, [cond('a', 2, { isOr: true }), cond('b', 3)]),
      block(4, [cond('a', 5), cond('b', 6, { isOr: false })]),
      block(7, [cond('a', 8), cond('b', 9, { isOr: true })], { isOrBlock: true }),
    ] as unknown as C3Event[];
    const scan = await scanLegacyEventShapes(events, { apply: true, newSid });
    expect(scan.fixable).toHaveLength(3);
    expect(events[0]).not.toHaveProperty('isOrBlock');
    expect(events[1]).not.toHaveProperty('isOrBlock');
    expect(JSON.stringify(events)).not.toContain('"isOr"');
  });

  it('says that converting isOr can change what the event does, but dropping a dead key cannot', async () => {
    const events = [
      block(1, [cond('a', 2), cond('b', 3, { isOr: true })]),
      block(4, [cond('a', 5, { isOr: true }), cond('b', 6)]),
    ] as unknown as C3Event[];
    const scan = await scanLegacyEventShapes(events);
    expect(scan.fixable[0].changesBehavior).toBe(true);
    expect(scan.fixable[0].detail).toMatch(/AND-combined until now/);
    expect(scan.fixable[1].changesBehavior).toBeUndefined();
  });

  it('reports isOr on only some later conditions', async () => {
    const events = [block(1, [cond('a', 2), cond('b', 3), cond('c', 4, { isOr: true })])] as unknown as C3Event[];
    const scan = await scanLegacyEventShapes(events, { apply: true, newSid });
    expect(scan.manual).toHaveLength(1);
    expect(scan.manual[0].detail).toContain('isOrBlock: true');
    expect(JSON.stringify(events)).toContain('"isOr"');
  });
});

describe('scanLegacyEventShapes: function calls', () => {
  const sheet = (actions: unknown[]) => [fn1, { ...block(1), actions }] as unknown as C3Event[];

  it('rewrites calls with id/objectClass and keyed parameters into the editor shape', async () => {
    const events = sheet([
      { id: 'call-function', objectClass: 'System', sid: 10, parameters: { 0: '1', 1: true }, callFunction: 'fn1' },
      { id: 'call-function', objectClass: 'System', sid: 11, disabled: true, parameters: { p2: false, p1: '2' }, callFunction: 'fn1' },
      { callFunction: 'fn1', sid: 12, parameters: ['3', true] },
    ]);
    const functions = collectFunctionSignatures([{ events }]);
    const scan = await scanLegacyEventShapes(events, { apply: true, newSid, functions });
    expect(scan.fixable.map(h => h.path)).toEqual(['events[1].actions[0]', 'events[1].actions[1]']);
    const actions = (events[1] as any).actions;
    expect(actions[0]).toEqual({ callFunction: 'fn1', sid: 10, parameters: ['1', true] });
    expect(Object.keys(actions[1])).toEqual(['callFunction', 'sid', 'disabled', 'parameters']);
    expect(actions[1].parameters).toEqual(['2', false]);
    expect(actions[2]).toEqual({ callFunction: 'fn1', sid: 12, parameters: ['3', true] });
  });

  it('reports calls whose keyed parameters cannot be mapped', async () => {
    const events = sheet([
      { id: 'call-function', objectClass: 'System', sid: 10, parameters: { other: '1' }, callFunction: 'fn1' },
      { id: 'call-function', objectClass: 'System', sid: 11, parameters: { 0: '1', 2: '2' }, callFunction: 'fn1' },
    ]);
    const functions = collectFunctionSignatures([{ events }]);
    const scan = await scanLegacyEventShapes(events, { apply: true, newSid, functions });
    expect(scan.fixable).toHaveLength(0);
    expect(scan.manual).toHaveLength(2);
    expect(describeLegacyEventShapeHit(scan.manual[0])).toBe('function call in the old shape at events[1].actions[0] (SID 10)');
    expect((events[1] as any).actions[0]).toHaveProperty('id');
  });
});

describe('scanLegacyEventShapes: scripts', () => {
  it('turns one-string scripts without language (as 1.8.1 wrote them) into lines with language', async () => {
    const events = [
      {
        ...block(1),
        actions: [
          { type: 'script', script: 'a();\r\nb();\n' },
          { type: 'script', script: 'c();', disabled: true },
          { type: 'script', script: ['d();'] },
          { type: 'script', language: 'javascript', script: 'e();\nf();' },
        ],
      },
      { eventType: 'script', script: 'g();' },
    ] as unknown as C3Event[];
    const dry = await scanLegacyEventShapes(events);
    expect(dry.fixable.map(h => [h.kind, h.path])).toEqual([
      ['script', 'events[0].actions[0]'],
      ['script', 'events[0].actions[1]'],
      ['script', 'events[0].actions[2]'],
      ['script', 'events[0].actions[3]'],
      ['script', 'events[1]'],
    ]);
    expect(dry.fixable[0].detail).toBe('store the code as a list of lines and add language "javascript", as Construct 3 saves scripts');
    expect(dry.fixable[2].detail).toBe('add language "javascript", as Construct 3 saves scripts');
    expect(dry.fixable.every(h => !h.changesBehavior)).toBe(true);
    expect(describeLegacyEventShapeHit(dry.fixable[0])).toBe('script in the old shape at events[0].actions[0]');

    await scanLegacyEventShapes(events, { apply: true, newSid });
    const actions = (events[0] as any).actions;
    expect(actions[0]).toEqual({ type: 'script', language: 'javascript', script: ['a();', 'b();', ''] });
    expect(Object.keys(actions[1])).toEqual(['type', 'language', 'script', 'disabled']);
    expect(actions[1].script).toEqual(['c();']);
    expect(actions[2]).toEqual({ type: 'script', language: 'javascript', script: ['d();'] });
    expect(actions[3]).toEqual({ type: 'script', language: 'javascript', script: ['e();', 'f();'] });
    expect(events[1]).toEqual({ eventType: 'script', language: 'javascript', script: ['g();'] });
    expect(Object.keys(events[1])).toEqual(['eventType', 'language', 'script']);
    expect(await scanLegacyEventShapes(events)).toEqual({ fixable: [], manual: [], truncated: false });
  });

  it('reports a script that is neither text nor lines', async () => {
    const events = [{ ...block(1), actions: [{ type: 'script', script: { code: 'x' } }] }] as unknown as C3Event[];
    const scan = await scanLegacyEventShapes(events, { apply: true, newSid });
    expect(scan.fixable).toHaveLength(0);
    expect(scan.manual).toHaveLength(1);
    expect((events[0] as any).actions[0]).toEqual({ type: 'script', script: { code: 'x' } });
  });
});

describe('scanLegacyEventShapes: editor-saved shapes', () => {
  it('finds nothing in the shapes Construct 3 writes', async () => {
    const events = [
      fn1,
      block(1, [cond('a', 2)], { children: [block(3, [cond('else', 4)]), block(5, [])] }),
      block(6, [cond('a', 7), cond('b', 8)], { isOrBlock: true }),
      { ...block(9), actions: [{ callFunction: 'fn1', sid: 10, parameters: ['1', true] }, { type: 'script', language: 'javascript', script: ['x();'] }] },
      { ...block(11), actions: [{ type: 'script', language: 'javascript', script: ['y();'], disabled: true }, { type: 'comment', text: 'c' }] },
      { eventType: 'script', language: 'javascript', script: ['z();'], disabled: true },
    ] as unknown as C3Event[];
    const scan = await scanLegacyEventShapes(events, { functions: collectFunctionSignatures([{ events }]) });
    expect(scan).toEqual({ fixable: [], manual: [], truncated: false });
  });
});
