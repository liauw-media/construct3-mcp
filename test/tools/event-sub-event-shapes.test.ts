/**
 * Sub-events that are not blocks, and keys the event input does not know.
 * add_event_block writes comment and script sub-events in the editor's shapes
 * and refuses every other sub-event type and every unknown key or argument,
 * instead of writing an empty block or dropping the key (follow-up to #32).
 * All data is synthetic.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MockServer } from '../mocks/mock-server.js';
import { MockReader } from '../mocks/mock-reader.js';
import { MockWriter } from '../mocks/mock-writer.js';
import { MockIdGenerator } from '../mocks/mock-id-generator.js';
import { registerEventTools } from '../../src/tools/event-tools.js';
import {
  actionSchema,
  buildBlockEvent,
  childEventSchema,
  collectObjectRefs,
  commentActionSchema,
  conditionSchema,
  functionCallActionSchema,
  scriptActionSchema,
  standardActionSchema,
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
    // A variable inside an event is local; add_event_to_sheet would make it global, a different scope
    expect(issues[0].message).toContain('would be a local variable');
    expect(issues[0].message).toContain('add_event_to_sheet (eventType "variable") adds a variable only at the top level of a sheet, where it is a global variable');
    expect(issues[0].message).not.toMatch(/A global variable is added with/);
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
  it('writes comment and script sub-events up to the event limit and counts them toward it', async () => {
    const reader = new MockReader();
    const idGen = new MockIdGenerator();
    const kids: ChildEventInput[] = Array.from({ length: MAX_TOTAL_EVENTS }, (_, i) =>
      (i % 2 === 0 ? { eventType: 'comment', text: `c${i}` } : { eventType: 'script', script: [`s${i}();`] }));
    await expect(buildBlockEvent(reader as any, idGen as any, { conditions: [], actions: [], children: kids }, 1, { count: 0, warnings: [] }))
      .rejects.toThrow(`Total event count exceeds maximum of ${MAX_TOTAL_EVENTS}`);
    const counter = { count: 0, warnings: [] };
    const built = await buildBlockEvent(reader as any, idGen as any, { conditions: [], actions: [], children: kids.slice(1) }, 1, counter);
    expect(counter.count).toBe(MAX_TOTAL_EVENTS);
    // Every sub-event is written as what it is, none as an (empty) block
    expect(built.children).toHaveLength(MAX_TOTAL_EVENTS - 1);
    expect(built.children![0]).toEqual({ eventType: 'script', language: 'javascript', script: ['s1();'] });
    expect(built.children![1]).toEqual({ eventType: 'comment', text: 'c2' });
    expect(built.children!.filter(c => c.eventType === 'block')).toEqual([]);
  });

  it('collects no object references from comment and script sub-events, and those of the blocks around them', async () => {
    const refs: ObjectRef[] = [];
    collectObjectRefs([], [], [
      { eventType: 'comment', text: 'x' },
      { eventType: 'script', script: ['y();'] },
      { conditions: [{ id: 'is-visible', objectClass: 'Player' }], children: [{ eventType: 'comment', text: 'z' }] },
    ], refs);
    expect(refs.map(r => r.objectClass)).toEqual(['Player']);

    // Through the tool: a block after comment and script sub-events is still checked ...
    const { server, writer } = setup();
    const children = [
      { eventType: 'comment', text: 'Mentions Ghost, which is no object' },
      { eventType: 'script', script: ['Ghost.run();'] },
      { conditions: [{ id: 'is-visible', objectClass: 'Ghost' }] },
    ];
    const refused = await server.callTool('add_event_block', { sheetName: 'Sheet1', conditions: [onStart], children });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/Object class validation failed[\s\S]*Ghost/);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    // ... and with a known object, all three are written as they are
    const data = parseResult(await server.callTool('add_event_block', {
      sheetName: 'Sheet1', conditions: [onStart], children: [...children.slice(0, 2), { conditions: [isVisible] }],
    }));
    expect(data.success).toBe(true);
    expect(writtenEvents(writer)[0].children.map((c: any) => c.eventType)).toEqual(['comment', 'script', 'block']);
  });

  it('parses the sub-event shapes and keeps their content', () => {
    expect(childEventSchema.parse({ eventType: 'comment', text: 't', sid: 4 })).toEqual({ eventType: 'comment', text: 't' });
    expect(childEventSchema.parse({ eventType: 'script', script: 's' })).toEqual({ eventType: 'script', script: 's' });
    expect(childEventSchema.parse({})).toEqual({ conditions: [], actions: [], children: [] });
    expect(childEventSchema.safeParse({ eventType: 'group', title: 'G' }).success).toBe(false);
  });
});

describe('unknown arguments of add_event_block and update_event_block are refused', () => {
  const blockEvents = () => [{ eventType: 'block', sid: 20, conditions: [{ ...onStart, sid: 21 }], actions: [{ ...setVisible, sid: 22 }] }];

  it('add_event_block refuses an argument it does not take instead of writing an empty or partial block', async () => {
    const { server, writer } = setup();
    const refusals: Array<[Record<string, unknown>, string]> = [
      [{ text: 'A note without eventType' }, 'text'],
      [{ conditions: [onStart], actons: [setVisible] }, 'actons'],
      [{ conditions: [onStart], action: [setVisible] }, 'action'],
      [{ conditions: [onStart], subEvents: [{ eventType: 'comment', text: 'Lost' }] }, 'subEvents'],
    ];
    for (const [args, key] of refusals) {
      await expect(server.callTool('add_event_block', { sheetName: 'Sheet1', ...args }))
        .rejects.toThrow(new RegExp(`Unknown key\\(s\\) \\\\"${key}\\\\" in the arguments of add_event_block: they would not be written`));
    }
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('add_event_block ignores the sid of a block copied from a sheet', async () => {
    const { server, writer } = setup();
    const data = parseResult(await server.callTool('add_event_block', {
      sheetName: 'Sheet1', eventType: 'block', sid: 500, conditions: [{ ...onStart, sid: 501 }], actions: [], children: [],
    }));
    expect(data.success).toBe(true);
    const block = writtenEvents(writer)[0];
    expect(block.sid).not.toBe(500);
    expect(block.sid).toBeGreaterThanOrEqual(100_000_000_000_001);
  });

  it('update_event_block refuses an argument it does not take and changes nothing', async () => {
    const { server, writer } = setup(blockEvents());
    await expect(server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 20, disabled: true, children: [{ eventType: 'comment', text: 'Added?' }] }))
      .rejects.toThrow(/Unknown key\(s\) \\"children\\" in the arguments of update_event_block.*It does not add sub-events/);
    // A mistyped addition next to a removal must not remove the action alone
    await expect(server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 20, removeActionIndices: [0], addActons: [{ id: 'destroy', objectClass: 'Sprite1' }] }))
      .rejects.toThrow(/Unknown key\(s\) \\"addActons\\" in the arguments of update_event_block/);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);

    const data = parseResult(await server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 20, disabled: true }));
    expect(data.success).toBe(true);
  });

  it('is enforced by the MCP SDK itself: the advertised schemas are strict and unknown arguments come back as errors', async () => {
    const reader = new MockReader({
      objects: new Map([['Sprite1', { name: 'Sprite1', 'plugin-id': 'Sprite', sid: 1 }]]),
      eventSheets: new Map([['Sheet1', { name: 'Sheet1', sid: 10, events: blockEvents() }]]),
    });
    const writer = new MockWriter();
    const mcp = new McpServer({ name: 'test', version: '0.0.0' });
    registerEventTools({ server: mcp, reader, writer, idGen: new MockIdGenerator() } as any);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      for (const name of ['add_event_block', 'update_event_block']) {
        const schema = tools.find(t => t.name === name)!.inputSchema as Record<string, any>;
        expect(schema.additionalProperties).toBe(false);
        expect(schema.properties.sheetName).toBeDefined();
      }
      const text = (r: any) => r.content.map((c: any) => c.text).join('\n');

      const typo = await client.callTool({ name: 'add_event_block', arguments: { sheetName: 'Sheet1', conditions: [onStart], actons: [setVisible] } });
      expect(typo.isError).toBe(true);
      expect(text(typo)).toContain('Unknown key(s) \\"actons\\" in the arguments of add_event_block');
      const children = await client.callTool({ name: 'update_event_block', arguments: { sheetName: 'Sheet1', sid: 20, disabled: true, children: [{ eventType: 'comment', text: 'x' }] } });
      expect(children.isError).toBe(true);
      expect(text(children)).toContain('Unknown key(s) \\"children\\" in the arguments of update_event_block');
      expect(writer.callsFor('writeEntityFile')).toHaveLength(0);

      const ok = await client.callTool({ name: 'add_event_block', arguments: { sheetName: 'Sheet1', sid: 7, conditions: [onStart], children: [{ eventType: 'comment', text: 'Kept' }] } });
      expect(ok.isError).toBeFalsy();
      const written = (writer.callsFor('writeEntityFile')[0].args[2] as any).events.at(-1);
      expect(written.children).toEqual([{ eventType: 'comment', text: 'Kept' }]);
    } finally {
      await client.close();
      await mcp.close();
    }
  });
});

describe('function calls in the older forms', () => {
  const droppedWarnings = (data: any) => (data.warnings ?? []).filter((w: string) => w.includes('dropped'));

  it('accepts id/objectClass next to positional parameters, as next to keyed ones, and drops them with a warning', async () => {
    const { server, writer } = setup();
    const data = parseResult(await server.callTool('add_event_block', {
      sheetName: 'Sheet1', conditions: [onStart],
      actions: [
        { id: 'call-function', objectClass: 'Functions', callFunction: 'Go', parameters: ['1'] },
        { id: 'call-function', objectClass: 'Functions', callFunction: 'Go', parameters: { 0: '1' } },
        { callFunction: 'Go', objectClass: 'Functions', parameters: ['2'] },
      ],
    }));
    expect(data.success).toBe(true);
    const [positional, keyed, objectClassOnly] = writtenEvents(writer)[0].actions;
    expect(withoutSids(positional)).toEqual({ callFunction: 'Go', parameters: ['1'] });
    expect(withoutSids(keyed)).toEqual({ callFunction: 'Go', parameters: ['1'] });
    expect(withoutSids(objectClassOnly)).toEqual({ callFunction: 'Go', parameters: ['2'] });
    const dropped = droppedWarnings(data);
    expect(dropped).toHaveLength(3);
    expect(dropped[0]).toContain('id/objectClass were dropped');
    expect(dropped[2]).toContain('objectClass was dropped');
  });

  it('drops behaviorType and "behavior-type" of the older form with a warning that names them', async () => {
    const { server, writer } = setup();
    const data = parseResult(await server.callTool('add_event_block', {
      sheetName: 'Sheet1', conditions: [onStart],
      actions: [
        { id: 'call-function', objectClass: 'Functions', callFunction: 'Go', parameters: { 0: '1' }, behaviorType: 'Flash' },
        { callFunction: 'Go', parameters: ['1'], 'behavior-type': 'Flash' },
      ],
    }));
    expect(data.success).toBe(true);
    for (const call of writtenEvents(writer)[0].actions) expect(Object.keys(call)).toEqual(['callFunction', 'sid', 'parameters']);
    const dropped = droppedWarnings(data);
    expect(dropped[0]).toContain('id/objectClass/behaviorType were dropped');
    expect(dropped[1]).toContain('behavior-type was dropped');
  });

  it('refuses a breakpoint on a function call in every form, as it would not be written', async () => {
    const { server, writer } = setup([{ eventType: 'block', sid: 20, conditions: [{ ...onStart, sid: 21 }], actions: [] }]);
    const calls = [
      { id: 'call-function', objectClass: 'Functions', callFunction: 'Go', parameters: { 0: '1' }, breakpoint: true },
      { id: 'call-function', objectClass: 'Functions', callFunction: 'Go', breakpoint: false },
      { id: 'call-function', objectClass: 'Functions', callFunction: 'Go', parameters: ['1'], breakpoint: true },
      { callFunction: 'Go', parameters: ['1'], breakpoint: true },
    ];
    for (const call of calls) {
      await expect(server.callTool('add_event_block', { sheetName: 'Sheet1', conditions: [onStart], actions: [call] }))
        .rejects.toThrow(/\\"breakpoint\\" in a function call: they would not be written, so the call is refused.*A breakpoint on a function call is not supported/);
      await expect(server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 20, addActions: [call] }))
        .rejects.toThrow(/\\"breakpoint\\" in a function call/);
    }
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    // A breakpoint on a plugin action is still written
    const data = parseResult(await server.callTool('add_event_block', { sheetName: 'Sheet1', conditions: [onStart], actions: [{ ...setVisible, breakpoint: true }] }));
    expect(data.success).toBe(true);
    expect(writtenEvents(writer).at(-1).actions[0].breakpoint).toBe(true);
  });
});

describe('refusal messages name every key the refusing object accepts', () => {
  /** The object schema inside wrappers (preprocess, refinements, lazy, optional, default, array). */
  function objectOf(schema: z.ZodTypeAny): z.AnyZodObject {
    let s: any = schema;
    for (let i = 0; i < 10 && !(s instanceof z.ZodObject); i++) {
      if (s instanceof z.ZodEffects) s = s.innerType();
      else if (s instanceof z.ZodLazy) s = s.schema;
      else if (s instanceof z.ZodOptional || s instanceof z.ZodDefault) s = s._def.innerType;
      else if (s instanceof z.ZodArray) s = s.element;
      else throw new Error(`no object schema in ${s?.constructor?.name}`);
    }
    return s;
  }
  const mentions = (message: string, key: string) =>
    new RegExp(`(^|[^\\w-])"?${key.replace(/-/g, '\\-')}"?($|[^\\w-])`).test(message);

  /** Parse a valid input plus an unknown key with the schema; its refusal must name every key the object takes. */
  function expectAllKeysNamed(label: string, schema: z.ZodTypeAny, valid: Record<string, unknown>) {
    const result = schema.safeParse({ ...valid, zzUnknownKey: 1 });
    expect(result.success, label).toBe(false);
    const issue = result.error!.issues.find(i => i.code === 'unrecognized_keys' && i.path.length === 0)!;
    expect(issue, label).toBeDefined();
    expect(issue.message, label).toContain('"zzUnknownKey"');
    const missing = Object.keys(objectOf(schema).shape).filter(k => k !== 'sid' && !mentions(issue.message, k));
    expect(missing, `${label}: ${issue.message}`).toEqual([]);
  }

  it('for conditions, actions, function calls, script actions and comment rows', () => {
    expectAllKeysNamed('condition', conditionSchema, isVisible);
    expectAllKeysNamed('action', standardActionSchema, setVisible);
    expectAllKeysNamed('function call', functionCallActionSchema, { callFunction: 'Go' });
    expectAllKeysNamed('script action', scriptActionSchema, { type: 'script', script: 'x();' });
    expectAllKeysNamed('comment row', commentActionSchema, { type: 'comment', text: 'x' });
    // Through the action union, the refusal comes from the shape the input matches
    const viaUnion = actionSchema.safeParse({ ...setVisible, zzUnknownKey: 1 });
    expect(viaUnion.error!.issues[0].message).toContain('in an action');
  });

  it('for block, comment and script sub-events', () => {
    const [block, comment, script] = (childEventSchema as any)._def.getter()._def.schema.options as z.AnyZodObject[];
    expectAllKeysNamed('block sub-event', block, {});
    expectAllKeysNamed('comment sub-event', comment, { eventType: 'comment', text: 'x' });
    expectAllKeysNamed('script sub-event', script, { eventType: 'script', script: 'x();' });
  });

  it('for the arguments of add_event_block and update_event_block and the update entries', () => {
    const { server } = setup();
    const add = server.getTool('add_event_block')!;
    const update = server.getTool('update_event_block')!;
    expectAllKeysNamed('add_event_block arguments', add.inputSchema!, { sheetName: 'Sheet1' });
    expectAllKeysNamed('update_event_block arguments', update.inputSchema!, { sheetName: 'Sheet1', sid: 20 });
    expectAllKeysNamed('updateActions entry', objectOf(update.schema.updateActions), { index: 0 });
    expectAllKeysNamed('updateConditions entry', objectOf(update.schema.updateConditions), { index: 0 });
  });
});
