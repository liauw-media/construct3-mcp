/**
 * Sub-events that are not blocks, and keys the event input does not know.
 * add_event_block writes comment and script sub-events in the editor's shapes
 * and refuses every other sub-event type and every unknown key, instead of
 * writing an empty block or dropping the key (follow-up to #32).
 * All data is synthetic.
 */

import { describe, it, expect } from 'vitest';
import { MockServer } from '../mocks/mock-server.js';
import { MockReader } from '../mocks/mock-reader.js';
import { MockWriter } from '../mocks/mock-writer.js';
import { MockIdGenerator } from '../mocks/mock-id-generator.js';
import { registerEventTools } from '../../src/tools/event-tools.js';
import {
  buildBlockEvent,
  childEventSchema,
  collectObjectRefs,
  MAX_TOTAL_EVENTS,
} from '../../src/tools/event-helpers.js';
import type { ChildEventInput, ObjectRef } from '../../src/tools/event-helpers.js';

function setup(events: unknown[] = []) {
  const server = new MockServer();
  const reader = new MockReader({
    objects: new Map([
      ['Sprite1', { name: 'Sprite1', 'plugin-id': 'Sprite', sid: 1, behaviorTypes: [{ behaviorId: 'Flash', name: 'Flash', sid: 2 }] }],
      ['Player', { name: 'Player', 'plugin-id': 'Sprite', sid: 3 }],
    ]),
    eventSheets: new Map([['Sheet1', { name: 'Sheet1', sid: 10, events }]]),
  });
  const writer = new MockWriter();
  const idGen = new MockIdGenerator();
  registerEventTools({ server, reader, writer, idGen } as any);
  return { server, reader, writer, idGen };
}

const parseResult = (result: any) => JSON.parse(result.content[0].text);
const writtenEvents = (writer: MockWriter) => (writer.callsFor('writeEntityFile').at(-1)!.args[2] as any).events;

/** A copy without SIDs, keys in their order (for comparing a written event with its input). */
function withoutSids(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSids);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'sid').map(([k, v]) => [k, withoutSids(v)]));
}

const onStart = { id: 'on-start-of-layout', objectClass: 'System' };
const isVisible = { id: 'is-visible', objectClass: 'Sprite1' };
const setVisible = { id: 'set-visible', objectClass: 'Sprite1', parameters: { visibility: 'visible' } };

describe('add_event_block comment and script sub-events', () => {
  it('writes a comment sub-event as the editor saves it', async () => {
    const { server, writer } = setup();
    const data = parseResult(await server.callTool('add_event_block', {
      sheetName: 'Sheet1', conditions: [onStart],
      children: [{ eventType: 'comment', text: 'Explains the next sub-event' }, { conditions: [isVisible], actions: [setVisible] }],
    }));
    expect(data.success).toBe(true);
    expect(data.warnings).toBeUndefined();
    const [comment, block] = writtenEvents(writer)[0].children;
    expect(comment).toEqual({ eventType: 'comment', text: 'Explains the next sub-event' });
    expect(Object.keys(comment)).toEqual(['eventType', 'text']);
    expect(block.eventType).toBe('block');
    expect(block.conditions[0].id).toBe('is-visible');
  });

  it('writes the colours of a comment sub-event in the editor\'s key order', async () => {
    const { server, writer } = setup();
    await server.callTool('add_event_block', {
      sheetName: 'Sheet1', conditions: [onStart],
      children: [{ eventType: 'comment', 'background-color': [0, 0, 1, 1], text: 'Note', 'text-color': [1, 0.5, 0, 1] }],
    });
    const comment = writtenEvents(writer)[0].children[0];
    expect(Object.keys(comment)).toEqual(['eventType', 'text', 'text-color', 'background-color']);
    expect(comment['text-color']).toEqual([1, 0.5, 0, 1]);
    expect(comment['background-color']).toEqual([0, 0, 1, 1]);
  });

  it('writes a script sub-event as the editor saves it: language, script lines, disabled last', async () => {
    const { server, writer } = setup();
    const data = parseResult(await server.callTool('add_event_block', {
      sheetName: 'Sheet1', conditions: [onStart],
      children: [
        { eventType: 'script', script: ['const a = 1;', 'runtime.globalVars.Total = a;'] },
        { eventType: 'script', language: 'javascript', script: 'first();\nsecond();', disabled: true },
      ],
    }));
    expect(data.success).toBe(true);
    const [lines, split] = writtenEvents(writer)[0].children;
    expect(lines).toEqual({ eventType: 'script', language: 'javascript', script: ['const a = 1;', 'runtime.globalVars.Total = a;'] });
    expect(split).toEqual({ eventType: 'script', language: 'javascript', script: ['first();', 'second();'], disabled: true });
    expect(Object.keys(split)).toEqual(['eventType', 'language', 'script', 'disabled']);
  });

  it('writes comment and script sub-events at any depth', async () => {
    const { server, writer } = setup();
    await server.callTool('add_event_block', {
      sheetName: 'Sheet1', conditions: [onStart],
      children: [{ children: [{ conditions: [isVisible], children: [{ eventType: 'comment', text: 'deep' }, { eventType: 'script', script: ['x();'] }] }] }],
    });
    const deepest = writtenEvents(writer)[0].children[0].children[0].children;
    expect(deepest).toEqual([
      { eventType: 'comment', text: 'deep' },
      { eventType: 'script', language: 'javascript', script: ['x();'] },
    ]);
  });

  it('lets a comment sub-event stand between a block and its else block', async () => {
    const { server, writer } = setup();
    const data = parseResult(await server.callTool('add_event_block', {
      sheetName: 'Sheet1', conditions: [onStart],
      children: [
        { conditions: [isVisible], actions: [setVisible] },
        { eventType: 'comment', text: 'otherwise' },
        { isElse: true, actions: [{ id: 'set-visible', objectClass: 'Sprite1', parameters: { visibility: 'invisible' } }] },
      ],
    }));
    expect(data.success).toBe(true);
    expect((data.warnings ?? []).filter((w: string) => w.includes('Else block'))).toEqual([]);
    const children = writtenEvents(writer)[0].children;
    expect(children.map((c: any) => c.eventType)).toEqual(['block', 'comment', 'block']);
    expect(children[2].conditions[0]).toEqual({ id: 'else', objectClass: 'System', sid: expect.any(Number) });
  });

  it('writes an editor-saved block tree given as it is, SIDs aside', async () => {
    const { server, writer } = setup();
    // A block as get_eventsheet_details shows it: eventType, SIDs, comment rows with colours,
    // a breakpoint, a function call, a script action and comment / script sub-events.
    const saved = {
      eventType: 'block',
      conditions: [{ id: 'on-start-of-layout', objectClass: 'System', sid: 501 }],
      actions: [
        { type: 'comment', text: 'Setup', 'background-color': [0.2, 0.4, 0.6, 1] },
        { id: 'set-visible', objectClass: 'Sprite1', sid: 502, disabled: true, breakpoint: true, parameters: { visibility: 'visible' } },
        { callFunction: 'Prepare', sid: 503, parameters: ['1', '"a"'] },
        { type: 'script', language: 'javascript', script: ['init();'] },
      ],
      sid: 500,
      children: [
        { eventType: 'comment', text: 'Checks' },
        {
          eventType: 'block',
          conditions: [{ id: 'is-visible', objectClass: 'Sprite1', sid: 511, isInverted: true }],
          actions: [{ id: 'flash', objectClass: 'Sprite1', sid: 512, behaviorType: 'Flash', parameters: { 'on-time': '0.1', 'off-time': '0.1', duration: '1' } }],
          sid: 510,
        },
        { eventType: 'block', conditions: [{ id: 'else', objectClass: 'System', sid: 521 }], actions: [], sid: 520, disabled: true },
        { eventType: 'script', language: 'javascript', script: ['a();', 'b();'], disabled: true },
      ],
    };
    const { eventType, conditions, actions, children } = saved;
    const data = parseResult(await server.callTool('add_event_block', { sheetName: 'Sheet1', eventType, conditions, actions, children }));
    expect(data.success).toBe(true);
    const written = writtenEvents(writer)[0];
    expect(JSON.stringify(withoutSids(written))).toBe(JSON.stringify(withoutSids(saved)));
    // Every SID is new
    const sids = JSON.stringify(written).match(/"sid":\d+/g)!;
    expect(sids.some(s => /"sid":5\d\d$/.test(s))).toBe(false);
  });
});

describe('add_event_block refuses sub-events it cannot write', () => {
  const refusals: Array<[string, Record<string, unknown>, RegExp]> = [
    ['an event variable', { eventType: 'variable', name: 'Counter', type: 'number', initialValue: '0', comment: '', isStatic: false, isConstant: false }, /An event variable cannot be added as a sub-event with add_event_block/],
    ['a group', { eventType: 'group', title: 'Inner', disabled: false, description: '', isActiveOnStart: true, children: [] }, /A group cannot be added as a sub-event/],
    ['a function block', { eventType: 'function-block', functionName: 'Helper', functionParameters: [], conditions: [], actions: [] }, /A function block cannot be added as a sub-event/],
    ['an include', { eventType: 'include', includeSheet: 'Sheet1' }, /An include cannot be added as a sub-event/],
    ['an unknown event type', { eventType: 'custom-kind', value: 1 }, /Unknown sub-event type \\"custom-kind\\"/],
    ['a comment without eventType', { text: 'Would be lost' }, /Unknown key\(s\) \\"text\\" in a block sub-event/],
    ['a script without eventType', { script: ['x();'] }, /Unknown key\(s\) \\"script\\" in a block sub-event/],
    ['a block with an unknown key', { conditions: [isVisible], note: 'x' }, /Unknown key\(s\) \\"note\\" in a block sub-event/],
    ['a comment with children', { eventType: 'comment', text: 'x', children: [] }, /Unknown key\(s\) \\"children\\" in a comment sub-event/],
    ['a comment colour that is not [r, g, b, a]', { eventType: 'comment', text: 'x', 'background-color': '#ffcc00' }, /background-color/],
    ['a comment colour out of range', { eventType: 'comment', text: 'x', 'text-color': [255, 0, 0, 1] }, /text-color/],
    ['a script with an unknown key', { eventType: 'script', script: ['x();'], title: 'y' }, /Unknown key\(s\) \\"title\\" in a script sub-event/],
    ['a script in another language', { eventType: 'script', script: ['x();'], language: 'typescript' }, /javascript/],
  ];

  for (const [label, child, message] of refusals) {
    it(`refuses ${label}, at the first level and deeper, and writes nothing`, async () => {
      const { server, writer } = setup();
      await expect(server.callTool('add_event_block', { sheetName: 'Sheet1', conditions: [onStart], children: [child] }))
        .rejects.toThrow(message);
      await expect(server.callTool('add_event_block', {
        sheetName: 'Sheet1', conditions: [onStart], children: [{ conditions: [isVisible], children: [{ children: [child] }] }],
      })).rejects.toThrow(message);
      expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    });
  }

  it('names the path of the refused sub-event', async () => {
    const { server } = setup();
    const error = await server.callTool('add_event_block', {
      sheetName: 'Sheet1', conditions: [onStart],
      children: [{ conditions: [isVisible] }, { children: [{ eventType: 'comment', text: 'ok' }, { eventType: 'variable', name: 'V' }] }],
    }).catch((e: Error) => e);
    const issues = JSON.parse((error as Error).message);
    expect(issues[0].path).toEqual(['children', 1, 'children', 1, 'eventType']);
    expect(issues[0].message).toContain('add_event_to_sheet (eventType "variable")');
  });

  it('refuses a non-block eventType at the top level instead of writing an empty block', async () => {
    const { server, writer } = setup();
    await expect(server.callTool('add_event_block', { sheetName: 'Sheet1', eventType: 'comment', text: 'Top-level note' }))
      .rejects.toThrow(/add_event_block adds a block event, not \\"comment\\".*add_event_to_sheet/);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);

    const data = parseResult(await server.callTool('add_event_block', { sheetName: 'Sheet1', eventType: 'block', conditions: [onStart] }));
    expect(data.success).toBe(true);
    expect(writtenEvents(writer)[0]).not.toHaveProperty('text');
  });

  it('refuses a sub-event type that bypasses the schema instead of writing an empty block', async () => {
    const reader = new MockReader();
    const idGen = new MockIdGenerator();
    const child = { eventType: 'variable', name: 'V' } as unknown as ChildEventInput;
    await expect(buildBlockEvent(reader as any, idGen as any, { conditions: [], actions: [], children: [child] }, 1, { count: 0, warnings: [] }))
      .rejects.toThrow(/An event variable cannot be added as a sub-event/);
  });
});

describe('unknown keys in conditions, actions and updates are refused, sid is ignored', () => {
  it('refuses unknown keys in conditions and actions of add_event_block', async () => {
    const { server, writer } = setup();
    await expect(server.callTool('add_event_block', { sheetName: 'Sheet1', conditions: [{ ...isVisible, params: { a: 1 } }] }))
      .rejects.toThrow(/Unknown key\(s\) \\"params\\" in a condition/);
    await expect(server.callTool('add_event_block', { sheetName: 'Sheet1', conditions: [onStart], actions: [{ ...setVisible, inverted: true }] }))
      .rejects.toThrow(/Unknown key\(s\) \\"inverted\\" in an action/);
    await expect(server.callTool('add_event_block', { sheetName: 'Sheet1', conditions: [onStart], actions: [{ callFunction: 'Go', parameters: [], id2: 'x' }] }))
      .rejects.toThrow(/Unknown key\(s\) \\"id2\\" in a function call/);
    await expect(server.callTool('add_event_block', { sheetName: 'Sheet1', conditions: [onStart], actions: [{ type: 'script', script: ['x();'], note: 'y' }] }))
      .rejects.toThrow(/Unknown key\(s\) \\"note\\" in a script action/);
    await expect(server.callTool('add_event_block', { sheetName: 'Sheet1', conditions: [onStart], actions: [{ type: 'comment', text: 'x', color: 'red' }] }))
      .rejects.toThrow(/Unknown key\(s\) \\"color\\" in a comment row/);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('ignores the SIDs of conditions, actions and sub-events copied from a sheet', async () => {
    const { server, writer } = setup();
    const data = parseResult(await server.callTool('add_event_block', {
      sheetName: 'Sheet1',
      conditions: [{ ...onStart, sid: 7 }],
      actions: [{ ...setVisible, sid: 8 }, { callFunction: 'Go', sid: 9 }],
      children: [{ eventType: 'block', sid: 11, conditions: [{ ...isVisible, sid: 12 }], actions: [] }],
    }));
    expect(data.success).toBe(true);
    const block = writtenEvents(writer)[0];
    const sids = [block.sid, block.conditions[0].sid, block.actions[0].sid, block.actions[1].sid, block.children[0].sid, block.children[0].conditions[0].sid];
    expect(sids.every((s: number) => s >= 100_000_000_000_001)).toBe(true);
  });

  it('writes comment row colours and an action breakpoint in the editor\'s key order', async () => {
    const { server, writer } = setup();
    await server.callTool('add_event_block', {
      sheetName: 'Sheet1', conditions: [onStart],
      actions: [
        { type: 'comment', text: 'Coloured', 'background-color': [1, 0.8, 0, 1] },
        { type: 'comment', 'background-color': [0, 0, 0, 0.5], text: 'Both', 'text-color': [1, 1, 1, 1] },
        { id: 'flash', objectClass: 'Sprite1', behaviorType: 'Flash', breakpoint: true, disabled: true, parameters: { 'on-time': '0.1', 'off-time': '0.1', duration: '1' } },
        { ...setVisible, breakpoint: false },
      ],
    });
    const [coloured, both, flash, plain] = writtenEvents(writer)[0].actions;
    expect(coloured).toEqual({ type: 'comment', text: 'Coloured', 'background-color': [1, 0.8, 0, 1] });
    expect(Object.keys(both)).toEqual(['type', 'text', 'text-color', 'background-color']);
    expect(Object.keys(flash)).toEqual(['id', 'objectClass', 'sid', 'disabled', 'breakpoint', 'behaviorType', 'parameters']);
    expect(plain).not.toHaveProperty('breakpoint');
  });

  it('refuses comment row colours that are not [r, g, b, a] with values 0-1', async () => {
    const { server, writer } = setup();
    for (const color of ['#ffcc00', [1, 0, 0], [0, 0, 0, 2]]) {
      await expect(server.callTool('add_event_block', {
        sheetName: 'Sheet1', conditions: [onStart], actions: [{ type: 'comment', text: 'x', 'background-color': color }],
      })).rejects.toThrow(/background-color/);
    }
    await expect(server.callTool('add_event_block', {
      sheetName: 'Sheet1', conditions: [onStart], actions: [{ type: 'comment', text: 'x', 'background-color': '#ffcc00' }],
    })).rejects.toThrow(/Not a valid action\..*comment row/);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('update_event_block writes coloured comment rows and refuses unknown keys in its entries', async () => {
    const events = [{ eventType: 'block', sid: 20, conditions: [{ ...onStart, sid: 21 }], actions: [{ ...setVisible, sid: 22 }] }];
    const { server, writer } = setup(events);
    const data = parseResult(await server.callTool('update_event_block', {
      sheetName: 'Sheet1', sid: 20, addActions: [{ type: 'comment', text: 'Added', 'text-color': [0, 1, 0, 1], sid: 5 }],
    }));
    expect(data.success).toBe(true);
    expect(writtenEvents(writer)[0].actions[1]).toEqual({ type: 'comment', text: 'Added', 'text-color': [0, 1, 0, 1] });

    await expect(server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 20, addConditions: [{ ...isVisible, inverted: true }] }))
      .rejects.toThrow(/Unknown key\(s\) \\"inverted\\" in a condition/);
    await expect(server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 20, updateConditions: [{ index: 0, behaviorType: 'Flash' }] }))
      .rejects.toThrow(/Unknown key\(s\) \\"behaviorType\\" in an updateConditions entry/);
    await expect(server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 20, updateActions: [{ index: 0, params: { visibility: 'invisible' } }] }))
      .rejects.toThrow(/Unknown key\(s\) \\"params\\" in an updateActions entry/);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(1);
  });
});

describe('sub-event helpers', () => {
  it('counts comment and script sub-events toward the event limit', async () => {
    const reader = new MockReader();
    const idGen = new MockIdGenerator();
    const comments: ChildEventInput[] = Array.from({ length: MAX_TOTAL_EVENTS }, (_, i) => ({ eventType: 'comment', text: `c${i}` }));
    await expect(buildBlockEvent(reader as any, idGen as any, { conditions: [], actions: [], children: comments }, 1, { count: 0, warnings: [] }))
      .rejects.toThrow(`Total event count exceeds maximum of ${MAX_TOTAL_EVENTS}`);
    const counter = { count: 0, warnings: [] };
    await buildBlockEvent(reader as any, idGen as any, { conditions: [], actions: [], children: comments.slice(1) }, 1, counter);
    expect(counter.count).toBe(MAX_TOTAL_EVENTS);
  });

  it('collects no object references from comment and script sub-events', () => {
    const refs: ObjectRef[] = [];
    collectObjectRefs([], [], [
      { eventType: 'comment', text: 'x' },
      { eventType: 'script', script: ['y();'] },
      { conditions: [{ id: 'is-visible', objectClass: 'Player' }], children: [{ eventType: 'comment', text: 'z' }] },
    ], refs);
    expect(refs.map(r => r.objectClass)).toEqual(['Player']);
  });

  it('parses the sub-event shapes and keeps their content', () => {
    expect(childEventSchema.parse({ eventType: 'comment', text: 't', sid: 4 })).toEqual({ eventType: 'comment', text: 't' });
    expect(childEventSchema.parse({ eventType: 'script', script: 's' })).toEqual({ eventType: 'script', script: 's' });
    expect(childEventSchema.parse({})).toEqual({ conditions: [], actions: [], children: [] });
    expect(childEventSchema.safeParse({ eventType: 'group', title: 'G' }).success).toBe(false);
  });
});
