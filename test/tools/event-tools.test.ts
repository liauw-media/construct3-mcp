import { describe, it, expect } from 'vitest';
import { MockServer } from '../mocks/mock-server.js';
import { MockReader } from '../mocks/mock-reader.js';
import { MockWriter } from '../mocks/mock-writer.js';
import { MockIdGenerator } from '../mocks/mock-id-generator.js';
import { registerEventTools } from '../../src/tools/event-tools.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';

function setup(readerData = {}) {
  const server = new MockServer();
  const reader = new MockReader(readerData);
  const writer = new MockWriter();
  const idGen = new MockIdGenerator();
  registerEventTools({ server, reader, writer, idGen } as any);
  return { server, reader, writer, idGen };
}

function parseResult(result: any) {
  return JSON.parse(result.content[0].text);
}

describe('create_event_sheet', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('create_event_sheet')).toBe(true);
  });

  it('creates a new event sheet', async () => {
    const { server, writer } = setup();
    const result = await server.callTool('create_event_sheet', { name: 'MainSheet' });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.entity).toBe('MainSheet');
    expect(data.generatedSid).toBeDefined();
    expect(writer.callsFor('writeEntityFile')).toHaveLength(1);
    expect(writer.callsFor('addToProject')).toHaveLength(1);
  });

  it('creates with include sheets', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['SharedEvents', { name: 'SharedEvents', events: [], sid: 1 }]]),
    });
    const result = await server.callTool('create_event_sheet', {
      name: 'Level1Sheet',
      includeSheets: ['SharedEvents'],
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    // Check include events were added to the written data
    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const events = writtenData.events as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('include');
    expect(events[0].includeSheet).toBe('SharedEvents');
  });

  it('rejects duplicate name', async () => {
    const { server } = setup({
      eventSheets: new Map([['MainSheet', { name: 'MainSheet', events: [], sid: 1 }]]),
    });
    const result = await server.callTool('create_event_sheet', { name: 'MainSheet' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already exists');
  });

  it('rejects missing include sheet', async () => {
    const { server } = setup();
    const result = await server.callTool('create_event_sheet', {
      name: 'MySheet',
      includeSheets: ['NonExistent'],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('does not exist');
  });
});

describe('add_event_to_sheet', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('add_event_to_sheet')).toBe(true);
  });

  it('reads each other sheet once for the name checks of a function with parameters', async () => {
    const { server, reader } = setup({
      eventSheets: new Map([
        ['MainSheet', { name: 'MainSheet', events: [], sid: 1 }],
        ['Other', { name: 'Other', events: [], sid: 2 }],
      ]),
    });
    const reads: string[] = [];
    const readEventSheet = reader.readEventSheet.bind(reader);
    reader.readEventSheet = async (name: string) => {
      reads.push(name);
      return readEventSheet(name);
    };
    const result = await server.callTool('add_event_to_sheet', {
      sheetName: 'MainSheet', eventType: 'function', functionName: 'Heal', functionParams: [{ name: 'amount', type: 'number' }],
    });
    expect(parseResult(result).success).toBe(true);
    expect(reads.filter(name => name === 'Other')).toHaveLength(1);
  });

  it('adds a group event', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', { name: 'MainSheet', events: [], sid: 1 }]]),
    });
    const result = await server.callTool('add_event_to_sheet', {
      sheetName: 'MainSheet',
      eventType: 'group',
      title: 'Movement',
    });
    expect(parseResult(result).success).toBe(true);
    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const events = writtenData.events as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('group');
    expect(events[0].title).toBe('Movement');
  });

  it('adds a variable event', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', { name: 'MainSheet', events: [], sid: 1 }]]),
    });
    const result = await server.callTool('add_event_to_sheet', {
      sheetName: 'MainSheet',
      eventType: 'variable',
      variableName: 'score',
      variableType: 'number',
      initialValue: '100',
    });
    expect(parseResult(result).success).toBe(true);
  });

  it('adds a function event', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', { name: 'MainSheet', events: [], sid: 1 }]]),
    });
    const result = await server.callTool('add_event_to_sheet', {
      sheetName: 'MainSheet',
      eventType: 'function',
      functionName: 'DoStuff',
      functionParams: [{ name: 'amount', type: 'number' }],
    });
    expect(parseResult(result).success).toBe(true);
  });

  it('adds a comment event', async () => {
    const { server } = setup({
      eventSheets: new Map([['MainSheet', { name: 'MainSheet', events: [], sid: 1 }]]),
    });
    const result = await server.callTool('add_event_to_sheet', {
      sheetName: 'MainSheet',
      eventType: 'comment',
      commentText: 'TODO: optimize this',
    });
    expect(parseResult(result).success).toBe(true);
  });

  it('adds an include event', async () => {
    const { server } = setup({
      eventSheets: new Map([
        ['MainSheet', { name: 'MainSheet', events: [], sid: 1 }],
        ['SharedSheet', { name: 'SharedSheet', events: [], sid: 2 }],
      ]),
    });
    const result = await server.callTool('add_event_to_sheet', {
      sheetName: 'MainSheet',
      eventType: 'include',
      includeSheet: 'SharedSheet',
    });
    expect(parseResult(result).success).toBe(true);
  });

  it('errors on missing sheet', async () => {
    const { server } = setup();
    const result = await server.callTool('add_event_to_sheet', {
      sheetName: 'NonExistent',
      eventType: 'group',
      title: 'Test',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  it('requires title for group events', async () => {
    const { server } = setup({
      eventSheets: new Map([['MainSheet', { name: 'MainSheet', events: [], sid: 1 }]]),
    });
    const result = await server.callTool('add_event_to_sheet', {
      sheetName: 'MainSheet',
      eventType: 'group',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('title is required');
  });

  it('inserts at start when position=start', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet',
        events: [{ eventType: 'comment', text: 'existing' }],
        sid: 1,
      }]]),
    });
    await server.callTool('add_event_to_sheet', {
      sheetName: 'MainSheet',
      eventType: 'comment',
      commentText: 'new first',
      position: 'start',
    });
    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const events = writtenData.events as Array<Record<string, unknown>>;
    expect(events[0].text).toBe('new first');
  });
});

describe('add_event_block', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('add_event_block')).toBe(true);
  });

  it('adds a simple block event', async () => {
    const { server, writer } = setup({
      objects: new Map([['Player', { name: 'Player', 'plugin-id': 'Sprite', sid: 1 }]]),
      eventSheets: new Map([['MainSheet', { name: 'MainSheet', events: [], sid: 10 }]]),
    });
    const result = await server.callTool('add_event_block', {
      sheetName: 'MainSheet',
      conditions: [{ id: 'on-start-of-layout', objectClass: 'System' }],
      actions: [{ id: 'set-instvar-value', objectClass: 'Player' }],
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.generatedSid).toBeDefined();
  });

  it('accepts a top-level block without conditions and warns that it runs every tick', async () => {
    const { server, writer } = setup({
      objects: new Map([['Sprite1', { name: 'Sprite1', 'plugin-id': 'Sprite', sid: 1 }]]),
      eventSheets: new Map([['Sheet1', {
        name: 'Sheet1',
        events: [{ eventType: 'group', sid: 50, title: 'Group1', children: [] }],
        sid: 10,
      }]]),
    });
    for (const groupPath of ['Group1', undefined]) {
      const result = await server.callTool('add_event_block', {
        sheetName: 'Sheet1',
        ...(groupPath ? { groupPath } : {}),
        conditions: [],
        actions: [{ id: 'set-position', objectClass: 'Sprite1', parameters: { x: '1', y: '2' } }],
      });
      const data = parseResult(result);
      expect(data.success).toBe(true);
      expect(data.warnings.some((w: string) => w.includes('every tick'))).toBe(true);
    }
    const written = writer.callsFor('writeEntityFile').at(-1)!.args[2] as any;
    expect(written.events[0].children[0].conditions).toEqual([]);
    expect(written.events[1].conditions).toEqual([]);
    expect(written.events[1]).not.toHaveProperty('isElse');
  });

  it('writes condition-less sub-events without a warning', async () => {
    const { server, writer } = setup({
      objects: new Map([['Sprite1', { name: 'Sprite1', 'plugin-id': 'Sprite', sid: 1 }]]),
      eventSheets: new Map([['Sheet1', { name: 'Sheet1', events: [], sid: 10 }]]),
    });
    const result = await server.callTool('add_event_block', {
      sheetName: 'Sheet1',
      conditions: [{ id: 'every-tick', objectClass: 'System' }],
      children: [{ conditions: [], actions: [{ id: 'set-position', objectClass: 'Sprite1', parameters: { x: '1', y: '2' } }] }],
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.warnings).toBeUndefined();
    const child = (writer.callsFor('writeEntityFile')[0].args[2] as any).events.at(-1).children[0];
    expect(child.conditions).toEqual([]);
    expect(typeof child.actions[0].sid).toBe('number');
    expect(child).not.toHaveProperty('isElse');
  });

  it('does not tell callers to set isElse', () => {
    const { server } = setup();
    const tool = (server as any).tools.get('add_event_block');
    expect(tool.description).not.toMatch(/set isElse/);
    expect(JSON.stringify(Object.values(tool.schema).map((s: any) => s.description))).not.toMatch(/conditions become optional/);
  });

  it('writes else blocks as a System "else" first condition, with else-if conditions after it', async () => {
    const { server, writer } = setup({
      objects: new Map([['Sprite1', { name: 'Sprite1', 'plugin-id': 'Sprite', sid: 1 }]]),
      eventSheets: new Map([['Sheet1', { name: 'Sheet1', events: [], sid: 10 }]]),
    });
    const result = await server.callTool('add_event_block', {
      sheetName: 'Sheet1',
      conditions: [{ id: 'every-tick', objectClass: 'System' }],
      children: [
        { conditions: [{ id: 'is-visible', objectClass: 'Sprite1' }] },
        { isElse: true, conditions: [{ id: 'compare-two-values', objectClass: 'System', parameters: { 'first-value': '1', comparison: 0, 'second-value': '1' } }] },
        { isElse: true, actions: [{ id: 'set-visible', objectClass: 'Sprite1', parameters: { visibility: 'visible' } }] },
      ],
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.warnings?.some((w: string) => /ignores conditions/.test(w)) ?? false).toBe(false);

    const block = (writer.callsFor('writeEntityFile')[0].args[2] as any).events.at(-1);
    for (const child of block.children.slice(1)) {
      expect(child.conditions[0]).toEqual({ id: 'else', objectClass: 'System', sid: expect.any(Number) });
    }
    expect(block.children[1].conditions[1].id).toBe('compare-two-values');
    expect(JSON.stringify(block)).not.toContain('isElse');
  });

  it('warns when an else block has no block before it', async () => {
    const { server } = setup({
      eventSheets: new Map([['Sheet1', {
        name: 'Sheet1',
        events: [{ eventType: 'block', sid: 20, conditions: [{ id: 'every-tick', objectClass: 'System', sid: 21 }], actions: [] }],
        sid: 10,
      }]]),
    });
    const atStart = parseResult(await server.callTool('add_event_block', { sheetName: 'Sheet1', isElse: true, position: 'start' }));
    expect(atStart.success).toBe(true);
    expect(atStart.warnings.some((w: string) => w.includes('no event comes before it'))).toBe(true);

    const afterBlock = parseResult(await server.callTool('add_event_block', { sheetName: 'Sheet1', isElse: true }));
    expect(afterBlock.warnings?.some((w: string) => w.includes('before it')) ?? false).toBe(false);
  });

  it('writes OR blocks with isOrBlock and no per-condition isOr key', async () => {
    const { server, writer } = setup({
      objects: new Map([['Sprite1', { name: 'Sprite1', 'plugin-id': 'Sprite', sid: 1 }]]),
      eventSheets: new Map([['Sheet1', { name: 'Sheet1', events: [], sid: 10 }]]),
    });
    const viaFlag = parseResult(await server.callTool('add_event_block', {
      sheetName: 'Sheet1',
      conditions: [{ id: 'is-visible', objectClass: 'Sprite1' }, { id: 'is-on-screen', objectClass: 'Sprite1' }],
      isOrBlock: true,
    }));
    expect(viaFlag.success).toBe(true);
    const legacy = parseResult(await server.callTool('add_event_block', {
      sheetName: 'Sheet1',
      conditions: [{ id: 'is-visible', objectClass: 'Sprite1' }, { id: 'is-on-screen', objectClass: 'Sprite1', isOr: true }],
    }));
    expect(legacy.success).toBe(true);
    expect(legacy.warnings.some((w: string) => w.includes('isOrBlock: true'))).toBe(true);

    const events = (writer.callsFor('writeEntityFile').at(-1)!.args[2] as any).events;
    for (const block of events) {
      expect(block.isOrBlock).toBe(true);
      expect(block.conditions.some((c: any) => 'isOr' in c)).toBe(false);
    }
  });

  it('refuses mixed isOr flags and writes nothing', async () => {
    const { server, writer } = setup({
      objects: new Map([['Sprite1', { name: 'Sprite1', 'plugin-id': 'Sprite', sid: 1 }]]),
      eventSheets: new Map([['Sheet1', { name: 'Sheet1', events: [], sid: 10 }]]),
    });
    const result = await server.callTool('add_event_block', {
      sheetName: 'Sheet1',
      conditions: [
        { id: 'is-visible', objectClass: 'Sprite1' },
        { id: 'is-on-screen', objectClass: 'Sprite1' },
        { id: 'is-mirrored', objectClass: 'Sprite1', isOr: true },
      ],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('isOrBlock: true');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('writes function calls, script actions and comment rows in the editor shapes', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['Sheet1', {
        name: 'Sheet1',
        events: [{
          eventType: 'function-block', functionName: 'fn1', sid: 5, conditions: [], actions: [],
          functionParameters: [
            { name: 'p1', type: 'number', initialValue: '0', comment: '', sid: 6 },
            { name: 'p2', type: 'boolean', initialValue: 'false', comment: '', sid: 7 },
          ],
        }],
        sid: 10,
      }]]),
    });
    const data = parseResult(await server.callTool('add_event_block', {
      sheetName: 'Sheet1',
      conditions: [{ id: 'on-start-of-layout', objectClass: 'System' }],
      actions: [
        { callFunction: 'fn1', parameters: ['1', true] },
        { type: 'script', script: 'const a = 1;\nconsole.log(a);' },
        { type: 'comment', text: 'note' },
      ],
    }));
    expect(data.success).toBe(true);
    const actions = (writer.callsFor('writeEntityFile')[0].args[2] as any).events.at(-1).actions;
    expect(Object.keys(actions[0])).toEqual(['callFunction', 'sid', 'parameters']);
    expect(actions[0].parameters).toEqual(['1', true]);
    expect(actions[1]).toEqual({ type: 'script', language: 'javascript', script: ['const a = 1;', 'console.log(a);'] });
    expect(actions[2]).toEqual({ type: 'comment', text: 'note' });
  });

  it('lints the positional arguments of function calls before writing', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['Sheet1', {
        name: 'Sheet1',
        events: [{
          eventType: 'function-block', functionName: 'fn1', sid: 5, conditions: [], actions: [],
          functionParameters: [{ name: 'p1', type: 'string', initialValue: '', comment: '', sid: 6 }],
        }],
        sid: 10,
      }]]),
    });
    const result = await server.callTool('add_event_block', {
      sheetName: 'Sheet1',
      conditions: [{ id: 'on-start-of-layout', objectClass: 'System' }],
      actions: [{ callFunction: 'fn1', parameters: ['"unterminated'] }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('unterminated string literal');
    expect(result.content[0].text).toContain('call function "fn1"');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('errors on missing event sheet', async () => {
    const { server } = setup();
    const result = await server.callTool('add_event_block', {
      sheetName: 'NonExistent',
      conditions: [{ id: 'x', objectClass: 'System' }],
    });
    expect(result.isError).toBe(true);
  });

  it('errors on unknown objectClass', async () => {
    const { server } = setup({
      eventSheets: new Map([['MainSheet', { name: 'MainSheet', events: [], sid: 10 }]]),
    });
    const result = await server.callTool('add_event_block', {
      sheetName: 'MainSheet',
      conditions: [{ id: 'x', objectClass: 'NonExistentObject' }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown objectClass');
  });

  it('inserts into a group via groupPath', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet',
        events: [{ eventType: 'group', title: 'Movement', children: [], sid: 50 }],
        sid: 10,
      }]]),
    });
    const result = await server.callTool('add_event_block', {
      sheetName: 'MainSheet',
      conditions: [{ id: 'on-start-of-layout', objectClass: 'System' }],
      actions: [],
      groupPath: 'Movement',
    });
    expect(parseResult(result).success).toBe(true);
  });

  it('errors on missing groupPath', async () => {
    const { server } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet',
        events: [],
        sid: 10,
      }]]),
    });
    const result = await server.callTool('add_event_block', {
      sheetName: 'MainSheet',
      conditions: [{ id: 'x', objectClass: 'System' }],
      groupPath: 'NonExistent',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });
});

describe('delete_event_sheet', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('delete_event_sheet')).toBe(true);
  });

  it('errors on nonexistent sheet', async () => {
    const { server } = setup();
    const result = await server.callTool('delete_event_sheet', { name: 'NonExistent' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });
});

describe('delete_event_from_sheet', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('delete_event_from_sheet')).toBe(true);
  });

  it('errors when neither sid nor includeSheet provided', async () => {
    const { server } = setup({
      eventSheets: new Map([['MainSheet', { name: 'MainSheet', events: [], sid: 1 }]]),
    });
    const result = await server.callTool('delete_event_from_sheet', {
      sheetName: 'MainSheet',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('exactly one');
  });

  it('deletes a block by SID', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          { eventType: 'block', sid: 100, conditions: [], actions: [] },
          { eventType: 'block', sid: 200, conditions: [], actions: [] },
        ],
      }]]),
    });
    const result = await server.callTool('delete_event_from_sheet', {
      sheetName: 'MainSheet',
      sid: 100,
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.deletedType).toBe('block');
    expect(data.deletedSid).toBe(100);

    // Verify the written sheet has only one event left
    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const events = writtenData.events as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0].sid).toBe(200);
  });

  it('deletes a nested block inside a group', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          {
            eventType: 'group', sid: 50, title: 'Movement', children: [
              { eventType: 'block', sid: 100, conditions: [], actions: [] },
              { eventType: 'block', sid: 200, conditions: [], actions: [] },
            ],
          },
        ],
      }]]),
    });
    const result = await server.callTool('delete_event_from_sheet', {
      sheetName: 'MainSheet',
      sid: 100,
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);

    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const events = writtenData.events as Array<Record<string, unknown>>;
    const group = events[0];
    expect((group.children as unknown[]).length).toBe(1);
  });

  it('removes include by sheet name', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          { eventType: 'include', includeSheet: 'SharedSheet' },
          { eventType: 'block', sid: 100, conditions: [], actions: [] },
        ],
      }]]),
    });
    const result = await server.callTool('delete_event_from_sheet', {
      sheetName: 'MainSheet',
      includeSheet: 'SharedSheet',
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.deletedType).toBe('include');
    expect(data.deletedTarget).toBe('SharedSheet');

    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const events = writtenData.events as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('block');
  });

  it('errors on nonexistent SID with summary', async () => {
    const { server } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          { eventType: 'block', sid: 100, conditions: [1], actions: [1, 2] },
        ],
      }]]),
    });
    const result = await server.callTool('delete_event_from_sheet', {
      sheetName: 'MainSheet',
      sid: 999,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('SID 999');
    expect(result.content[0].text).toContain('SID 100');
  });

  it('errors on nonexistent include with list', async () => {
    const { server } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          { eventType: 'include', includeSheet: 'SharedSheet' },
        ],
      }]]),
    });
    const result = await server.callTool('delete_event_from_sheet', {
      sheetName: 'MainSheet',
      includeSheet: 'NonExistent',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('SharedSheet');
  });

  it('dryRun returns preview without deleting', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          { eventType: 'block', sid: 100, conditions: [], actions: [] },
        ],
      }]]),
    });
    const result = await server.callTool('delete_event_from_sheet', {
      sheetName: 'MainSheet',
      sid: 100,
      dryRun: true,
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.dryRun).toBe(true);
    expect(data.action).toBe('would_delete');
    // No writes should have occurred
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('reports children count for group deletion', async () => {
    const { server } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          {
            eventType: 'group', sid: 50, title: 'Movement', children: [
              { eventType: 'block', sid: 100, conditions: [], actions: [] },
              { eventType: 'block', sid: 200, conditions: [], actions: [] },
            ],
          },
        ],
      }]]),
    });
    const result = await server.callTool('delete_event_from_sheet', {
      sheetName: 'MainSheet',
      sid: 50,
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.childrenRemoved).toBe(2);
    expect(data.warnings).toBeDefined();
    expect(data.warnings[0]).toContain('2 child');
  });
});

describe('update_event_block', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('update_event_block')).toBe(true);
  });

  it('updates block disabled state', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          { eventType: 'block', sid: 100, conditions: [], actions: [] },
        ],
      }]]),
    });
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 100,
      disabled: true,
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);

    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const events = writtenData.events as Array<Record<string, unknown>>;
    expect(events[0].disabled).toBe(true);
  });

  it('updates action parameters by index (merge semantics)', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          {
            eventType: 'block', sid: 100,
            conditions: [{ id: 'x', objectClass: 'System', sid: 10 }],
            actions: [{
              id: 'go-to-layout', objectClass: 'System', sid: 20,
              parameters: { layout: '"Level 1"', transition: '"none"' },
            }],
          },
        ],
      }]]),
    });
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 100,
      updateActions: [{ index: 0, parameters: { layout: '"Level 2"' } }],
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);

    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const events = writtenData.events as Array<Record<string, unknown>>;
    const action = (events[0].actions as Record<string, unknown>[])[0];
    const params = action.parameters as Record<string, unknown>;
    // New value applied
    expect(params.layout).toBe('"Level 2"');
    // Existing value preserved (merge semantics)
    expect(params.transition).toBe('"none"');
  });

  it('updates condition inversion by index', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          {
            eventType: 'block', sid: 100,
            conditions: [{ id: 'compare', objectClass: 'System', sid: 10 }],
            actions: [],
          },
        ],
      }]]),
    });
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 100,
      updateConditions: [{ index: 0, isInverted: true }],
    });
    expect(parseResult(result).success).toBe(true);

    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const events = writtenData.events as Array<Record<string, unknown>>;
    const cond = (events[0].conditions as Record<string, unknown>[])[0];
    expect(cond.isInverted).toBe(true);
  });

  it('adds new actions with generated SIDs', async () => {
    const { server, writer } = setup({
      objects: new Map([['Player', { name: 'Player', 'plugin-id': 'Sprite', sid: 1 }]]),
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          {
            eventType: 'block', sid: 100,
            conditions: [{ id: 'x', objectClass: 'System', sid: 10 }],
            actions: [],
          },
        ],
      }]]),
    });
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 100,
      addActions: [{ id: 'destroy', objectClass: 'Player' }],
    });
    expect(parseResult(result).success).toBe(true);

    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const events = writtenData.events as Array<Record<string, unknown>>;
    const actions = events[0].actions as Record<string, unknown>[];
    expect(actions).toHaveLength(1);
    expect(actions[0].id).toBe('destroy');
    expect(actions[0].sid).toBeDefined();
  });

  it('removes actions by index', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          {
            eventType: 'block', sid: 100,
            conditions: [{ id: 'x', objectClass: 'System', sid: 10 }],
            actions: [
              { id: 'a', objectClass: 'System', sid: 20 },
              { id: 'b', objectClass: 'System', sid: 21 },
              { id: 'c', objectClass: 'System', sid: 22 },
            ],
          },
        ],
      }]]),
    });
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 100,
      removeActionIndices: [0, 2],
    });
    expect(parseResult(result).success).toBe(true);

    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const events = writtenData.events as Array<Record<string, unknown>>;
    const actions = events[0].actions as Record<string, unknown>[];
    expect(actions).toHaveLength(1);
    expect(actions[0].id).toBe('b');
  });

  it('errors on nonexistent SID', async () => {
    const { server } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [{ eventType: 'block', sid: 100, conditions: [], actions: [] }],
      }]]),
    });
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 999,
      disabled: true,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('SID 999');
  });

  it('errors on out-of-range action index', async () => {
    const { server } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          {
            eventType: 'block', sid: 100,
            conditions: [{ id: 'x', objectClass: 'System', sid: 10 }],
            actions: [{ id: 'a', objectClass: 'System', sid: 20 }],
          },
        ],
      }]]),
    });
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 100,
      updateActions: [{ index: 5, parameters: { x: 1 } }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('out of range');
  });

  it('errors when no updates provided', async () => {
    const { server } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [{ eventType: 'block', sid: 100, conditions: [], actions: [] }],
      }]]),
    });
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 100,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No updates');
  });

  it('errors when targeting a non-block event', async () => {
    const { server } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [{ eventType: 'group', sid: 100, title: 'Test', children: [] }],
      }]]),
    });
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 100,
      disabled: true,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('group');
    expect(result.content[0].text).toContain('not a block');
  });

  it('adds new conditions with generated SIDs', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          {
            eventType: 'block', sid: 100,
            conditions: [{ id: 'x', objectClass: 'System', sid: 10 }],
            actions: [],
          },
        ],
      }]]),
    });
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 100,
      addConditions: [{ id: 'every-tick', objectClass: 'System' }],
    });
    expect(parseResult(result).success).toBe(true);

    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const events = writtenData.events as Array<Record<string, unknown>>;
    const conditions = events[0].conditions as Record<string, unknown>[];
    expect(conditions).toHaveLength(2);
    expect(conditions[1].id).toBe('every-tick');
    expect(conditions[1].sid).toBeDefined();
  });

  it('removes conditions by index', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          {
            eventType: 'block', sid: 100,
            conditions: [
              { id: 'a', objectClass: 'System', sid: 10 },
              { id: 'b', objectClass: 'System', sid: 11 },
            ],
            actions: [],
          },
        ],
      }]]),
    });
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 100,
      removeConditionIndices: [0],
    });
    expect(parseResult(result).success).toBe(true);

    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const events = writtenData.events as Array<Record<string, unknown>>;
    const conditions = events[0].conditions as Record<string, unknown>[];
    expect(conditions).toHaveLength(1);
    expect(conditions[0].id).toBe('b');
  });

  it('update + remove in same call uses original indices', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          {
            eventType: 'block', sid: 100,
            conditions: [{ id: 'x', objectClass: 'System', sid: 10 }],
            actions: [
              { id: 'a', objectClass: 'System', sid: 20, parameters: { val: 1 } },
              { id: 'b', objectClass: 'System', sid: 21, parameters: { val: 2 } },
              { id: 'c', objectClass: 'System', sid: 22, parameters: { val: 3 } },
            ],
          },
        ],
      }]]),
    });
    // Remove index 0 (action 'a') and update index 2 (action 'c') in the same call.
    // Both indices refer to the ORIGINAL array, so this must not error.
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 100,
      removeActionIndices: [0],
      updateActions: [{ index: 2, parameters: { val: 99 } }],
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);

    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const events = writtenData.events as Array<Record<string, unknown>>;
    const actions = events[0].actions as Record<string, unknown>[];
    // After: action 'a' removed, action 'c' updated. Result: [b, c(updated)]
    expect(actions).toHaveLength(2);
    expect(actions[0].id).toBe('b');
    expect(actions[1].id).toBe('c');
    expect((actions[1].parameters as Record<string, unknown>).val).toBe(99);
  });

  it('can disable individual actions', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          {
            eventType: 'block', sid: 100,
            conditions: [{ id: 'x', objectClass: 'System', sid: 10 }],
            actions: [{ id: 'a', objectClass: 'System', sid: 20 }],
          },
        ],
      }]]),
    });
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 100,
      updateActions: [{ index: 0, disabled: true }],
    });
    expect(parseResult(result).success).toBe(true);

    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const events = writtenData.events as Array<Record<string, unknown>>;
    const action = (events[0].actions as Record<string, unknown>[])[0];
    expect(action.disabled).toBe(true);
  });

  it('deduplicates removal indices (does not double-splice)', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          {
            eventType: 'block', sid: 100,
            conditions: [{ id: 'x', objectClass: 'System', sid: 10 }],
            actions: [
              { id: 'a', objectClass: 'System', sid: 20 },
              { id: 'b', objectClass: 'System', sid: 21 },
              { id: 'c', objectClass: 'System', sid: 22 },
            ],
          },
        ],
      }]]),
    });
    // Pass duplicate index — should only remove ONE action, not two
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 100,
      removeActionIndices: [1, 1],
    });
    expect(parseResult(result).success).toBe(true);

    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const events = writtenData.events as Array<Record<string, unknown>>;
    const actions = events[0].actions as Record<string, unknown>[];
    expect(actions).toHaveLength(2);
    expect(actions[0].id).toBe('a');
    expect(actions[1].id).toBe('c');
  });

  it('deduplicates condition removal indices', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          {
            eventType: 'block', sid: 100,
            conditions: [
              { id: 'a', objectClass: 'System', sid: 10 },
              { id: 'b', objectClass: 'System', sid: 11 },
              { id: 'c', objectClass: 'System', sid: 12 },
            ],
            actions: [],
          },
        ],
      }]]),
    });
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 100,
      removeConditionIndices: [0, 0],
    });
    expect(parseResult(result).success).toBe(true);

    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const events = writtenData.events as Array<Record<string, unknown>>;
    const conditions = events[0].conditions as Record<string, unknown>[];
    expect(conditions).toHaveLength(2);
    expect(conditions[0].id).toBe('b');
    expect(conditions[1].id).toBe('c');
  });

  it('warns when all conditions are removed', async () => {
    const { server } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          {
            eventType: 'block', sid: 100,
            conditions: [{ id: 'a', objectClass: 'System', sid: 10 }],
            actions: [{ id: 'b', objectClass: 'System', sid: 20 }],
          },
        ],
      }]]),
    });
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 100,
      removeConditionIndices: [0],
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.warnings).toBeDefined();
    expect(data.warnings.some((w: string) => w.includes('conditions were removed') && w.includes('runs whenever'))).toBe(true);
  });

  it('does not warn about removed conditions on a function block that never had any', async () => {
    const { server } = setup({
      eventSheets: new Map([['Sheet1', {
        name: 'Sheet1', sid: 1,
        events: [{
          eventType: 'function-block', functionName: 'fn1', functionParameters: [], sid: 100, conditions: [],
          actions: [{ id: 'a', objectClass: 'System', sid: 20, parameters: { v: '1' } }],
        }],
      }]]),
    });
    const data = parseResult(await server.callTool('update_event_block', {
      sheetName: 'Sheet1', sid: 100, updateActions: [{ index: 0, parameters: { v: '2' } }],
    }));
    expect(data.success).toBe(true);
    expect(data.warnings?.some((w: string) => w.includes('conditions were removed')) ?? false).toBe(false);
  });

  it('does not warn about removed conditions when toggling a condition-less sub-event', async () => {
    const { server } = setup({
      eventSheets: new Map([['Sheet1', {
        name: 'Sheet1', sid: 1,
        events: [{
          eventType: 'block', sid: 100, conditions: [{ id: 'x', objectClass: 'System', sid: 10 }], actions: [],
          children: [{ eventType: 'block', sid: 200, conditions: [], actions: [] }],
        }],
      }]]),
    });
    const data = parseResult(await server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 200, disabled: true }));
    expect(data.success).toBe(true);
    expect(data.warnings?.some((w: string) => w.includes('conditions were removed')) ?? false).toBe(false);
  });

  it('warns when removing the else condition leaves no condition', async () => {
    const { server } = setup({
      eventSheets: new Map([['Sheet1', {
        name: 'Sheet1', sid: 1,
        events: [
          { eventType: 'block', sid: 200, conditions: [{ id: 'x', objectClass: 'System', sid: 20 }], actions: [] },
          { eventType: 'block', sid: 300, conditions: [{ id: 'else', objectClass: 'System', sid: 30 }], actions: [] },
        ],
      }]]),
    });
    const data = parseResult(await server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 300, removeConditionIndices: [0] }));
    expect(data.warnings.some((w: string) => w.includes('conditions were removed'))).toBe(true);
  });

  it('uses function wording when a function block loses its last condition', async () => {
    const { server } = setup({
      eventSheets: new Map([['Sheet1', {
        name: 'Sheet1', sid: 1,
        events: [{
          eventType: 'function-block', functionName: 'fn1', functionParameters: [], sid: 100,
          conditions: [{ id: 'x', objectClass: 'System', sid: 10 }], actions: [],
        }],
      }]]),
    });
    const data = parseResult(await server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 100, removeConditionIndices: [0] }));
    expect(data.warnings.some((w: string) => w.includes('function body'))).toBe(true);
  });

  it('does not falsely warn when removing all conditions but adding new ones', async () => {
    const { server } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          {
            eventType: 'block', sid: 100,
            conditions: [{ id: 'a', objectClass: 'System', sid: 10 }],
            actions: [],
          },
        ],
      }]]),
    });
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 100,
      removeConditionIndices: [0],
      addConditions: [{ id: 'every-tick', objectClass: 'System' }],
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    // Should NOT warn about unconditional — we added a replacement condition
    const hasUnconditionalWarning = data.warnings?.some((w: string) => w.includes('conditions were removed')) ?? false;
    expect(hasUnconditionalWarning).toBe(false);
  });

  it('writes disabled right after sid when toggling actions and conditions', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['Sheet1', {
        name: 'Sheet1', sid: 1,
        events: [{
          eventType: 'block', sid: 10,
          conditions: [{ id: 'is-visible', objectClass: 'Sprite1', sid: 3, parameters: { a: '1' } }],
          actions: [
            { id: 'set-position', objectClass: 'Sprite1', sid: 2, parameters: { x: '1', y: '2' } },
            { type: 'script', language: 'javascript', script: ['1;'] },
          ],
        }],
      }]]),
    });
    await server.callTool('update_event_block', {
      sheetName: 'Sheet1', sid: 10,
      updateActions: [{ index: 0, disabled: true }, { index: 1, disabled: true }],
      updateConditions: [{ index: 0, disabled: true }],
    });
    let block = (writer.callsFor('writeEntityFile').at(-1)!.args[2] as any).events[0];
    expect(Object.keys(block.actions[0])).toEqual(['id', 'objectClass', 'sid', 'disabled', 'parameters']);
    expect(Object.keys(block.actions[1])).toEqual(['type', 'language', 'script', 'disabled']);
    expect(Object.keys(block.conditions[0])).toEqual(['id', 'objectClass', 'sid', 'disabled', 'parameters']);

    await server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 10, updateActions: [{ index: 0, disabled: false }] });
    block = (writer.callsFor('writeEntityFile').at(-1)!.args[2] as any).events[0];
    expect(Object.keys(block.actions[0])).toEqual(['id', 'objectClass', 'sid', 'parameters']);
  });

  it('adds actions in the editor shapes and keeps existing script lines as they are', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['Sheet1', {
        name: 'Sheet1', sid: 1,
        events: [
          {
            eventType: 'function-block', functionName: 'fn1', sid: 5, conditions: [], actions: [],
            functionParameters: [{ name: 'p1', type: 'number', initialValue: '0', comment: '', sid: 6 }],
          },
          {
            eventType: 'block', sid: 10,
            conditions: [{ id: 'on-start-of-layout', objectClass: 'System', sid: 11 }],
            actions: [
              { type: 'script', language: 'javascript', script: ['tag1();', ''] },
              { id: 'wait', objectClass: 'System', sid: 12, parameters: { seconds: '1' } },
            ],
          },
        ],
      }]]),
    });
    const data = parseResult(await server.callTool('update_event_block', {
      sheetName: 'Sheet1', sid: 10,
      updateActions: [{ index: 1, parameters: { seconds: '2' } }],
      addActions: [
        { type: 'script', script: 'a();\nb();' },
        { callFunction: 'fn1', parameters: ['1'] },
        { id: 'call-function', objectClass: 'System', callFunction: 'fn1', parameters: { p1: '2' } },
      ],
    }));
    expect(data.success).toBe(true);
    const actions = (writer.callsFor('writeEntityFile')[0].args[2] as any).events[1].actions;
    expect(actions[0]).toEqual({ type: 'script', language: 'javascript', script: ['tag1();', ''] });
    expect(actions[2]).toEqual({ type: 'script', language: 'javascript', script: ['a();', 'b();'] });
    expect(Object.keys(actions[3])).toEqual(['callFunction', 'sid', 'parameters']);
    expect(actions[4]).toEqual({ callFunction: 'fn1', sid: expect.any(Number), parameters: ['2'] });
  });

  it('merges function call arguments by position or name and keeps them an array', async () => {
    const sheet = () => new Map([['Sheet1', {
      name: 'Sheet1', sid: 1,
      events: [
        {
          eventType: 'function-block', functionName: 'fn1', sid: 5, conditions: [], actions: [],
          functionParameters: [
            { name: 'p1', type: 'number', initialValue: '0', comment: '', sid: 1 },
            { name: 'p2', type: 'boolean', initialValue: 'false', comment: '', sid: 2 },
          ],
        },
        { eventType: 'block', sid: 10, conditions: [], actions: [{ callFunction: 'fn1', sid: 11, parameters: ['1', true] }] },
      ],
    }]]);
    let ctx = setup({ eventSheets: sheet() });
    let data = parseResult(await ctx.server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 10, updateActions: [{ index: 0, parameters: { 0: '2' } }] }));
    expect(data.success).toBe(true);
    let act = (ctx.writer.callsFor('writeEntityFile')[0].args[2] as any).events[1].actions[0];
    expect(act.parameters).toEqual(['2', true]);

    ctx = setup({ eventSheets: sheet() });
    await ctx.server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 10, updateActions: [{ index: 0, parameters: { p2: false } }] });
    act = (ctx.writer.callsFor('writeEntityFile')[0].args[2] as any).events[1].actions[0];
    expect(act.parameters).toEqual(['1', false]);

    ctx = setup({ eventSheets: sheet() });
    await ctx.server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 10, updateActions: [{ index: 0, parameters: ['3', true] }] });
    act = (ctx.writer.callsFor('writeEntityFile')[0].args[2] as any).events[1].actions[0];
    expect(act).toEqual({ callFunction: 'fn1', sid: 11, parameters: ['3', true] });

    ctx = setup({ eventSheets: sheet() });
    const bad = await ctx.server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 10, updateActions: [{ index: 0, parameters: { p9: '1' } }] });
    expect(bad.isError).toBe(true);
    expect(ctx.writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('makes a block an else block and back, dropping a legacy isElse key', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['Sheet1', {
        name: 'Sheet1', sid: 1,
        events: [
          { eventType: 'block', sid: 10, conditions: [{ id: 'x', objectClass: 'System', sid: 11 }], actions: [] },
          { eventType: 'block', sid: 20, conditions: [{ id: 'y', objectClass: 'System', sid: 21 }], actions: [], isElse: true },
        ],
      }]]),
    });
    const data = parseResult(await server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 20, isElse: true }));
    expect(data.success).toBe(true);
    let block = (writer.callsFor('writeEntityFile').at(-1)!.args[2] as any).events[1];
    expect(block.conditions.map((c: any) => c.id)).toEqual(['else', 'y']);
    expect(block).not.toHaveProperty('isElse');
    expect(data.warnings.some((w: string) => w.includes('dropped the block-level "isElse" key'))).toBe(true);

    await server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 20, isElse: false });
    block = (writer.callsFor('writeEntityFile').at(-1)!.args[2] as any).events[1];
    expect(block.conditions.map((c: any) => c.id)).toEqual(['y']);
  });

  it('toggles isOrBlock and refuses isOr on added conditions of an AND block', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['Sheet1', {
        name: 'Sheet1', sid: 1,
        events: [{ eventType: 'block', sid: 10, conditions: [{ id: 'x', objectClass: 'System', sid: 11 }], actions: [] }],
      }]]),
    });
    const refused = await server.callTool('update_event_block', {
      sheetName: 'Sheet1', sid: 10, addConditions: [{ id: 'y', objectClass: 'System', isOr: true }],
    });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('isOrBlock: true');

    const data = parseResult(await server.callTool('update_event_block', {
      sheetName: 'Sheet1', sid: 10, isOrBlock: true, addConditions: [{ id: 'y', objectClass: 'System', isOr: true }],
    }));
    expect(data.success).toBe(true);
    let block = (writer.callsFor('writeEntityFile').at(-1)!.args[2] as any).events[0];
    expect(block.isOrBlock).toBe(true);
    expect(block.conditions.some((c: any) => 'isOr' in c)).toBe(false);

    await server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 10, isOrBlock: false });
    block = (writer.callsFor('writeEntityFile').at(-1)!.args[2] as any).events[0];
    expect(block).not.toHaveProperty('isOrBlock');
  });
});

describe('remove_event_from_sheet', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('remove_event_from_sheet')).toBe(true);
  });

  it('removes an include by sheet name', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          { eventType: 'include', includeSheet: 'SharedSheet' },
          { eventType: 'block', sid: 100, conditions: [], actions: [] },
        ],
      }]]),
    });
    const result = await server.callTool('remove_event_from_sheet', {
      sheetName: 'MainSheet',
      includeSheet: 'SharedSheet',
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.removedCount).toBe(1);
    expect(data.removedInclude).toBe('SharedSheet');

    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const events = writtenData.events as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('block');
  });

  it('errors when include not present and lists current includes', async () => {
    const { server } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          { eventType: 'include', includeSheet: 'OtherSheet' },
        ],
      }]]),
    });
    const result = await server.callTool('remove_event_from_sheet', {
      sheetName: 'MainSheet',
      includeSheet: 'NonExistent',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('OtherSheet');
  });

  it('errors on nonexistent sheet', async () => {
    const { server } = setup();
    const result = await server.callTool('remove_event_from_sheet', {
      sheetName: 'NoSuchSheet',
      includeSheet: 'Anything',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  it('removes multiple includes of the same sheet', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          { eventType: 'include', includeSheet: 'SharedSheet' },
          { eventType: 'include', includeSheet: 'SharedSheet' },
          { eventType: 'block', sid: 100, conditions: [], actions: [] },
        ],
      }]]),
    });
    const result = await server.callTool('remove_event_from_sheet', {
      sheetName: 'MainSheet',
      includeSheet: 'SharedSheet',
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.removedCount).toBe(2);

    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const events = writtenData.events as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
  });
});

describe('update_event_block_action', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('update_event_block_action')).toBe(true);
  });

  it('replaces action parameters by block SID and action index', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [{
          eventType: 'block', sid: 100,
          conditions: [{ id: 'on-start', objectClass: 'System', sid: 10 }],
          actions: [{
            id: 'go-to-layout', objectClass: 'System', sid: 20,
            parameters: { layout: '"Level 1"', transition: '"none"' },
          }],
        }],
      }]]),
    });
    const result = await server.callTool('update_event_block_action', {
      sheetName: 'MainSheet',
      blockSid: 100,
      actionIndex: 0,
      parameters: { layout: '"Level 2"' },
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.updatedBlockSid).toBe(100);
    expect(data.updatedActionIndex).toBe(0);

    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const events = writtenData.events as Array<Record<string, unknown>>;
    const action = (events[0].actions as Record<string, unknown>[])[0];
    const params = action.parameters as Record<string, unknown>;
    // New value applied — replaces (not merges)
    expect(params.layout).toBe('"Level 2"');
    // Old key not in new params — gone (replace semantics)
    expect(params.transition).toBeUndefined();
  });

  it('errors on nonexistent block SID', async () => {
    const { server } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [{ eventType: 'block', sid: 100, conditions: [], actions: [] }],
      }]]),
    });
    const result = await server.callTool('update_event_block_action', {
      sheetName: 'MainSheet',
      blockSid: 999,
      actionIndex: 0,
      parameters: {},
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('SID 999');
  });

  it('errors on out-of-range action index', async () => {
    const { server } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [{
          eventType: 'block', sid: 100,
          conditions: [{ id: 'x', objectClass: 'System', sid: 10 }],
          actions: [{ id: 'a', objectClass: 'System', sid: 20 }],
        }],
      }]]),
    });
    const result = await server.callTool('update_event_block_action', {
      sheetName: 'MainSheet',
      blockSid: 100,
      actionIndex: 5,
      parameters: { x: 1 },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('out of range');
  });

  it('errors when targeting a non-block event', async () => {
    const { server } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [{ eventType: 'group', sid: 100, title: 'Test', children: [] }],
      }]]),
    });
    const result = await server.callTool('update_event_block_action', {
      sheetName: 'MainSheet',
      blockSid: 100,
      actionIndex: 0,
      parameters: {},
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('group');
  });

  it('works on a nested block inside a group', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [{
          eventType: 'group', sid: 50, title: 'Movement', children: [{
            eventType: 'block', sid: 100,
            conditions: [{ id: 'x', objectClass: 'System', sid: 10 }],
            actions: [{ id: 'set-speed', objectClass: 'Player', sid: 20, parameters: { speed: '100' } }],
          }],
        }],
      }]]),
    });
    const result = await server.callTool('update_event_block_action', {
      sheetName: 'MainSheet',
      blockSid: 100,
      actionIndex: 0,
      parameters: { speed: '200' },
    });
    expect(parseResult(result).success).toBe(true);

    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const events = writtenData.events as Array<Record<string, unknown>>;
    const group = events[0];
    const block = (group.children as Record<string, unknown>[])[0];
    const action = (block.actions as Record<string, unknown>[])[0];
    expect((action.parameters as Record<string, unknown>).speed).toBe('200');
  });

  function callSheet(call: Record<string, unknown>) {
    return new Map([['Sheet1', {
      name: 'Sheet1', sid: 1,
      events: [
        {
          eventType: 'function-block', functionName: 'fn1', sid: 5, conditions: [], actions: [],
          functionParameters: [
            { name: 'p1', type: 'number', initialValue: '0', comment: '', sid: 1 },
            { name: 'p2', type: 'boolean', initialValue: 'false', comment: '', sid: 2 },
          ],
        },
        { eventType: 'block', sid: 10, conditions: [], actions: [call, { id: 'wait', objectClass: 'System', sid: 12, parameters: { seconds: '1' } }] },
      ],
    }]]);
  }

  it('writes function call arguments as an array, from an array or a keyed object', async () => {
    for (const parameters of [['3', false], { 0: '3', 1: false }, { p1: '3', p2: false }]) {
      const { server, writer } = setup({ eventSheets: callSheet({ callFunction: 'fn1', sid: 11, parameters: ['1', true] }) });
      const data = parseResult(await server.callTool('update_event_block_action', { sheetName: 'Sheet1', blockSid: 10, actionIndex: 0, parameters }));
      expect(data.success).toBe(true);
      expect(data.callFunction).toBe('fn1');
      const act = (writer.callsFor('writeEntityFile')[0].args[2] as any).events[1].actions[0];
      expect(act).toEqual({ callFunction: 'fn1', sid: 11, parameters: ['3', false] });
    }
  });

  it('rewrites a call stored in the old shape into the editor shape', async () => {
    const { server, writer } = setup({
      eventSheets: callSheet({ id: 'call-function', objectClass: 'System', sid: 11, parameters: { 0: '1', 1: true }, callFunction: 'fn1' }),
    });
    const data = parseResult(await server.callTool('update_event_block_action', { sheetName: 'Sheet1', blockSid: 10, actionIndex: 0, parameters: ['2', true] }));
    expect(data.warnings.some((w: string) => w.includes('old shape'))).toBe(true);
    const act = (writer.callsFor('writeEntityFile')[0].args[2] as any).events[1].actions[0];
    expect(Object.keys(act)).toEqual(['callFunction', 'sid', 'parameters']);
    expect(act.parameters).toEqual(['2', true]);
  });

  it('refuses an argument array for an action that is not a function call', async () => {
    const { server, writer } = setup({ eventSheets: callSheet({ callFunction: 'fn1', sid: 11, parameters: ['1', true] }) });
    const result = await server.callTool('update_event_block_action', { sheetName: 'Sheet1', blockSid: 10, actionIndex: 1, parameters: ['2'] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not a function call');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });
});

describe('move_events_between_sheets', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('move_events_between_sheets')).toBe(true);
  });

  it('copies events to target sheet (copy semantics, deleteSource=false)', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([
        ['SourceSheet', {
          name: 'SourceSheet', sid: 1,
          events: [
            { eventType: 'block', sid: 100, conditions: [], actions: [] },
            { eventType: 'block', sid: 200, conditions: [], actions: [] },
          ],
        }],
        ['TargetSheet', {
          name: 'TargetSheet', sid: 2,
          events: [],
        }],
      ]),
    });
    const result = await server.callTool('move_events_between_sheets', {
      sourceSheet: 'SourceSheet',
      targetSheet: 'TargetSheet',
      sids: [100],
      deleteSource: false,
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.movedCount).toBe(1);
    expect(data.movedSids).toEqual([100]);

    // Only target sheet is written when deleteSource=false
    expect(writer.callsFor('writeEntityFile')).toHaveLength(1);
    const writtenTarget = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const targetEvents = writtenTarget.events as Array<Record<string, unknown>>;
    expect(targetEvents).toHaveLength(1);
    expect(targetEvents[0].sid).toBe(100);
  });

  it('moves events (deleteSource=true) removes from source', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([
        ['SourceSheet', {
          name: 'SourceSheet', sid: 1,
          events: [
            { eventType: 'block', sid: 100, conditions: [], actions: [] },
            { eventType: 'block', sid: 200, conditions: [], actions: [] },
          ],
        }],
        ['TargetSheet', {
          name: 'TargetSheet', sid: 2,
          events: [],
        }],
      ]),
    });
    const result = await server.callTool('move_events_between_sheets', {
      sourceSheet: 'SourceSheet',
      targetSheet: 'TargetSheet',
      sids: [100],
      deleteSource: true,
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.deleteSource).toBe(true);

    // Both sheets are written
    expect(writer.callsFor('writeEntityFile')).toHaveLength(2);

    // Check source now has only sid=200
    const writeCalls = writer.callsFor('writeEntityFile');
    const sourceWrite = writeCalls.find((c: any) => c.args[1] === 'SourceSheet');
    const sourceEvents = (sourceWrite.args[2] as Record<string, unknown>).events as Array<Record<string, unknown>>;
    expect(sourceEvents).toHaveLength(1);
    expect(sourceEvents[0].sid).toBe(200);
  });

  it('errors when source and target are the same sheet', async () => {
    const { server } = setup({
      eventSheets: new Map([['Sheet', { name: 'Sheet', sid: 1, events: [] }]]),
    });
    const result = await server.callTool('move_events_between_sheets', {
      sourceSheet: 'Sheet',
      targetSheet: 'Sheet',
      sids: [100],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('must be different');
  });

  it('errors when a SID is not found in source', async () => {
    const { server } = setup({
      eventSheets: new Map([
        ['SourceSheet', {
          name: 'SourceSheet', sid: 1,
          events: [{ eventType: 'block', sid: 100, conditions: [], actions: [] }],
        }],
        ['TargetSheet', { name: 'TargetSheet', sid: 2, events: [] }],
      ]),
    });
    const result = await server.callTool('move_events_between_sheets', {
      sourceSheet: 'SourceSheet',
      targetSheet: 'TargetSheet',
      sids: [999],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('999');
  });

  it('errors on nonexistent source sheet', async () => {
    const { server } = setup({
      eventSheets: new Map([['TargetSheet', { name: 'TargetSheet', sid: 2, events: [] }]]),
    });
    const result = await server.callTool('move_events_between_sheets', {
      sourceSheet: 'NoSuch',
      targetSheet: 'TargetSheet',
      sids: [100],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  it('inserts at start when position=start', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([
        ['SourceSheet', {
          name: 'SourceSheet', sid: 1,
          events: [{ eventType: 'block', sid: 100, conditions: [], actions: [] }],
        }],
        ['TargetSheet', {
          name: 'TargetSheet', sid: 2,
          events: [{ eventType: 'block', sid: 999, conditions: [], actions: [] }],
        }],
      ]),
    });
    await server.callTool('move_events_between_sheets', {
      sourceSheet: 'SourceSheet',
      targetSheet: 'TargetSheet',
      sids: [100],
      position: 'start',
    });
    const writtenTarget = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const targetEvents = writtenTarget.events as Array<Record<string, unknown>>;
    expect(targetEvents[0].sid).toBe(100);
    expect(targetEvents[1].sid).toBe(999);
  });
});

// ─── update_event_variable ────────────────────────────────

describe('update_event_variable', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('update_event_variable')).toBe(true);
  });

  it('renames a variable event', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['Game', {
        name: 'Game',
        events: [
          { eventType: 'variable', name: 'score', type: 'number', initialValue: '0', sid: 55 },
        ],
        sid: 1,
      }]]),
    });
    const result = await server.callTool('update_event_variable', {
      sheetName: 'Game',
      sid: 55,
      newName: 'totalScore',
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(true);
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.events[0].name).toBe('totalScore');
  });

  it('changes variable type and initial value', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['Game', {
        name: 'Game',
        events: [
          { eventType: 'variable', name: 'flag', type: 'number', initialValue: '0', sid: 66 },
        ],
        sid: 1,
      }]]),
    });
    await server.callTool('update_event_variable', {
      sheetName: 'Game',
      sid: 66,
      newType: 'boolean',
      newInitialValue: 'false',
    });
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.events[0].type).toBe('boolean');
    expect(written.events[0].initialValue).toBe('false');
  });

  it('sets static and constant flags', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['Game', {
        name: 'Game',
        events: [
          { eventType: 'variable', name: 'max', type: 'number', initialValue: '100', sid: 77 },
        ],
        sid: 1,
      }]]),
    });
    await server.callTool('update_event_variable', {
      sheetName: 'Game',
      sid: 77,
      isConstant: true,
    });
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.events[0].isConstant).toBe(true);
  });

  it('errors if SID not found', async () => {
    const { server } = setup({
      eventSheets: new Map([['Game', { name: 'Game', events: [], sid: 1 }]]),
    });
    const result = await server.callTool('update_event_variable', {
      sheetName: 'Game',
      sid: 9999,
      newName: 'x',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('SID 9999');
  });

  it('errors if SID points to non-variable event', async () => {
    const { server } = setup({
      eventSheets: new Map([['Game', {
        name: 'Game',
        events: [
          { eventType: 'block', conditions: [], actions: [], sid: 88 },
        ],
        sid: 1,
      }]]),
    });
    const result = await server.callTool('update_event_variable', {
      sheetName: 'Game',
      sid: 88,
      newName: 'x',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not a variable event');
  });

  it('errors if new name already used', async () => {
    const { server } = setup({
      eventSheets: new Map([['Game', {
        name: 'Game',
        events: [
          { eventType: 'variable', name: 'score', type: 'number', initialValue: '0', sid: 55 },
          { eventType: 'variable', name: 'lives', type: 'number', initialValue: '3', sid: 56 },
        ],
        sid: 1,
      }]]),
    });
    const result = await server.callTool('update_event_variable', {
      sheetName: 'Game',
      sid: 55,
      newName: 'lives',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already exists');
  });

  it('errors with no updates', async () => {
    const { server } = setup({
      eventSheets: new Map([['Game', {
        name: 'Game',
        events: [{ eventType: 'variable', name: 'score', type: 'number', initialValue: '0', sid: 55 }],
        sid: 1,
      }]]),
    });
    const result = await server.callTool('update_event_variable', {
      sheetName: 'Game',
      sid: 55,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No updates');
  });
});

// ─── Issue #16: behaviorType key ─────────────────────────────

/** Objects shaped like real C3 data (see event-helpers.test.ts). */
function behaviorObjects() {
  return new Map<string, Record<string, unknown>>([
    ['Player', {
      name: 'Player', 'plugin-id': 'Sprite', sid: 1,
      behaviorTypes: [
        { behaviorId: 'Platform', name: 'Platform', sid: 11 },
        // Real pair from battlelands: behaviorId "EightDir", name "8Direction"
        { behaviorId: 'EightDir', name: '8Direction', sid: 12 },
      ],
    }],
    ['Car', {
      name: 'Car', 'plugin-id': 'Sprite', sid: 2,
      behaviorTypes: [
        { behaviorId: 'Car', name: 'Car', sid: 21 },
        { behaviorId: 'Flash', name: 'Flash', sid: 22 },
      ],
    }],
  ]);
}

function behaviorProject(events: unknown[] = []) {
  return {
    objects: behaviorObjects(),
    eventSheets: new Map([['MainSheet', { name: 'MainSheet', events, sid: 10 }]]),
  };
}

describe('add_event_block behaviorType (issue #16)', () => {
  it('writes behaviorType and never behavior-type', async () => {
    const { server, writer } = setup(behaviorProject());
    const result = await server.callTool('add_event_block', {
      sheetName: 'MainSheet',
      conditions: [{ id: 'is-on-floor', objectClass: 'Player', behaviorType: 'Platform' }],
      actions: [{ id: 'simulate-control', objectClass: 'Player', behaviorType: 'Platform', parameters: { control: 'jump' } }],
      children: [{
        conditions: [{ id: 'on-start-of-layout', objectClass: 'System' }],
        actions: [{ id: 'flash', objectClass: 'Car', behaviorType: 'Flash' }],
      }],
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.warnings).toBeUndefined();

    const written = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    expect(JSON.stringify(written)).not.toContain('behavior-type');
    const block = (written.events as any[])[0];
    expect(block.conditions[0].behaviorType).toBe('Platform');
    expect(block.actions[0].behaviorType).toBe('Platform');
    expect(block.children[0].actions[0].behaviorType).toBe('Flash');
  });

  it('accepts the deprecated behavior-type alias, writes behaviorType and warns', async () => {
    const { server, writer } = setup(behaviorProject());
    const result = await server.callTool('add_event_block', {
      sheetName: 'MainSheet',
      conditions: [{ id: 'on-start-of-layout', objectClass: 'System' }],
      actions: [{ id: 'set-speed', objectClass: 'Car', 'behavior-type': 'Car', parameters: { speed: '100' } }],
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.warnings.some((w: string) => w.includes('deprecated "behavior-type"'))).toBe(true);

    const written = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const action = (written.events as any[])[0].actions[0];
    expect(action.behaviorType).toBe('Car');
    expect('behavior-type' in action).toBe(false);
  });

  it('warns but still writes when the behavior is not on the object', async () => {
    const { server, writer } = setup(behaviorProject());
    const result = await server.callTool('add_event_block', {
      sheetName: 'MainSheet',
      conditions: [{ id: 'is-on-floor', objectClass: 'Player', behaviorType: 'Platfrom' }],
      actions: [],
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.warnings.some((w: string) => w.includes('behaviorType "Platfrom"'))).toBe(true);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(1);
  });

  it('rejects conflicting behaviorType and behavior-type values without writing', async () => {
    const { server, writer } = setup(behaviorProject());
    const result = await server.callTool('add_event_block', {
      sheetName: 'MainSheet',
      conditions: [{ id: 'is-on-floor', objectClass: 'Player', behaviorType: 'Platform', 'behavior-type': 'Solid' }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Conflicting behavior keys');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });
});

describe('update_event_block behaviorType (issue #16)', () => {
  it('writes behaviorType for added conditions and actions, including the alias', async () => {
    const { server, writer } = setup(behaviorProject([
      { eventType: 'block', sid: 100, conditions: [{ id: 'on-start-of-layout', objectClass: 'System', sid: 101 }], actions: [] },
    ]));
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 100,
      addConditions: [{ id: 'is-on-floor', objectClass: 'Player', 'behavior-type': 'Platform' }],
      addActions: [
        { id: 'flash', objectClass: 'Car', behaviorType: 'Flash' },
        { type: 'script', script: 'console.log(1);' },
      ],
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.warnings.some((w: string) => w.includes('deprecated "behavior-type"'))).toBe(true);

    const written = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    expect(JSON.stringify(written)).not.toContain('behavior-type');
    const block = (written.events as any[])[0];
    expect(block.conditions[1].behaviorType).toBe('Platform');
    expect(block.actions[0].behaviorType).toBe('Flash');
    expect(block.actions[1].type).toBe('script');
  });

  it('rejects conflicting keys on additions before changing or writing anything', async () => {
    const project = behaviorProject([
      { eventType: 'block', sid: 100, conditions: [{ id: 'on-start-of-layout', objectClass: 'System', sid: 101 }], actions: [] },
    ]);
    const { server, writer } = setup(project);
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 100,
      disabled: true,
      addConditions: [{ id: 'is-on-floor', objectClass: 'Player', behaviorType: 'Platform' }],
      addActions: [{ id: 'flash', objectClass: 'Car', behaviorType: 'Flash', 'behavior-type': 'Car' }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Conflicting behavior keys');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    // Validation ran before the disabled toggle and the additions
    const block = (project.eventSheets.get('MainSheet')!.events as any[])[0];
    expect(block.disabled).toBeUndefined();
    expect(block.conditions).toHaveLength(1);
  });

  it('warns once per problem when conditions and actions are added together', async () => {
    const { server, writer } = setup(behaviorProject([
      { eventType: 'block', sid: 100, conditions: [{ id: 'on-start-of-layout', objectClass: 'System', sid: 101 }], actions: [] },
    ]));
    const data = parseResult(await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 100,
      addConditions: [{ id: 'is-moving', objectClass: 'Car', 'behavior-type': 'Nope' }],
      addActions: [{ id: 'stop', objectClass: 'Car', 'behavior-type': 'Nope' }],
    }));
    expect(data.success).toBe(true);
    expect(data.warnings.filter((w: string) => w.includes('behaviorType "Nope" does not match'))).toHaveLength(1);
    expect(data.warnings.filter((w: string) => w.includes('deprecated "behavior-type"'))).toHaveLength(1);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(1);
  });

  it('renames the legacy key on edited conditions/actions instead of writing it back', async () => {
    const { server, writer } = setup(behaviorProject([{
      eventType: 'block', sid: 5,
      conditions: [{ id: 'is-moving', objectClass: 'Car', sid: 7, 'behavior-type': 'Car' }],
      actions: [
        { id: 'flash', objectClass: 'Car', sid: 8, 'behavior-type': 'Flash', parameters: { a: 1 } },
        { id: 'stop', objectClass: 'Car', sid: 9, 'behavior-type': 'Car' },
      ],
    }]));
    const data = parseResult(await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 5,
      updateConditions: [{ index: 0, isInverted: true }],
      updateActions: [{ index: 0, parameters: { a: 2 } }],
    }));
    expect(data.success).toBe(true);
    expect(data.warnings.filter((w: string) => w.includes('Renamed the legacy "behavior-type" key'))).toHaveLength(2);
    expect(data.warnings.some((w: string) => w.includes('fix_legacy_behavior_keys'))).toBe(true);

    const block = (writer.callsFor('writeEntityFile')[0].args[2] as any).events[0];
    expect(block.actions[0]).toEqual({ id: 'flash', objectClass: 'Car', sid: 8, behaviorType: 'Flash', parameters: { a: 2 } });
    expect(Object.keys(block.actions[0])).toEqual(['id', 'objectClass', 'sid', 'behaviorType', 'parameters']);
    expect(block.conditions[0]).toEqual({ id: 'is-moving', objectClass: 'Car', sid: 7, behaviorType: 'Car', isInverted: true });
    // Only edited ACEs are normalized; fix_legacy_behavior_keys handles the rest
    expect(block.actions[1]['behavior-type']).toBe('Car');
  });

  it('leaves an edited legacy key that names no behavior and says why', async () => {
    const { server, writer } = setup(behaviorProject([{
      eventType: 'block', sid: 5,
      conditions: [{ id: 'on-start-of-layout', objectClass: 'System', sid: 6 }],
      actions: [{ id: 'simulate-control', objectClass: 'Player', sid: 8, 'behavior-type': 'EightDir', parameters: { control: 'up' } }],
    }]));
    const data = parseResult(await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 5,
      updateActions: [{ index: 0, parameters: { control: 'down' } }],
    }));
    expect(data.success).toBe(true);
    const warning = data.warnings.find((w: string) => w.includes('still carries the legacy "behavior-type" key'));
    expect(warning).toContain('Did you mean the behavior name "8Direction"');

    const action = (writer.callsFor('writeEntityFile')[0].args[2] as any).events[0].actions[0];
    expect(action['behavior-type']).toBe('EightDir');
    expect(action.behaviorType).toBeUndefined();
    expect(action.parameters).toEqual({ control: 'down' });
  });
});

describe('update_event_block_action legacy behavior key (issue #16)', () => {
  it('renames the legacy key on the edited action and warns', async () => {
    const { server, writer } = setup(behaviorProject([{
      eventType: 'block', sid: 5,
      conditions: [{ id: 'on-start-of-layout', objectClass: 'System', sid: 6 }],
      actions: [{ id: 'flash', objectClass: 'Car', sid: 8, 'behavior-type': 'Flash', parameters: { a: 1 } }],
    }]));
    const data = parseResult(await server.callTool('update_event_block_action', {
      sheetName: 'MainSheet',
      blockSid: 5,
      actionIndex: 0,
      parameters: { a: 2 },
    }));
    expect(data.success).toBe(true);
    expect(data.warnings.some((w: string) => w.includes('Renamed the legacy "behavior-type" key'))).toBe(true);

    const action = (writer.callsFor('writeEntityFile')[0].args[2] as any).events[0].actions[0];
    expect(action).toEqual({ id: 'flash', objectClass: 'Car', sid: 8, behaviorType: 'Flash', parameters: { a: 2 } });
  });

  it('adds no warnings for actions without the legacy key', async () => {
    const { server } = setup(behaviorProject([{
      eventType: 'block', sid: 5,
      conditions: [{ id: 'on-start-of-layout', objectClass: 'System', sid: 6 }],
      actions: [{ id: 'flash', objectClass: 'Car', sid: 8, behaviorType: 'Flash', parameters: { a: 1 } }],
    }]));
    const data = parseResult(await server.callTool('update_event_block_action', {
      sheetName: 'MainSheet', blockSid: 5, actionIndex: 0, parameters: { a: 2 },
    }));
    expect(data.success).toBe(true);
    expect(data.warnings).toBeUndefined();
  });
});

describe('fix_legacy_behavior_keys', () => {
  /** A sheet as written by construct3-mcp <= 1.8.1 (legacy key), nested in a group and a function. */
  function legacySheet() {
    return {
      name: 'MainSheet',
      sid: 10,
      events: [
        {
          eventType: 'group', title: 'Driving', sid: 200, children: [
            {
              eventType: 'block', sid: 201,
              conditions: [{ id: 'is-moving', objectClass: 'Car', sid: 202, 'behavior-type': 'Car' }],
              actions: [
                { id: 'flash', objectClass: 'Car', sid: 203, 'behavior-type': 'Flash', parameters: { 'on-time': '0.1' } },
                // Script actions come in two shapes: a string, or an array of lines (as C3 writes it)
                { type: 'script', script: ['runtime.x = 1;', 'runtime.y = 2;'] },
                { type: 'script', script: 'runtime.z = 3;' },
              ],
            },
          ],
        },
        {
          eventType: 'function-block', functionName: 'Boost', sid: 300,
          conditions: [],
          actions: [{ id: 'set-speed', objectClass: 'Car', sid: 301, 'behavior-type': 'Car', parameters: { speed: '400' } }],
        },
        {
          eventType: 'block', sid: 400,
          conditions: [{ id: 'on-start-of-layout', objectClass: 'System', sid: 401 }],
          actions: [{ id: 'simulate-control', objectClass: 'Player', sid: 402, behaviorType: 'Platform', parameters: { control: 'jump' } }],
        },
      ],
    };
  }

  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('fix_legacy_behavior_keys')).toBe(true);
  });

  it('defaults to a dry run that reports without writing', async () => {
    const sheet = legacySheet();
    const { server, writer } = setup({ objects: behaviorObjects(), eventSheets: new Map([['MainSheet', sheet]]) });
    const data = parseResult(await server.callTool('fix_legacy_behavior_keys', {}));

    expect(data.success).toBe(true);
    expect(data.dryRun).toBe(true);
    expect(data.action).toBe('would_fix');
    expect(data.totalRenamed).toBe(3);
    expect(data.totalConflicts).toBe(0);
    expect(data.sheets).toHaveLength(1);
    expect(data.sheets[0].sheetName).toBe('MainSheet');
    expect(data.sheets[0].changes.map((c: any) => c.sid)).toEqual([202, 203, 301]);
    expect(data.message).toContain('dryRun: false');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    // Source data untouched
    expect(JSON.stringify(sheet)).toContain('behavior-type');
  });

  it('rewrites legacy keys to behaviorType when dryRun is false', async () => {
    const { server, writer } = setup({
      objects: behaviorObjects(),
      eventSheets: new Map([
        ['MainSheet', legacySheet()],
        ['CleanSheet', { name: 'CleanSheet', sid: 11, events: [] }],
      ]),
    });
    const data = parseResult(await server.callTool('fix_legacy_behavior_keys', { dryRun: false }));

    expect(data.success).toBe(true);
    expect(data.action).toBe('fixed');
    expect(data.totalRenamed).toBe(3);
    expect(data.sheetsScanned).toBe(2);
    expect(data.sheets[0].backupFile).toBeDefined();

    const writes = writer.callsFor('writeEntityFile');
    expect(writes).toHaveLength(1); // CleanSheet is not rewritten
    expect(writes[0].args[0]).toBe('eventSheets');
    expect(writes[0].args[1]).toBe('MainSheet');
    const written = writes[0].args[2] as any;
    expect(JSON.stringify(written)).not.toContain('behavior-type');

    const flash = written.events[0].children[0].actions[0];
    expect(flash.behaviorType).toBe('Flash');
    // Renamed in place: key order preserved (id, objectClass, sid, behaviorType, parameters)
    expect(Object.keys(flash)).toEqual(['id', 'objectClass', 'sid', 'behaviorType', 'parameters']);
    expect(written.events[1].actions[0].behaviorType).toBe('Car');
    // Script actions of both shapes are left as they were
    expect(written.events[0].children[0].actions[1].script).toEqual(['runtime.x = 1;', 'runtime.y = 2;']);
    expect(written.events[0].children[0].actions[2].script).toBe('runtime.z = 3;');
    // Already-correct ACEs are untouched
    expect(written.events[2].actions[0]).toEqual({ id: 'simulate-control', objectClass: 'Player', sid: 402, behaviorType: 'Platform', parameters: { control: 'jump' } });
  });

  it('leaves conflicting keys untouched and reports them', async () => {
    const { server, writer } = setup({
      objects: behaviorObjects(),
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 10,
        events: [{
          eventType: 'block', sid: 100,
          conditions: [{ id: 'is-moving', objectClass: 'Car', sid: 101, behaviorType: 'Car', 'behavior-type': 'Car' }],
          actions: [{ id: 'flash', objectClass: 'Car', sid: 102, behaviorType: 'Flash', 'behavior-type': 'Car' }],
        }],
      }]]),
    });
    const data = parseResult(await server.callTool('fix_legacy_behavior_keys', { dryRun: false }));

    expect(data.totalRenamed).toBe(1); // identical duplicate key is just dropped
    expect(data.totalConflicts).toBe(1);
    expect(data.sheets[0].conflicts[0].sid).toBe(102);
    expect(data.message).toContain('resolve them by hand');

    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.events[0].conditions[0]).toEqual({ id: 'is-moving', objectClass: 'Car', sid: 101, behaviorType: 'Car' });
    expect(written.events[0].actions[0]['behavior-type']).toBe('Car');
    expect(written.events[0].actions[0].behaviorType).toBe('Flash');
  });

  it('reports nothing to do on clean projects', async () => {
    const { server, writer } = setup(behaviorProject([
      { eventType: 'block', sid: 100, conditions: [{ id: 'is-on-floor', objectClass: 'Player', sid: 101, behaviorType: 'Platform' }], actions: [] },
    ]));
    const data = parseResult(await server.callTool('fix_legacy_behavior_keys', { dryRun: false }));
    expect(data.success).toBe(true);
    expect(data.totalRenamed).toBe(0);
    expect(data.sheets).toEqual([]);
    expect(data.message).toContain('No legacy');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('renames only names that match a behavior and reports the rest as unresolved', async () => {
    const { server, writer } = setup(behaviorProject([{
      eventType: 'block', sid: 100,
      conditions: [{ id: 'is-moving', objectClass: 'Car', sid: 101, 'behavior-type': 'Car' }],
      actions: [
        // behaviorId instead of the behavior name, as older callers were invited to pass
        { id: 'simulate-control', objectClass: 'Player', sid: 102, 'behavior-type': 'EightDir', parameters: { control: 'up' } },
        { id: 'destroy', objectClass: 'System', sid: 103, 'behavior-type': 'Car' },
      ],
    }]));
    const data = parseResult(await server.callTool('fix_legacy_behavior_keys', { dryRun: false }));

    expect(data.totalRenamed).toBe(1);
    expect(data.totalUnresolved).toBe(2);
    expect(data.sheets[0].unresolved.map((u: any) => u.sid)).toEqual([102, 103]);
    expect(data.sheets[0].unresolved[0].reason).toContain('Did you mean the behavior name "8Direction"');
    expect(data.sheets[0].unresolved[1].reason).toContain('System has no behaviors');
    expect(data.message).toContain('matches no behavior');

    const written = (writer.callsFor('writeEntityFile')[0].args[2] as any).events[0];
    expect(written.conditions[0].behaviorType).toBe('Car');
    expect(written.actions[0]['behavior-type']).toBe('EightDir');
    expect(written.actions[0].behaviorType).toBeUndefined();
    expect(written.actions[1]['behavior-type']).toBe('Car');
  });

  it('renames names it cannot verify, with a warning', async () => {
    const { server, reader, writer } = setup(behaviorProject([{
      eventType: 'block', sid: 100,
      conditions: [{ id: 'on-start-of-layout', objectClass: 'System', sid: 101 }],
      actions: [{ id: 'simulate-control', objectClass: 'Ghost', sid: 102, 'behavior-type': 'Platform' }],
    }]));
    // "Ghost" is registered in the project but its object type file cannot be read
    reader.listObjectTypes = async () => ['Player', 'Car', 'Ghost'];
    const data = parseResult(await server.callTool('fix_legacy_behavior_keys', { dryRun: false }));

    expect(data.totalRenamed).toBe(1);
    expect(data.sheets[0].changes[0].warning).toContain('could not be verified (object type file unreadable)');
    expect(data.message).toContain('could not be checked');
    expect((writer.callsFor('writeEntityFile')[0].args[2] as any).events[0].actions[0].behaviorType).toBe('Platform');
  });

  it('does not open the message with a zero rename count when only conflicts exist', async () => {
    const { server, writer } = setup(behaviorProject([{
      eventType: 'block', sid: 100,
      conditions: [{ id: 'is-moving', objectClass: 'Car', sid: 101, 'behavior-type': null }],
      actions: [],
    }]));
    const data = parseResult(await server.callTool('fix_legacy_behavior_keys', { dryRun: false }));

    expect(data.totalRenamed).toBe(0);
    expect(data.totalConflicts).toBe(1);
    expect(data.sheets[0].conflicts[0].reason).toContain('holds null, not a behavior name');
    expect(data.message).not.toContain('renamed');
    expect(data.message).toMatch(/^1 condition\(s\)\/action\(s\) were left untouched/);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('names unreadable sheets instead of claiming nothing was found', async () => {
    const { server, reader } = setup(behaviorProject());
    reader.listEventSheets = async () => ['MainSheet', 'Broken'];
    const data = parseResult(await server.callTool('fix_legacy_behavior_keys', {}));

    expect(data.success).toBe(true);
    expect(data.sheetsScanned).toBe(1);
    expect(data.unreadableSheets).toEqual(['Broken']);
    expect(data.message).toContain('No legacy "behavior-type" keys found in the 1 readable sheet(s).');
    expect(data.message).toContain('1 sheet(s) could not be read and were not checked: Broken.');
  });

  it('reports sheets already rewritten when a later write fails', async () => {
    const legacy = (sid: number) => ({
      name: `S${sid}`, sid,
      events: [{
        eventType: 'block', sid: sid + 1,
        conditions: [{ id: 'is-moving', objectClass: 'Car', sid: sid + 2, 'behavior-type': 'Car' }],
        actions: [],
      }],
    });
    const { server, writer } = setup({
      objects: behaviorObjects(),
      eventSheets: new Map([['SheetA', legacy(100)], ['SheetB', legacy(200)]]),
    });
    const write = writer.writeEntityFile.bind(writer);
    writer.writeEntityFile = async (category, name, data, subfolder) => {
      if (name === 'SheetB') throw new Error('disk full');
      return write(category, name, data, subfolder);
    };
    const result = await server.callTool('fix_legacy_behavior_keys', { dryRun: false });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('disk full');
    expect(result.content[0].text).toContain('Sheets already rewritten before the failure: SheetA.');
  });

  it('flags sheets whose scan hit the depth limit', async () => {
    // A legacy condition nested 55 levels deep (the scanner stops at 50)
    let deepest: Record<string, unknown> = {
      eventType: 'block', sid: 9000,
      conditions: [{ id: 'is-moving', objectClass: 'Car', sid: 9001, 'behavior-type': 'Car' }],
      actions: [],
    };
    for (let i = 0; i < 55; i++) {
      deepest = { eventType: 'group', title: `G${i}`, sid: 8000 + i, children: [deepest] };
    }
    const { server } = setup(behaviorProject([deepest]));
    const data = parseResult(await server.callTool('fix_legacy_behavior_keys', {}));

    expect(data.totalRenamed).toBe(0);
    expect(data.message).toContain('The scan stopped at its size limit in MainSheet');
  });
});

describe('fix_legacy_event_shapes', () => {
  /** A sheet with every legacy shape: two convertible, one needing a decision by hand. */
  function legacyShapes() {
    return new Map([['Sheet1', {
      name: 'Sheet1', sid: 1,
      events: [
        { eventType: 'block', sid: 10, conditions: [{ id: 'every-tick', objectClass: 'System', sid: 11 }], actions: [] },
        { eventType: 'block', sid: 20, conditions: [], actions: [{ id: 'a', objectClass: 'System', sid: 21 }], isElse: true },
        {
          eventType: 'block', sid: 30,
          conditions: [
            { id: 'is-visible', objectClass: 'Sprite1', sid: 31 },
            { id: 'is-on-screen', objectClass: 'Sprite1', sid: 32, isOr: true },
          ],
          actions: [],
        },
      ],
    }], ['Sheet2', {
      name: 'Sheet2', sid: 2,
      events: [{ eventType: 'block', sid: 40, conditions: [], actions: [], isElse: true }],
    }]]);
  }

  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('fix_legacy_event_shapes')).toBe(true);
  });

  it('defaults to a dry run that lists both flags without writing', async () => {
    const { server, writer } = setup({ eventSheets: legacyShapes() });
    const data = parseResult(await server.callTool('fix_legacy_event_shapes', {}));
    expect(data.dryRun).toBe(true);
    expect(data.totalConverted).toBe(2);
    expect(data.totalManual).toBe(1);
    expect(data.sheets[0].changes.map((c: any) => c.kind)).toEqual(['isElse', 'isOr']);
    expect(data.sheets[1].manual[0]).toMatchObject({ kind: 'isElse', path: 'events[0]', sid: 40 });
    expect(data.message).toContain('Run again with dryRun: false');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('converts the unambiguous shapes and leaves the rest', async () => {
    const { server, writer } = setup({ eventSheets: legacyShapes() });
    const data = parseResult(await server.callTool('fix_legacy_event_shapes', { dryRun: false }));
    expect(data.success).toBe(true);
    expect(data.totalConverted).toBe(2);
    // Only the sheet with convertible shapes is written (and backed up)
    const writes = writer.callsFor('writeEntityFile');
    expect(writes.map(w => w.args[1])).toEqual(['Sheet1']);
    expect(data.sheets[0].backupFile).toBeDefined();

    const events = (writes[0].args[2] as any).events;
    expect(events[1].conditions[0]).toEqual({ id: 'else', objectClass: 'System', sid: expect.any(Number) });
    expect(events[1]).not.toHaveProperty('isElse');
    expect(events[2].isOrBlock).toBe(true);
    expect(JSON.stringify(events)).not.toContain('"isOr"');
  });

  it('says which conversions can change what the game does', async () => {
    const { server } = setup({ eventSheets: legacyShapes() });
    const data = parseResult(await server.callTool('fix_legacy_event_shapes', {}));
    expect(data.totalBehaviorChanges).toBe(2);
    expect(data.sheets[0].changes.every((c: any) => c.changesBehavior === true)).toBe(true);
    expect(data.sheets[0].changes[0].detail).toMatch(/Test the event in the game/);
    expect(data.message).toContain('2 of them (else and OR blocks) can change how the event runs');
  });

  it('converts scripts stored as one string, without a behavior note', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['Sheet1', {
        name: 'Sheet1', sid: 1,
        events: [{
          eventType: 'block', sid: 10, conditions: [], actions: [{ type: 'script', script: 'a();\nb();', disabled: true }],
        }],
      }]]),
    });
    const data = parseResult(await server.callTool('fix_legacy_event_shapes', { dryRun: false }));
    expect(data.totalConverted).toBe(1);
    expect(data.totalBehaviorChanges).toBe(0);
    expect(data.message).not.toContain('change how the event runs');
    const action = (writer.callsFor('writeEntityFile')[0].args[2] as any).events[0].actions[0];
    expect(action).toEqual({ type: 'script', language: 'javascript', script: ['a();', 'b();'], disabled: true });
    expect(Object.keys(action)).toEqual(['type', 'language', 'script', 'disabled']);
  });

  it('leaves an isElse block after a triggered block for a decision by hand', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['Sheet1', {
        name: 'Sheet1', sid: 1,
        events: [
          { eventType: 'block', sid: 10, conditions: [{ id: 'on-start-of-layout', objectClass: 'System', sid: 11 }], actions: [] },
          { eventType: 'block', sid: 20, conditions: [], actions: [], isElse: true },
        ],
      }]]),
    });
    const data = parseResult(await server.callTool('fix_legacy_event_shapes', { dryRun: false }));
    expect(data.totalConverted).toBe(0);
    expect(data.sheets[0].manual[0].detail).toContain('triggered by "on-start-of-layout"');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('reports a clean project without writing', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['Sheet1', { name: 'Sheet1', sid: 1, events: [{ eventType: 'block', sid: 10, conditions: [], actions: [] }] }]]),
    });
    const data = parseResult(await server.callTool('fix_legacy_event_shapes', { dryRun: false }));
    expect(data.totalConverted).toBe(0);
    expect(data.message).toBe('No legacy event shapes found.');
    expect(data.editorNote).toBeUndefined();
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });
});

describe('event tool fixes from the #32 review', () => {
  const every = (sid: number) => ({ id: 'every-tick', objectClass: 'System', sid });
  const onStart = (sid: number) => ({ id: 'on-start-of-layout', objectClass: 'System', sid });
  const written = (writer: MockWriter) => (writer.callsFor('writeEntityFile').at(-1)!.args[2] as any).events;

  it('warns when add_event_block puts an else block after a triggered event', async () => {
    const { server, writer } = setup({
      objects: new Map([['Sprite1', { name: 'Sprite1', 'plugin-id': 'Sprite', sid: 1 }]]),
      eventSheets: new Map([['Sheet1', {
        name: 'Sheet1', sid: 2, events: [{ eventType: 'block', sid: 10, conditions: [onStart(11)], actions: [] }],
      }]]),
    });
    const data = parseResult(await server.callTool('add_event_block', {
      sheetName: 'Sheet1', isElse: true, actions: [{ id: 'set-visible', objectClass: 'Sprite1', parameters: { visibility: 'visible' } }],
    }));
    expect(data.success).toBe(true);
    const warning = data.warnings.find((w: string) => w.includes('Else block'));
    expect(warning).toContain('triggered by "on-start-of-layout"');
    expect(warning).toContain('Else can only follow normal (non-triggered) events');
    expect(writtenEvents(writer)[1].conditions[0].id).toBe('else');
  });

  it('gives else-aware advice for an else-if holding a trigger', async () => {
    const { server } = setup({
      eventSheets: new Map([['Sheet1', { name: 'Sheet1', sid: 2, events: [{ eventType: 'block', sid: 10, conditions: [every(11)], actions: [] }] }]]),
    });
    const data = parseResult(await server.callTool('add_event_block', {
      sheetName: 'Sheet1', isElse: true, conditions: [{ id: 'on-start-of-layout', objectClass: 'System' }],
    }));
    expect(data.success).toBe(true);
    expect(data.warnings).toHaveLength(1);
    expect(data.warnings[0]).toContain('holds the trigger "on-start-of-layout"');
    expect(data.warnings[0]).not.toContain('Put the trigger first');
  });

  it('warns about an else block as first sub-event, once', async () => {
    const { server } = setup({ eventSheets: new Map([['Sheet1', { name: 'Sheet1', sid: 2, events: [] }]]) });
    const data = parseResult(await server.callTool('add_event_block', {
      sheetName: 'Sheet1', conditions: [{ id: 'every-tick', objectClass: 'System' }],
      children: [{ isElse: true }, { conditions: [{ id: 'every-tick', objectClass: 'System' }] }, { isElse: true }],
    }));
    expect(data.success).toBe(true);
    expect(data.warnings.filter((w: string) => w.includes('Else block'))).toHaveLength(1);
    expect(data.warnings[0]).toContain('no event comes before it');
  });

  it('adds an else block after a block and a trailing comment without an else-placement warning', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['Sheet1', {
        name: 'Sheet1', sid: 2, events: [
          { eventType: 'block', sid: 10, conditions: [every(11)], actions: [] },
          { eventType: 'comment', text: 'otherwise' },
        ],
      }]]),
    });
    const data = parseResult(await server.callTool('add_event_block', { sheetName: 'Sheet1', isElse: true, position: 'end' }));
    expect(data.success).toBe(true);
    expect((data.warnings ?? []).filter((w: string) => w.includes('Else block'))).toEqual([]);
    expect(writtenEvents(writer).map((e: any) => e.eventType)).toEqual(['block', 'comment', 'block']);
    expect(writtenEvents(writer)[2].conditions[0].id).toBe('else');
  });

  it('warns when update_event_block makes a block after a trigger an else block', async () => {
    const { server } = setup({
      eventSheets: new Map([['Sheet1', {
        name: 'Sheet1', sid: 2,
        events: [
          { eventType: 'block', sid: 10, conditions: [onStart(11)], actions: [] },
          { eventType: 'block', sid: 20, conditions: [], actions: [] },
        ],
      }]]),
    });
    const data = parseResult(await server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 20, isElse: true }));
    expect(data.success).toBe(true);
    expect(data.warnings.filter((w: string) => w.includes('triggered by "on-start-of-layout"'))).toHaveLength(1);
  });

  it('writes a block\'s disabled right after sid, also with children and isOrBlock', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['Sheet1', {
        name: 'Sheet1', sid: 2,
        events: [{
          eventType: 'block', conditions: [every(11), every(12)], actions: [], sid: 10,
          children: [{ eventType: 'block', conditions: [], actions: [], sid: 13 }], isOrBlock: true,
        }],
      }]]),
    });
    expect(parseResult(await server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 10, disabled: true })).success).toBe(true);
    expect(Object.keys(writtenEvents(writer)[0])).toEqual(['eventType', 'conditions', 'actions', 'sid', 'disabled', 'children', 'isOrBlock']);
  });

  it('refuses parameters on comment rows and script actions, and disabling comment rows', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['Sheet1', {
        name: 'Sheet1', sid: 2,
        events: [{
          eventType: 'block', sid: 10, conditions: [every(11)],
          actions: [{ type: 'comment', text: 'note' }, { type: 'script', language: 'javascript', script: ['x();'] }],
        }],
      }]]),
    });
    const calls: Array<[string, Record<string, unknown>]> = [
      ['update_event_block_action', { blockSid: 10, actionIndex: 0, parameters: { x: '1' } }],
      ['update_event_block_action', { blockSid: 10, actionIndex: 1, parameters: { x: '1' } }],
      ['update_event_block', { sid: 10, updateActions: [{ index: 0, parameters: { x: '1' } }] }],
      ['update_event_block', { sid: 10, updateActions: [{ index: 1, parameters: { x: '1' } }] }],
      ['update_event_block', { sid: 10, updateActions: [{ index: 0, disabled: true }] }],
    ];
    for (const [tool, args] of calls) {
      const result = await server.callTool(tool, { sheetName: 'Sheet1', ...args });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/comment row|script action/);
    }
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);

    // Disabling a script action is fine: editor saves carry "disabled" on script actions
    const ok = parseResult(await server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 10, updateActions: [{ index: 1, disabled: true }] }));
    expect(ok.success).toBe(true);
    expect(writtenEvents(writer)[0].actions[1]).toEqual({ type: 'script', language: 'javascript', script: ['x();'], disabled: true });
  });

  it('handles an added else condition by where it lands', async () => {
    const sheets = () => new Map([['Sheet1', {
      name: 'Sheet1', sid: 2,
      events: [
        { eventType: 'block', sid: 10, conditions: [every(11)], actions: [] },
        { eventType: 'block', sid: 20, conditions: [], actions: [] },
        { eventType: 'block', sid: 30, conditions: [every(31)], actions: [] },
      ],
    }]]);
    const elseCond = { id: 'else', objectClass: 'System' };

    // On a block without conditions it lands first: no warning
    let ctx = setup({ eventSheets: sheets() });
    let data = parseResult(await ctx.server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 20, isElse: true, addConditions: [elseCond] }));
    expect(data.warnings).toBeUndefined();
    expect(written(ctx.writer)[1].conditions.map((c: any) => c.id)).toEqual(['else']);

    // With isElse: true on a block with conditions it would be a second one: dropped
    ctx = setup({ eventSheets: sheets() });
    data = parseResult(await ctx.server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 30, isElse: true, addConditions: [elseCond] }));
    expect(written(ctx.writer)[2].conditions.map((c: any) => c.id)).toEqual(['else', 'every-tick']);
    expect(data.warnings.some((w: string) => w.includes('dropped the added System "else" condition'))).toBe(true);

    // Otherwise it lands after the existing conditions, with a warning
    ctx = setup({ eventSheets: sheets() });
    data = parseResult(await ctx.server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 30, addConditions: [elseCond] }));
    expect(data.warnings.some((w: string) => w.includes('goes after the existing conditions'))).toBe(true);
  });

  it('writes a call with the function\'s spelling of its name in the update tools', async () => {
    const sheets = () => new Map([['Sheet1', {
      name: 'Sheet1', sid: 2,
      events: [
        {
          eventType: 'function-block', functionName: 'DoThing', sid: 5, conditions: [], actions: [],
          functionParameters: [{ name: 'p1', type: 'number', initialValue: '0', comment: '', sid: 6 }],
        },
        { eventType: 'block', sid: 10, conditions: [every(11)], actions: [{ callFunction: 'dothing', sid: 12, parameters: ['1'] }] },
      ],
    }]]);
    let ctx = setup({ eventSheets: sheets() });
    let data = parseResult(await ctx.server.callTool('update_event_block_action', { sheetName: 'Sheet1', blockSid: 10, actionIndex: 0, parameters: ['2'] }));
    expect(written(ctx.writer)[1].actions[0]).toEqual({ callFunction: 'DoThing', sid: 12, parameters: ['2'] });
    expect(data.warnings.some((w: string) => w.includes('defined as "DoThing"'))).toBe(true);
    expect(data.callFunction).toBe('DoThing');

    ctx = setup({ eventSheets: sheets() });
    data = parseResult(await ctx.server.callTool('update_event_block', {
      sheetName: 'Sheet1', sid: 10, updateActions: [{ index: 0, parameters: ['3'] }], addActions: [{ callFunction: 'DOTHING', parameters: ['4'] }],
    }));
    const actions = written(ctx.writer)[1].actions;
    expect(actions.map((a: any) => a.callFunction)).toEqual(['DoThing', 'DoThing']);
    expect(data.warnings.filter((w: string) => w.includes('defined as "DoThing"'))).toHaveLength(2);
  });
});

describe('editor load-time rules (pre-write)', () => {
  /** Keyboard + Player (Sprite) objects, both Scirra addons, and the given sheet events. */
  function setupSheet(events: unknown[], extra: Record<string, unknown> = {}) {
    return setup({
      objects: new Map([
        ['Keyboard', { name: 'Keyboard', 'plugin-id': 'Keyboard', sid: 1 }],
        ['Player', { name: 'Player', 'plugin-id': 'Sprite', sid: 2 }],
      ]),
      eventSheets: new Map([['MainSheet', { name: 'MainSheet', events, sid: 10 }]]),
      usedAddons: [
        { type: 'plugin', id: 'Keyboard', name: 'Keyboard', author: 'Scirra', bundled: false },
        { type: 'plugin', id: 'Sprite', name: 'Sprite', author: 'Scirra', bundled: false },
      ],
      ...extra,
    });
  }

  /** A top-level "On start of layout" event with one non-trigger sub-event (sid 110). */
  function triggeredParent() {
    return [{
      eventType: 'block', sid: 100,
      conditions: [{ id: 'on-start-of-layout', objectClass: 'System', sid: 101 }],
      actions: [],
      children: [{
        eventType: 'block', sid: 110,
        conditions: [{ id: 'compare-eventvar', objectClass: 'System', sid: 111 }],
        actions: [],
      }],
    }];
  }

  it('add_event_block rejects a backslash-escaped quote and writes nothing', async () => {
    const { server, writer } = setupSheet([]);
    const result = await server.callTool('add_event_block', {
      sheetName: 'MainSheet',
      conditions: [{ id: 'on-start-of-layout', objectClass: 'System' }],
      actions: [{ id: 'set-text', objectClass: 'Player', parameters: { text: '"{\\"a\\":1}"' } }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('load-time check failed');
    expect(result.content[0].text).toContain('Syntax error: Unknown character');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('add_event_block accepts a backslash inside a string literal', async () => {
    const { server } = setupSheet([]);
    const result = await server.callTool('add_event_block', {
      sheetName: 'MainSheet',
      conditions: [{ id: 'on-start-of-layout', objectClass: 'System' }],
      actions: [{ id: 'set-text', objectClass: 'Player', parameters: { text: '"C:\\folder\\" & Player.UID' } }],
    });
    expect(parseResult(result).success).toBe(true);
  });

  it('add_event_block rejects an empty parameter but accepts the empty string literal', async () => {
    const { server } = setupSheet([]);
    const bad = await server.callTool('add_event_block', {
      sheetName: 'MainSheet',
      conditions: [{ id: 'on-start-of-layout', objectClass: 'System' }],
      actions: [{ id: 'set-text', objectClass: 'Player', parameters: { text: '' } }],
    });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain('Empty expression');

    const good = await server.callTool('add_event_block', {
      sheetName: 'MainSheet',
      conditions: [{ id: 'on-start-of-layout', objectClass: 'System' }],
      actions: [{ id: 'set-text', objectClass: 'Player', parameters: { text: '""' } }],
    });
    expect(parseResult(good).success).toBe(true);
  });

  it('add_event_block checks condition parameters too', async () => {
    const { server } = setupSheet([]);
    const result = await server.callTool('add_event_block', {
      sheetName: 'MainSheet',
      conditions: [{ id: 'compare-two-values', objectClass: 'System', parameters: { 'first-value': '"unterminated', comparison: 0, 'second-value': '1' } }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('unterminated string literal');
  });

  it('add_event_block rejects two triggers in one event', async () => {
    const { server } = setupSheet([]);
    const result = await server.callTool('add_event_block', {
      sheetName: 'MainSheet',
      conditions: [
        { id: 'on-start-of-layout', objectClass: 'System' },
        { id: 'on-key-pressed', objectClass: 'Keyboard', parameters: { key: 32 } },
      ],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('cannot add another trigger to event branch');
  });

  it('add_event_block warns (does not block) when a trigger is not the first condition', async () => {
    const { server, writer } = setupSheet([]);
    const result = await server.callTool('add_event_block', {
      sheetName: 'MainSheet',
      conditions: [
        { id: 'compare-eventvar', objectClass: 'System', parameters: { variable: 'score', comparison: 0, value: '1' } },
        { id: 'on-key-pressed', objectClass: 'Keyboard', parameters: { key: 32 } },
      ],
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.warnings.some((w: string) => w.includes('must be the first condition') && w.includes('moves it to the top'))).toBe(true);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(1);
  });

  it('add_event_block writes a fake trigger (On collision) after another condition, with a warning', async () => {
    const { server } = setupSheet([]);
    const result = await server.callTool('add_event_block', {
      sheetName: 'MainSheet',
      conditions: [
        { id: 'is-overlapping-another-object', objectClass: 'Player', parameters: { object: 'Player' } },
        { id: 'on-collision-with-another-object', objectClass: 'Player', parameters: { object: 'Player' } },
      ],
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.warnings.some((w: string) => w.includes('on-collision-with-another-object'))).toBe(true);
  });

  it('add_event_block rejects two triggers in an AND block and names both ways out', async () => {
    const { server } = setupSheet([]);
    const result = await server.callTool('add_event_block', {
      sheetName: 'MainSheet',
      conditions: [
        { id: 'on-key-pressed', objectClass: 'Keyboard', parameters: { key: 32 } },
        { id: 'on-key-pressed', objectClass: 'Keyboard', parameters: { key: 38 } },
      ],
    });
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain('separate events');
    expect(text).toContain('isOrBlock: true');
  });

  it('add_event_block accepts several triggers in an OR block, also from the legacy isOr flags', async () => {
    for (const input of [
      { isOrBlock: true, second: {} },
      { second: { isOr: true } },
    ]) {
      const { server, writer } = setupSheet([]);
      const result = await server.callTool('add_event_block', {
        sheetName: 'MainSheet',
        ...(input.isOrBlock ? { isOrBlock: true } : {}),
        conditions: [
          { id: 'on-key-pressed', objectClass: 'Keyboard', parameters: { key: 32 } },
          { id: 'on-key-pressed', objectClass: 'Keyboard', parameters: { key: 38 }, ...input.second },
        ],
      });
      expect(parseResult(result).success).toBe(true);
      const block = (writer.callsFor('writeEntityFile')[0].args[2] as any).events.at(-1);
      expect(block.isOrBlock).toBe(true);
      expect(JSON.stringify(block)).not.toContain('"isOr"');
    }
  });

  it('add_event_block rejects a trigger sub-event under a trigger', async () => {
    const { server } = setupSheet([]);
    const result = await server.callTool('add_event_block', {
      sheetName: 'MainSheet',
      conditions: [{ id: 'on-start-of-layout', objectClass: 'System' }],
      children: [{ conditions: [{ id: 'on-key-pressed', objectClass: 'Keyboard', parameters: { key: 32 } }] }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('cannot add another trigger to event branch');
  });

  it('add_event_block allows a trigger sub-event under a non-trigger event', async () => {
    const { server } = setupSheet([]);
    const result = await server.callTool('add_event_block', {
      sheetName: 'MainSheet',
      conditions: [{ id: 'every-tick', objectClass: 'System' }],
      children: [{ conditions: [{ id: 'on-key-pressed', objectClass: 'Keyboard', parameters: { key: 32 } }] }],
    });
    expect(parseResult(result).success).toBe(true);
  });

  it('add_event_block only warns for third-party trigger problems', async () => {
    const { server } = setupSheet([], {
      objects: new Map([['NGIO', { name: 'NGIO', 'plugin-id': 'ppstudio_ngio', sid: 1 }]]),
      usedAddons: [{ type: 'plugin', id: 'ppstudio_ngio', name: 'NGIO', author: 'Pixel Perfect Studio', bundled: false }],
    });
    const result = await server.callTool('add_event_block', {
      sheetName: 'MainSheet',
      conditions: [
        { id: 'every-tick', objectClass: 'System' },
        { id: 'on-login-success', objectClass: 'NGIO' },
      ],
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.warnings.some((w: string) => w.includes('must be the first condition'))).toBe(true);
  });

  it('add_event_block ignores problems that already exist in the sheet', async () => {
    const { server } = setupSheet([{
      eventType: 'block', sid: 100,
      conditions: [
        { id: 'compare-eventvar', objectClass: 'System', sid: 101 },
        { id: 'on-start-of-layout', objectClass: 'System', sid: 102 },
      ],
      actions: [{ id: 'set-text', objectClass: 'Player', sid: 103, parameters: { text: '' } }],
    }]);
    const result = await server.callTool('add_event_block', {
      sheetName: 'MainSheet',
      conditions: [{ id: 'every-tick', objectClass: 'System' }],
    });
    expect(parseResult(result).success).toBe(true);
  });

  it('update_event_block rejects a trigger added to a sub-event of a triggered event', async () => {
    const { server, writer, reader } = setupSheet(triggeredParent());
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 110,
      addConditions: [{ id: 'on-key-pressed', objectClass: 'Keyboard', parameters: { key: 32 } }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('cannot add another trigger to event branch');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    // In-memory sheet restored
    const sheet = await reader.readEventSheet('MainSheet');
    const child = ((sheet.events[0] as Record<string, unknown>).children as Array<Record<string, unknown>>)[0];
    expect(child.conditions as unknown[]).toHaveLength(1);
  });

  it('update_event_block rejects a trigger added inside a function block', async () => {
    const { server } = setupSheet([{
      eventType: 'function-block', functionName: 'DoIt', sid: 100, conditions: [], actions: [],
      children: [{ eventType: 'block', sid: 110, conditions: [], actions: [] }],
    }]);
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 110,
      addConditions: [{ id: 'on-key-pressed', objectClass: 'Keyboard', parameters: { key: 32 } }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('function "DoIt"');
  });

  it('update_event_block allows another trigger in an OR block', async () => {
    const { server } = setupSheet([{
      eventType: 'block', sid: 100, isOrBlock: true,
      conditions: [{ id: 'on-start-of-layout', objectClass: 'System', sid: 101 }],
      actions: [],
    }]);
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 100,
      addConditions: [{ id: 'on-key-pressed', objectClass: 'Keyboard', parameters: { key: 32 } }],
    });
    expect(parseResult(result).success).toBe(true);
  });

  it('update_event_block rejects a bad expression in updated action parameters', async () => {
    const { server } = setupSheet([{
      eventType: 'block', sid: 100,
      conditions: [{ id: 'every-tick', objectClass: 'System', sid: 101 }],
      actions: [{ id: 'set-text', objectClass: 'Player', sid: 102, parameters: { text: '"ok"' } }],
    }]);
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 100,
      updateActions: [{ index: 0, parameters: { text: '"say \\"hi\\""' } }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('backslash outside a string literal');
  });

  it('update_event_block_action rejects an empty parameter', async () => {
    const { server, writer } = setupSheet([{
      eventType: 'block', sid: 100,
      conditions: [{ id: 'every-tick', objectClass: 'System', sid: 101 }],
      actions: [{ id: 'set-text', objectClass: 'Player', sid: 102, parameters: { text: '"ok"' } }],
    }]);
    const result = await server.callTool('update_event_block_action', {
      sheetName: 'MainSheet',
      blockSid: 100,
      actionIndex: 0,
      parameters: { text: '' },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Empty expression');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('add_event_to_sheet still writes to a sheet with pre-existing problems', async () => {
    const { server, writer } = setupSheet([{
      eventType: 'block', sid: 100,
      conditions: [
        { id: 'on-start-of-layout', objectClass: 'System', sid: 101 },
        { id: 'on-key-pressed', objectClass: 'Keyboard', sid: 102 },
      ],
      actions: [],
    }]);
    const result = await server.callTool('add_event_to_sheet', {
      sheetName: 'MainSheet',
      eventType: 'function',
      functionName: 'Helper',
    });
    expect(parseResult(result).success).toBe(true);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(1);
  });

  it('add_event_to_sheet at the start does not treat problems on SID-less events as new', async () => {
    const { server, writer } = setupSheet([{
      eventType: 'block',
      conditions: [{ id: 'every-tick', objectClass: 'System' }],
      actions: [{ id: 'set-text', objectClass: 'Player', parameters: { text: '' } }],
    }]);
    const result = await server.callTool('add_event_to_sheet', {
      sheetName: 'MainSheet',
      eventType: 'comment',
      commentText: 'Header',
      position: 'start',
    });
    expect(parseResult(result).success).toBe(true);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(1);
  });

  it('update_event_block rejects a nested trigger whose warning becomes an error', async () => {
    // Block 70 is nested under a third-party trigger (a warning). Adding a built-in
    // trigger to block 60 in between makes block 60 the branch root of block 70.
    const { server, writer } = setupSheet([{
      eventType: 'block', sid: 40,
      conditions: [{ id: 'on-login-success', objectClass: 'NGIO', sid: 41 }],
      actions: [],
      children: [{
        eventType: 'block', sid: 60, conditions: [], actions: [],
        children: [{
          eventType: 'block', sid: 70,
          conditions: [{ id: 'on-key-pressed', objectClass: 'Keyboard', sid: 71, parameters: { key: 32 } }],
          actions: [],
        }],
      }],
    }], {
      objects: new Map([
        ['Keyboard', { name: 'Keyboard', 'plugin-id': 'Keyboard', sid: 1 }],
        ['NGIO', { name: 'NGIO', 'plugin-id': 'ppstudio_ngio', sid: 3 }],
      ]),
      usedAddons: [
        { type: 'plugin', id: 'Keyboard', name: 'Keyboard', author: 'Scirra', bundled: false },
        { type: 'plugin', id: 'ppstudio_ngio', name: 'NGIO', author: 'Pixel Perfect Studio', bundled: false },
      ],
    });
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 60,
      addConditions: [{ id: 'on-start-of-layout', objectClass: 'System' }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('block (sid 70)');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('update_event_block allows removing one of several triggers (a partial fix)', async () => {
    const { server, writer } = setupSheet([{
      eventType: 'block', sid: 60,
      conditions: [
        { id: 'on-start-of-layout', objectClass: 'System', sid: 61 },
        { id: 'on-key-pressed', objectClass: 'Keyboard', sid: 62, parameters: { key: 32 } },
        { id: 'on-key-released', objectClass: 'Keyboard', sid: 63, parameters: { key: 32 } },
      ],
      actions: [],
    }]);
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 60,
      removeConditionIndices: [2],
    });
    expect(parseResult(result).success).toBe(true);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(1);
  });

  it('update_event_block rejects a trigger added inside a custom action block', async () => {
    const { server } = setupSheet([{
      eventType: 'custom-ace-block', aceType: 'action', aceName: 'Jump', objectClass: 'Player', sid: 100,
      conditions: [], actions: [],
      children: [{ eventType: 'block', sid: 110, conditions: [], actions: [] }],
    }]);
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 110,
      addConditions: [{ id: 'on-key-pressed', objectClass: 'Keyboard', parameters: { key: 32 } }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('custom action Player.Jump');
  });

  it('write tools do not crash on a malformed (null) condition already in the sheet', async () => {
    const { server } = setupSheet([{
      eventType: 'block', sid: 100,
      conditions: [null, { id: 'every-tick', objectClass: 'System', sid: 101 }],
      actions: [],
    }]);
    const added = await server.callTool('add_event_block', {
      sheetName: 'MainSheet',
      conditions: [{ id: 'every-tick', objectClass: 'System' }],
    });
    expect(parseResult(added).success).toBe(true);
    const updated = await server.callTool('add_event_to_sheet', {
      sheetName: 'MainSheet',
      eventType: 'comment',
      commentText: 'note',
    });
    expect(parseResult(updated).success).toBe(true);
  });
});

describe('move_events_between_sheets load-time gate', () => {
  /** SheetA (source) and SheetB (target) with Keyboard + Player objects from Scirra addons. */
  function setupPair(sourceEvents: unknown[], targetEvents: unknown[] = []) {
    return setup({
      objects: new Map([
        ['Keyboard', { name: 'Keyboard', 'plugin-id': 'Keyboard', sid: 1 }],
        ['Player', { name: 'Player', 'plugin-id': 'Sprite', sid: 2 }],
      ]),
      eventSheets: new Map([
        ['SheetA', { name: 'SheetA', events: sourceEvents, sid: 10 }],
        ['SheetB', { name: 'SheetB', events: targetEvents, sid: 20 }],
      ]),
      usedAddons: [
        { type: 'plugin', id: 'Keyboard', name: 'Keyboard', author: 'Scirra', bundled: false },
        { type: 'plugin', id: 'Sprite', name: 'Sprite', author: 'Scirra', bundled: false },
      ],
    });
  }

  /** A hand-written block the editor refuses to load: an empty expression parameter. */
  function brokenBlock() {
    return {
      eventType: 'block', sid: 100,
      conditions: [{ id: 'on-start-of-layout', objectClass: 'System', sid: 101 }],
      actions: [{ id: 'set-text', objectClass: 'Player', sid: 102, parameters: { text: '' } }],
    };
  }

  async function sheetJson(reader: MockReader, name: string): Promise<string> {
    return JSON.stringify(await reader.readEventSheet(name));
  }

  it('refuses to copy an event that breaks a load-time rule and leaves both sheets unchanged', async () => {
    const { server, reader, writer } = setupPair([brokenBlock()]);
    const sourceBefore = await sheetJson(reader, 'SheetA');
    const targetBefore = await sheetJson(reader, 'SheetB');

    const result = await server.callTool('move_events_between_sheets', {
      sourceSheet: 'SheetA', targetSheet: 'SheetB', sids: [100], deleteSource: false,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('load-time check failed');
    expect(result.content[0].text).toContain('Empty expression');
    expect(result.content[0].text).toContain('eventSheets/SheetB');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    expect(await sheetJson(reader, 'SheetA')).toBe(sourceBefore);
    expect(await sheetJson(reader, 'SheetB')).toBe(targetBefore);
  });

  it('refuses to copy an event with two triggers', async () => {
    const { server, writer } = setupPair([{
      eventType: 'block', sid: 100,
      conditions: [
        { id: 'on-start-of-layout', objectClass: 'System', sid: 101 },
        { id: 'on-key-pressed', objectClass: 'Keyboard', sid: 102, parameters: { key: 32 } },
      ],
      actions: [],
    }]);
    const result = await server.callTool('move_events_between_sheets', {
      sourceSheet: 'SheetA', targetSheet: 'SheetB', sids: [100],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('cannot add another trigger to event branch');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('allows moving (deleteSource) an event that already breaks a rule: the problem moves, none is added', async () => {
    const { server, writer } = setupPair([brokenBlock()]);
    const result = await server.callTool('move_events_between_sheets', {
      sourceSheet: 'SheetA', targetSheet: 'SheetB', sids: [100], deleteSource: true,
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.warnings).toBeUndefined();
    expect(writer.callsFor('writeEntityFile')).toHaveLength(2);
  });

  it('allows moving a broken sub-event without a SID into a group', async () => {
    // A SID-less event is keyed by its location, which gains the target groups;
    // the move is still only a relocation.
    const { server, writer } = setupPair(
      [{
        eventType: 'block', sid: 100,
        conditions: [{ id: 'on-start-of-layout', objectClass: 'System', sid: 101 }],
        actions: [],
        children: [{ eventType: 'block', conditions: [], actions: [{ id: 'set-text', objectClass: 'Player', parameters: { text: '' } }] }],
      }],
      [{ eventType: 'group', sid: 200, title: 'G1', children: [{ eventType: 'group', sid: 210, title: 'G2', children: [] }] }],
    );
    const result = await server.callTool('move_events_between_sheets', {
      sourceSheet: 'SheetA', targetSheet: 'SheetB', sids: [100], deleteSource: true, targetGroupPath: 'G1 > G2',
    });
    expect(parseResult(result).success).toBe(true);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(2);
  });

  it('moves a clean trigger block into nested groups without warnings', async () => {
    const { server, writer } = setupPair(
      [{
        eventType: 'block', sid: 100,
        conditions: [{ id: 'on-key-pressed', objectClass: 'Keyboard', sid: 101, parameters: { key: 32 } }],
        actions: [{ id: 'set-text', objectClass: 'Player', sid: 102, parameters: { text: '"jump"' } }],
      }],
      [{ eventType: 'group', sid: 200, title: 'G1', children: [{ eventType: 'group', sid: 210, title: 'G2', children: [] }] }],
    );
    const result = await server.callTool('move_events_between_sheets', {
      sourceSheet: 'SheetA', targetSheet: 'SheetB', sids: [100], deleteSource: true, targetGroupPath: 'G1 > G2',
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.warnings).toBeUndefined();
    const targetWrite = writer.callsFor('writeEntityFile').find((c: any) => c.args[1] === 'SheetB');
    const targetEvents = (targetWrite!.args[2] as any).events;
    expect(targetEvents[0].children[0].children[0].sid).toBe(100);
  });

  it('returns the warnings a copy adds and still writes', async () => {
    const { server, writer } = setupPair([{
      eventType: 'block', sid: 100,
      conditions: [
        { id: 'compare-eventvar', objectClass: 'System', sid: 101, parameters: { variable: 'score', comparison: 0, value: '1' } },
        { id: 'on-key-pressed', objectClass: 'Keyboard', sid: 102, parameters: { key: 32 } },
      ],
      actions: [],
    }]);
    const result = await server.callTool('move_events_between_sheets', {
      sourceSheet: 'SheetA', targetSheet: 'SheetB', sids: [100],
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.warnings).toHaveLength(1);
    expect(data.warnings[0]).toContain('eventSheets/SheetB');
    expect(data.warnings[0]).toContain('must be the first condition');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(1);
  });

  it('cannot target a group under a triggered block (group paths start at the top level)', async () => {
    const { server, writer } = setupPair(
      [{
        eventType: 'block', sid: 100,
        conditions: [{ id: 'on-key-pressed', objectClass: 'Keyboard', sid: 101, parameters: { key: 32 } }],
        actions: [],
      }],
      [{
        eventType: 'block', sid: 200,
        conditions: [{ id: 'on-start-of-layout', objectClass: 'System', sid: 201 }],
        actions: [],
        children: [{ eventType: 'group', sid: 210, title: 'G', children: [] }],
      }],
    );
    const result = await server.callTool('move_events_between_sheets', {
      sourceSheet: 'SheetA', targetSheet: 'SheetB', sids: [100], targetGroupPath: 'G',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Group path "G" not found');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });
});

// ─── Duplicate event SIDs (issue #30) ─────────────────────

describe('SID-addressed tools with duplicate event SIDs (issue #30)', () => {
  const DUP = 400000000000099;
  const cond = (sid: number, value: string) => ({
    id: 'compare-instance-variable', objectClass: 'Player', sid,
    parameters: { 'instance-variable': 'health', comparison: 0, value },
  });
  const act = (sid: number, x: string) => ({ id: 'set-x', objectClass: 'Player', sid, parameters: { x } });

  /** Groups Movement and Combat each hold a block with SID DUP (1 and 2 conditions), plus a unique block. */
  function dupSheet() {
    return {
      name: 'Sheet1', sid: 1,
      events: [
        {
          eventType: 'group', sid: 10, title: 'Movement', children: [
            { eventType: 'block', sid: DUP, conditions: [cond(101, '1')], actions: [act(102, '10')] },
          ],
        },
        {
          eventType: 'group', sid: 20, title: 'Combat', children: [
            { eventType: 'block', sid: DUP, conditions: [cond(201, '2'), cond(202, '3')], actions: [act(203, '20')] },
          ],
        },
        { eventType: 'block', sid: 300, conditions: [cond(301, '4')], actions: [act(302, '30')] },
      ],
    } as any;
  }

  function setupDup() {
    const sheet = dupSheet();
    const pristine = JSON.parse(JSON.stringify(sheet));
    const ctx = setup({ eventSheets: new Map([['Sheet1', sheet]]) });
    return { ...ctx, sheet, pristine };
  }

  function expectRefused(result: any, ctx: ReturnType<typeof setupDup>, action: string) {
    expect(result.isError).toBe(true);
    const text = result.content[0].text as string;
    expect(text).toContain(`SID ${DUP} matches 2 events in sheet "Sheet1"; refusing to guess which one to ${action}.`);
    expect(text).toContain('eventPath "events[0].children[0]": event 2, in group "Movement"');
    expect(text).toContain('eventPath "events[1].children[0]": event 4, in group "Combat"');
    expect(ctx.writer.callsFor('writeEntityFile')).toHaveLength(0);
    expect(ctx.sheet).toEqual(ctx.pristine);
  }

  const written = (writer: MockWriter, sheetName = 'Sheet1') =>
    writer.callsFor('writeEntityFile').find(c => c.args[1] === sheetName)!.args[2] as any;

  it('update_event_block refuses an ambiguous SID and lists both candidates', async () => {
    const ctx = setupDup();
    const result = await ctx.server.callTool('update_event_block', { sheetName: 'Sheet1', sid: DUP, disabled: true });
    expectRefused(result, ctx, 'update');
  });

  it('update_event_block edits the event eventPath picks', async () => {
    const { server, writer } = setupDup();
    const result = await server.callTool('update_event_block', {
      sheetName: 'Sheet1', sid: DUP, eventPath: 'events[1].children[0]', disabled: true,
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.eventPath).toBe('events[1].children[0]');
    const events = written(writer).events;
    expect(events[0].children[0].disabled).toBeUndefined();
    expect(events[1].children[0].disabled).toBe(true);
  });

  it('update_event_block_action refuses an ambiguous SID and edits the event eventPath picks', async () => {
    const ctx = setupDup();
    const refused = await ctx.server.callTool('update_event_block_action', {
      sheetName: 'Sheet1', blockSid: DUP, actionIndex: 0, parameters: { x: '99' },
    });
    expectRefused(refused, ctx, 'update');

    const result = await ctx.server.callTool('update_event_block_action', {
      sheetName: 'Sheet1', blockSid: DUP, eventPath: 'events[0].children[0]', actionIndex: 0, parameters: { x: '99' },
    });
    expect(parseResult(result).eventPath).toBe('events[0].children[0]');
    const events = written(ctx.writer).events;
    expect(events[0].children[0].actions[0].parameters).toEqual({ x: '99' });
    expect(events[1].children[0].actions[0].parameters).toEqual({ x: '20' });
  });

  it('delete_event_from_sheet refuses an ambiguous SID, with and without dryRun', async () => {
    for (const dryRun of [false, true]) {
      const ctx = setupDup();
      const result = await ctx.server.callTool('delete_event_from_sheet', { sheetName: 'Sheet1', sid: DUP, dryRun });
      expectRefused(result, ctx, 'delete');
    }
  });

  it('delete_event_from_sheet deletes only the event eventPath picks', async () => {
    const { server, writer } = setupDup();
    const preview = parseResult(await server.callTool('delete_event_from_sheet', {
      sheetName: 'Sheet1', sid: DUP, eventPath: 'events[1].children[0]', dryRun: true,
    }));
    expect(preview.action).toBe('would_delete');
    expect(preview.eventPath).toBe('events[1].children[0]');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);

    const data = parseResult(await server.callTool('delete_event_from_sheet', {
      sheetName: 'Sheet1', sid: DUP, eventPath: 'events[1].children[0]',
    }));
    expect(data.success).toBe(true);
    expect(data.eventPath).toBe('events[1].children[0]');
    const events = written(writer).events;
    expect(events[0].children).toHaveLength(1);
    expect(events[0].children[0].conditions).toHaveLength(1);
    expect(events[1].children).toHaveLength(0);
  });

  it('delete_event_from_sheet only takes eventPath together with sid', async () => {
    const { server, writer } = setupDup();
    const result = await server.callTool('delete_event_from_sheet', {
      sheetName: 'Sheet1', includeSheet: 'Other', eventPath: 'events[0]',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('pass it together with sid');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('refuses an eventPath that does not point at an event with the SID', async () => {
    const ctx = setupDup();
    for (const [eventPath, expected] of [
      ['events[0]', 'it points at a group with SID 10'],
      ['events[2]', 'it points at a block with SID 300'],
      ['events[5].children[0]', 'no event exists at that path'],
      ['events[0].children[0].actions[0]', 'is not an event path'],
    ]) {
      const result = await ctx.server.callTool('update_event_block', { sheetName: 'Sheet1', sid: DUP, eventPath, disabled: true });
      expect(result.isError, eventPath).toBe(true);
      expect(result.content[0].text).toContain(expected);
    }
    expect(ctx.writer.callsFor('writeEntityFile')).toHaveLength(0);
    expect(ctx.sheet).toEqual(ctx.pristine);
  });

  it('refuses a top-level duplicate followed by a nested one in a later group', async () => {
    const sheet = {
      name: 'Sheet1', sid: 1,
      events: [
        { eventType: 'block', sid: DUP, conditions: [cond(101, '1')], actions: [] },
        { eventType: 'group', sid: 20, title: 'Combat', children: [
          { eventType: 'block', sid: DUP, conditions: [cond(201, '2')], actions: [] },
        ] },
      ],
    };
    const { server, writer } = setup({ eventSheets: new Map([['Sheet1', sheet]]) });
    const result = await server.callTool('update_event_block', { sheetName: 'Sheet1', sid: DUP, disabled: true });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('eventPath "events[0]": event 1, top level');
    expect(result.content[0].text).toContain('eventPath "events[1].children[0]": event 3, in group "Combat"');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('keeps working without eventPath for a unique SID in the same sheet', async () => {
    const ctx = setupDup();
    const updated = parseResult(await ctx.server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 300, disabled: true }));
    expect(updated.success).toBe(true);
    expect(updated.eventPath).toBe('events[2]');
    expect(written(ctx.writer).events[2].disabled).toBe(true);

    const deleted = parseResult(await ctx.server.callTool('delete_event_from_sheet', { sheetName: 'Sheet1', sid: 300 }));
    expect(deleted.success).toBe(true);
    expect(deleted.deletedSid).toBe(300);
    const after = ctx.writer.callsFor('writeEntityFile')[1].args[2] as any;
    expect(after.events).toHaveLength(2);
    expect(after.events[0].children).toHaveLength(1);
    expect(after.events[1].children).toHaveLength(1);
  });

  it('update_event_variable refuses two variables sharing a SID and renames the one eventPath picks', async () => {
    const sheet = {
      name: 'Sheet1', sid: 1,
      events: [
        { eventType: 'variable', name: 'score', type: 'number', initialValue: '0', sid: DUP },
        { eventType: 'group', sid: 20, title: 'Combat', children: [
          { eventType: 'variable', name: 'lives', type: 'number', initialValue: '3', sid: DUP },
        ] },
      ],
    };
    const pristine = JSON.parse(JSON.stringify(sheet));
    const { server, writer } = setup({ eventSheets: new Map([['Sheet1', sheet]]) });

    const refused = await server.callTool('update_event_variable', { sheetName: 'Sheet1', sid: DUP, newName: 'total' });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('matches 2 events');
    expect(refused.content[0].text).toContain('eventPath "events[0]": variable (no event number), top level: VAR score: number = 0');
    expect(refused.content[0].text).toContain('eventPath "events[1].children[0]": variable (no event number), in group "Combat": VAR lives');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    expect(sheet).toEqual(pristine);

    // The name check tells the two apart by identity, not by their shared SID
    const clash = await server.callTool('update_event_variable', {
      sheetName: 'Sheet1', sid: DUP, eventPath: 'events[1].children[0]', newName: 'score',
    });
    expect(clash.isError).toBe(true);
    expect(clash.content[0].text).toContain('already exists');

    const renamed = parseResult(await server.callTool('update_event_variable', {
      sheetName: 'Sheet1', sid: DUP, eventPath: 'events[1].children[0]', newName: 'total',
    }));
    expect(renamed.success).toBe(true);
    expect(renamed.eventPath).toBe('events[1].children[0]');
    const events = written(writer).events;
    expect(events[0].name).toBe('score');
    expect(events[1].children[0].name).toBe('total');
  });

  describe('move_events_between_sheets', () => {
    function setupMove() {
      const source = {
        name: 'SourceSheet', sid: 1,
        events: [
          { eventType: 'block', sid: DUP, conditions: [cond(101, '1')], actions: [] },
          { eventType: 'block', sid: 200, conditions: [cond(201, '2')], actions: [] },
          { eventType: 'block', sid: DUP, conditions: [cond(301, '3'), cond(302, '4')], actions: [] },
        ],
      };
      const pristine = JSON.parse(JSON.stringify(source));
      const ctx = setup({
        eventSheets: new Map<string, any>([
          ['SourceSheet', source],
          ['TargetSheet', { name: 'TargetSheet', sid: 2, events: [] }],
        ]),
      });
      return { ...ctx, source, pristine };
    }

    it('refuses a SID shared by two top-level events and writes nothing', async () => {
      const { server, writer, source, pristine } = setupMove();
      const result = await server.callTool('move_events_between_sheets', {
        sourceSheet: 'SourceSheet', targetSheet: 'TargetSheet', sids: [DUP], deleteSource: true,
      });
      expect(result.isError).toBe(true);
      const text = result.content[0].text;
      expect(text).toContain(`SID ${DUP} matches 2 top-level events in sheet "SourceSheet"; refusing to guess which one to move.`);
      expect(text).toContain('eventPath "events[0]": event 1, top level');
      expect(text).toContain('eventPath "events[2]": event 3, top level');
      expect(text).toContain('eventPaths');
      expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
      expect(source).toEqual(pristine);
      expect(source.events).toHaveLength(3);
    });

    it('moves only the event eventPaths picks', async () => {
      const { server, writer } = setupMove();
      const data = parseResult(await server.callTool('move_events_between_sheets', {
        sourceSheet: 'SourceSheet', targetSheet: 'TargetSheet', sids: [DUP, 200], eventPaths: ['events[2]'], deleteSource: true,
      }));
      expect(data.success).toBe(true);
      expect(data.movedCount).toBe(2);
      const target = written(writer, 'TargetSheet').events;
      expect(target.map((e: any) => e.sid)).toEqual([DUP, 200]);
      expect(target[0].conditions).toHaveLength(2);
      const source = written(writer, 'SourceSheet').events;
      expect(source).toHaveLength(1);
      expect(source[0].sid).toBe(DUP);
      expect(source[0].conditions).toHaveLength(1);
    });

    it('refuses a SID listed twice', async () => {
      const { server, writer } = setupMove();
      const result = await server.callTool('move_events_between_sheets', {
        sourceSheet: 'SourceSheet', targetSheet: 'TargetSheet', sids: [200, 200],
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('sids lists SID 200 more than once');
      expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    });

    it('refuses eventPaths that are not top-level events with a listed SID', async () => {
      const { server, writer } = setupMove();
      for (const [eventPaths, expected] of [
        [['events[0].children[0]'], 'is not the path of a top-level event'],
        [['events[1]'], 'points at a block with SID 200'],
        [['events[7]'], 'points at no event'],
        [['events[0]', 'events[2]'], `names two events with SID ${DUP}`],
      ] as Array<[string[], string]>) {
        const result = await server.callTool('move_events_between_sheets', {
          sourceSheet: 'SourceSheet', targetSheet: 'TargetSheet', sids: [DUP], eventPaths, deleteSource: true,
        });
        expect(result.isError, eventPaths.join()).toBe(true);
        expect(result.content[0].text).toContain(expected);
      }
      expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    });

    it('does not count a nested event with the same SID (only top-level events move)', async () => {
      const source = {
        name: 'SourceSheet', sid: 1,
        events: [
          { eventType: 'block', sid: DUP, conditions: [cond(101, '1')], actions: [] },
          { eventType: 'group', sid: 20, title: 'Combat', children: [
            { eventType: 'block', sid: DUP, conditions: [cond(201, '2')], actions: [] },
          ] },
        ],
      };
      const { server, writer } = setup({
        eventSheets: new Map<string, any>([
          ['SourceSheet', source],
          ['TargetSheet', { name: 'TargetSheet', sid: 2, events: [] }],
        ]),
      });
      const data = parseResult(await server.callTool('move_events_between_sheets', {
        sourceSheet: 'SourceSheet', targetSheet: 'TargetSheet', sids: [DUP], deleteSource: true,
      }));
      expect(data.success).toBe(true);
      const remaining = written(writer, 'SourceSheet').events;
      expect(remaining).toHaveLength(1);
      expect(remaining[0].children).toHaveLength(1);
    });

    it('warns when copied events keep SIDs the target sheet already has, and still writes the copy', async () => {
      const source = {
        name: 'SourceSheet', sid: 1,
        events: [
          { eventType: 'block', sid: 500, conditions: [cond(501, '1')], actions: [], children: [
            { eventType: 'block', sid: 510, conditions: [cond(511, '2')], actions: [] },
          ] },
          { eventType: 'block', sid: 520, conditions: [cond(521, '3')], actions: [] },
        ],
      };
      const target = {
        name: 'TargetSheet', sid: 2,
        events: [
          { eventType: 'block', sid: 500, conditions: [cond(601, '4')], actions: [] },
          { eventType: 'group', sid: 60, title: 'Combat', children: [
            { eventType: 'block', sid: 510, conditions: [cond(611, '5')], actions: [] },
          ] },
        ],
      };
      const { server, writer } = setup({
        eventSheets: new Map<string, any>([['SourceSheet', source], ['TargetSheet', target]]),
      });
      const data = parseResult(await server.callTool('move_events_between_sheets', {
        sourceSheet: 'SourceSheet', targetSheet: 'TargetSheet', sids: [500, 520], deleteSource: true,
      }));
      expect(data.success).toBe(true);
      expect(data.warnings).toHaveLength(1);
      const warning = data.warnings[0] as string;
      expect(warning).toContain('2 SIDs of the copied events now match more than one event in "TargetSheet", because copied events keep their SIDs');
      expect(warning).toContain('SID 500 at events[0], events[2]; SID 510 at events[1].children[0], events[2].children[0].');
      expect(warning).not.toContain('SID 520');
      expect(warning).toContain('refuse these SIDs in "TargetSheet" unless eventPath names one of the events');
      expect(written(writer, 'TargetSheet').events.map((e: any) => e.sid)).toEqual([500, 60, 500, 520]);

      // As warned, the SID tools now need eventPath for that SID in the target
      const refused = await server.callTool('update_event_block', { sheetName: 'TargetSheet', sid: 500, disabled: true });
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toContain('SID 500 matches 2 events in sheet "TargetSheet"');
      const picked = parseResult(await server.callTool('update_event_block', {
        sheetName: 'TargetSheet', sid: 500, eventPath: 'events[2]', disabled: true,
      }));
      expect(picked.eventPath).toBe('events[2]');
    });

    it('warns when the same event is copied into a sheet a second time', async () => {
      const { server } = setupMove();
      const copy = () => server.callTool('move_events_between_sheets', {
        sourceSheet: 'SourceSheet', targetSheet: 'TargetSheet', sids: [200],
      });
      const first = parseResult(await copy());
      expect(first.success).toBe(true);
      expect(first.warnings).toBeUndefined();

      const second = parseResult(await copy());
      expect(second.success).toBe(true);
      expect(second.warnings).toEqual([
        'A SID of the copied events now matches more than one event in "TargetSheet", because copied events keep their SIDs: ' +
        'SID 200 at events[0], events[1]. update_event_block, update_event_block_action, update_event_variable and delete_event_from_sheet ' +
        'refuse this SID in "TargetSheet" unless eventPath names one of the events.',
      ]);
    });
  });
});

// ─── More editor shapes (#32) ────────────────────────────────

const writtenEvents = (writer: MockWriter) => (writer.callsFor('writeEntityFile').at(-1)!.args[2] as any).events;

/** One sheet "Sheet1" with the given events and an object type "Hero". */
function sheetWith(events: unknown[], extra: Record<string, unknown> = {}) {
  return setup({
    objects: new Map([['Hero', { name: 'Hero', 'plugin-id': 'Sprite', sid: 1 }]]),
    eventSheets: new Map([['Sheet1', { name: 'Sheet1', sid: 2, events }]]),
    ...extra,
  });
}

describe('built-in Functions object (#32)', () => {
  const setReturn = (value: string) => ({ id: 'set-function-return-value', objectClass: 'Functions', parameters: { value } });
  const onStart = (sid: number) => ({ id: 'on-start-of-layout', objectClass: 'System', sid });
  /** A function block that returns a number, in the editor's key order. */
  const fnBlock = (sid: number, children: unknown[] = []) => ({
    functionName: 'Twice', functionDescription: '', functionCategory: '', functionReturnType: 'number',
    functionCopyPicked: false, functionIsAsync: false,
    functionParameters: [{ name: 'n', type: 'number', initialValue: '0', comment: '', sid: sid + 1 }],
    eventType: 'function-block', conditions: [], actions: [], sid, children,
  });

  it('update_event_block adds Set return value to a function block in the editor\'s shape', async () => {
    const { server, writer } = sheetWith([fnBlock(10)]);
    const data = parseResult(await server.callTool('update_event_block', {
      sheetName: 'Sheet1', sid: 10, addActions: [setReturn('n * 2')],
    }));
    expect(data.success).toBe(true);
    expect(data.warnings).toBeUndefined();
    const action = writtenEvents(writer)[0].actions[0];
    expect(Object.keys(action)).toEqual(['id', 'objectClass', 'sid', 'parameters']);
    expect(action).toMatchObject(setReturn('n * 2'));
  });

  it('update_event_block adds it to a sub-event of a function without a warning', async () => {
    const { server } = sheetWith([fnBlock(10, [{ eventType: 'block', sid: 20, conditions: [], actions: [] }])]);
    const data = parseResult(await server.callTool('update_event_block', {
      sheetName: 'Sheet1', sid: 20, addActions: [setReturn('0')],
    }));
    expect(data.success).toBe(true);
    expect(data.warnings).toBeUndefined();
  });

  it('warns (does not refuse) when Set return value goes outside a function block', async () => {
    const { server, writer } = sheetWith([{ eventType: 'block', sid: 30, conditions: [], actions: [] }]);
    const updated = parseResult(await server.callTool('update_event_block', {
      sheetName: 'Sheet1', sid: 30, addActions: [setReturn('1')],
    }));
    expect(updated.success).toBe(true);
    expect(updated.warnings).toEqual([expect.stringContaining('is not inside a function block')]);

    const added = parseResult(await server.callTool('add_event_block', {
      sheetName: 'Sheet1', conditions: [{ id: 'every-tick', objectClass: 'System' }], actions: [setReturn('1')],
    }));
    expect(added.success).toBe(true);
    expect(added.warnings).toEqual([expect.stringContaining('is not inside a function block')]);
    expect(writtenEvents(writer).at(-1).actions[0]).toMatchObject(setReturn('1'));
  });

  it('accepts the function map actions and refuses "Functions" when the project names the object differently', async () => {
    const { server, reader } = sheetWith([fnBlock(10)]);
    const map = { id: 'map-function', objectClass: 'Functions', parameters: { name: '"ops"', string: '"twice"', function: 'Twice' } };
    const ok = parseResult(await server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 10, addActions: [map] }));
    expect(ok.success).toBe(true);

    const base = (reader as any).getProject.bind(reader);
    (reader as any).getProject = () => ({ ...base(), functionsName: 'Fn' });
    const refused = await server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 10, addActions: [setReturn('1')] });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('This project names the built-in Functions object "Fn"');
  });

  it('keeps a function registered in a function map from being deleted without force', async () => {
    resetProjectIndex();
    const { server, writer } = sheetWith([
      fnBlock(10),
      { eventType: 'block', sid: 90, conditions: [onStart(91)], actions: [
        { id: 'map-function', objectClass: 'Functions', sid: 92, parameters: { name: '"ops"', string: '"twice"', function: 'Twice' } },
      ] },
    ]);
    const data = parseResult(await server.callTool('delete_event_from_sheet', { sheetName: 'Sheet1', sid: 10 }));
    expect(data.success).toBe(false);
    expect(data.action).toBe('delete_blocked');
    expect(data.message).toContain('Function "Twice" is still referenced 1 time(s) outside the deleted events (1 function map registration(s))');
    expect(data.references.callers).toEqual([
      { function: 'Twice', via: 'function-map', sheet: 'Sheet1', path: 'block > action:0', sid: 90 },
    ]);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    resetProjectIndex();
  });

  it('writes the mapped function with its defined spelling and warns about an unknown one', async () => {
    const map = (fn: string) => ({ id: 'map-function', objectClass: 'Functions', parameters: { name: '"ops"', string: '"x"', function: fn } });
    const { server, writer } = sheetWith([fnBlock(10), { eventType: 'block', sid: 30, conditions: [onStart(31)], actions: [] }]);
    const cased = parseResult(await server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 30, addActions: [map('twice')] }));
    expect(cased.success).toBe(true);
    expect(cased.warnings).toEqual([expect.stringContaining('the function is defined as "Twice", so the function map was written with that spelling')]);
    expect(writtenEvents(writer)[1].actions[0].parameters).toEqual({ name: '"ops"', string: '"x"', function: 'Twice' });

    const unknown = parseResult(await server.callTool('add_event_block', {
      sheetName: 'Sheet1', conditions: [{ id: 'on-start-of-layout', objectClass: 'System' }], actions: [map('Nowhere')],
    }));
    expect(unknown.success).toBe(true);
    expect(unknown.warnings).toEqual([expect.stringContaining('no function block named "Nowhere" was found')]);
    expect(unknown.warnings[0]).toContain('throws "cannot find function"');
  });

  it('checks the mapped function when the parameters of a function map are updated', async () => {
    const events = () => [fnBlock(10), { eventType: 'block', sid: 30, conditions: [onStart(31)], actions: [
      { id: 'map-function', objectClass: 'Functions', sid: 32, parameters: { name: '"ops"', string: '"x"', function: 'Twice' } },
    ] }];
    const viaBlock = sheetWith(events());
    const merged = parseResult(await viaBlock.server.callTool('update_event_block', {
      sheetName: 'Sheet1', sid: 30, updateActions: [{ index: 0, parameters: { function: 'TWICE' } }],
    }));
    expect(merged.warnings).toEqual([expect.stringContaining('defined as "Twice"')]);
    expect(writtenEvents(viaBlock.writer)[1].actions[0].parameters.function).toBe('Twice');

    const viaAction = sheetWith(events());
    const replaced = parseResult(await viaAction.server.callTool('update_event_block_action', {
      sheetName: 'Sheet1', blockSid: 30, actionIndex: 0, parameters: { name: '"ops"', string: '"y"', function: 'twice' },
    }));
    expect(replaced.warnings).toEqual([expect.stringContaining('defined as "Twice"')]);
    expect(writtenEvents(viaAction.writer)[1].actions[0].parameters).toEqual({ name: '"ops"', string: '"y"', function: 'Twice' });
  });
});

describe('group paths with outer whitespace in titles (#32)', () => {
  it('add_event_block targets a group whose title has trailing whitespace', async () => {
    const { server, writer } = sheetWith([
      { eventType: 'group', disabled: false, title: 'HUD ', description: '', isActiveOnStart: true, children: [], sid: 40 },
    ]);
    for (const groupPath of ['HUD', 'HUD ']) {
      const data = parseResult(await server.callTool('add_event_block', {
        sheetName: 'Sheet1', groupPath, conditions: [{ id: 'every-tick', objectClass: 'System' }],
      }));
      expect(data.success).toBe(true);
    }
    expect(writtenEvents(writer)[0].children).toHaveLength(2);
  });

  it('refuses a group path that fits several whitespace variants, listing them', async () => {
    const { server, writer } = sheetWith([
      { eventType: 'group', title: 'HUD ', children: [], sid: 40 },
      { eventType: 'group', title: ' HUD', children: [], sid: 41 },
    ]);
    const result = await server.callTool('add_event_block', {
      sheetName: 'Sheet1', groupPath: 'HUD', conditions: [{ id: 'every-tick', objectClass: 'System' }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Group path "HUD" is ambiguous in "Sheet1"');
    expect(result.content[0].text).toContain('"HUD ", " HUD"');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('reaches a group whose title differs from a sibling\'s only by trailing whitespace', async () => {
    const { server, writer } = sheetWith([
      { eventType: 'group', title: 'HUD', children: [], sid: 30 },
      { eventType: 'group', title: 'HUD ', children: [], sid: 31 },
    ]);
    for (const groupPath of ['HUD ', 'HUD', 'HUD ']) {
      const data = parseResult(await server.callTool('add_event_block', {
        sheetName: 'Sheet1', groupPath, conditions: [{ id: 'every-tick', objectClass: 'System' }],
      }));
      expect(data.success).toBe(true);
    }
    const [plain, spaced] = writtenEvents(writer);
    expect(plain.children).toHaveLength(1);
    expect(spaced.children).toHaveLength(2);

    // Leading whitespace fits neither title as typed: refused, listing both
    const refused = await server.callTool('add_event_block', {
      sheetName: 'Sheet1', groupPath: ' HUD', conditions: [{ id: 'every-tick', objectClass: 'System' }],
    });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('"HUD", "HUD "');
  });

  it('move_events_between_sheets targets such a group too', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([
        ['SheetA', { name: 'SheetA', sid: 10, events: [{ eventType: 'block', sid: 100, conditions: [], actions: [] }] }],
        ['SheetB', { name: 'SheetB', sid: 20, events: [{ eventType: 'group', title: ' Menus', sid: 200, children: [] }] }],
      ]),
    });
    const data = parseResult(await server.callTool('move_events_between_sheets', {
      sourceSheet: 'SheetA', targetSheet: 'SheetB', sids: [100], targetGroupPath: 'Menus',
    }));
    expect(data.success).toBe(true);
    const target = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(target.events[0].children.map((e: any) => e.sid)).toEqual([100]);
  });
});

describe('condition key order (#32)', () => {
  it('writes isInverted as the last key of a condition, as the editor does', async () => {
    const { server, writer } = setup({
      objects: new Map([['Hero', { name: 'Hero', 'plugin-id': 'Sprite', sid: 1, behaviorTypes: [{ behaviorId: 'Tween', name: 'Tween', sid: 3 }] }]]),
      eventSheets: new Map([['Sheet1', { name: 'Sheet1', sid: 2, events: [] }]]),
    });
    const data = parseResult(await server.callTool('add_event_block', {
      sheetName: 'Sheet1',
      conditions: [{ isInverted: true, parameters: { tag: '"x"' }, behaviorType: 'Tween', disabled: true, id: 'is-playing', objectClass: 'Hero' }],
    }));
    expect(data.success).toBe(true);
    expect(Object.keys(writtenEvents(writer)[0].conditions[0]))
      .toEqual(['id', 'objectClass', 'sid', 'disabled', 'behaviorType', 'parameters', 'isInverted']);
  });

  it('update_event_block puts parameters added to an inverted condition before isInverted', async () => {
    const { server, writer } = sheetWith([{
      eventType: 'block', sid: 50, actions: [],
      conditions: [
        { id: 'is-visible', objectClass: 'Hero', sid: 51, isInverted: true },
        { id: 'compare-x', objectClass: 'Hero', sid: 52, parameters: { comparison: 0, 'x-co-ordinate': '0' } },
      ],
    }]);
    const data = parseResult(await server.callTool('update_event_block', {
      sheetName: 'Sheet1', sid: 50,
      updateConditions: [{ index: 0, parameters: { layer: '"HUD"' } }, { index: 1, isInverted: true }],
    }));
    expect(data.success).toBe(true);
    const [first, second] = writtenEvents(writer)[0].conditions;
    expect(Object.keys(first)).toEqual(['id', 'objectClass', 'sid', 'parameters', 'isInverted']);
    expect(Object.keys(second)).toEqual(['id', 'objectClass', 'sid', 'parameters', 'isInverted']);
  });
});

describe('delete_event_from_sheet and the load-time rules (#32)', () => {
  const every = (sid: number) => ({ id: 'every-tick', objectClass: 'System', sid });
  const onStart = (sid: number) => ({ id: 'on-start-of-layout', objectClass: 'System', sid });
  const elseCond = (sid: number) => ({ id: 'else', objectClass: 'System', sid });

  it('reports an else block the delete leaves behind, in the dry run too', async () => {
    const events = () => [
      { eventType: 'block', sid: 60, conditions: [onStart(61)], actions: [] },
      { eventType: 'block', sid: 62, conditions: [every(63)], actions: [] },
      { eventType: 'block', sid: 64, conditions: [elseCond(65)], actions: [] },
    ];
    const dry = sheetWith(events());
    const preview = parseResult(await dry.server.callTool('delete_event_from_sheet', { sheetName: 'Sheet1', sid: 62, dryRun: true }));
    expect(preview.action).toBe('would_delete');
    expect(preview.warnings).toEqual([expect.stringContaining('triggered by "on-start-of-layout"')]);
    expect(dry.writer.callsFor('writeEntityFile')).toHaveLength(0);

    const { server, writer } = sheetWith(events());
    const data = parseResult(await server.callTool('delete_event_from_sheet', { sheetName: 'Sheet1', sid: 62 }));
    expect(data.success).toBe(true);
    expect(data.warnings).toEqual([expect.stringContaining('Else block')]);
    expect(writtenEvents(writer).map((e: any) => e.sid)).toEqual([60, 64]);
  });

  it('looks past comments for the block an else belongs to', async () => {
    const events = () => [
      { eventType: 'block', sid: 60, conditions: [every(61)], actions: [] },
      { eventType: 'comment', text: 'c' },
      { eventType: 'block', sid: 64, conditions: [elseCond(65)], actions: [] },
      { eventType: 'block', sid: 66, conditions: [every(67)], actions: [] },
    ];
    // Deleting an unrelated block leaves [block, comment, else]: no warning
    const unrelated = sheetWith(events());
    const kept = parseResult(await unrelated.server.callTool('delete_event_from_sheet', { sheetName: 'Sheet1', sid: 66 }));
    expect(kept.success).toBe(true);
    expect(kept.warnings).toBeUndefined();

    // Deleting the block itself leaves [comment, else]: the else has no block
    const { server, writer } = sheetWith(events());
    const data = parseResult(await server.callTool('delete_event_from_sheet', { sheetName: 'Sheet1', sid: 60 }));
    expect(data.success).toBe(true);
    expect(data.warnings).toEqual([expect.stringContaining('no event comes before it (comments aside)')]);
    expect(writtenEvents(writer).map((e: any) => e.eventType)).toEqual(['comment', 'block', 'block']);
  });

  it('leaves the sheet as it was after a dry run', async () => {
    const { server, writer, reader } = sheetWith([
      { eventType: 'group', title: 'G', sid: 90, children: [
        { eventType: 'block', sid: 91, conditions: [every(92)], actions: [] },
        { eventType: 'block', sid: 93, conditions: [every(94)], actions: [] },
      ] },
    ]);
    const before = JSON.stringify((await reader.readEventSheet('Sheet1')).events);
    await server.callTool('delete_event_from_sheet', { sheetName: 'Sheet1', sid: 91, dryRun: true });
    expect(JSON.stringify((await reader.readEventSheet('Sheet1')).events)).toBe(before);

    const data = parseResult(await server.callTool('delete_event_from_sheet', { sheetName: 'Sheet1', sid: 93 }));
    expect(data.success).toBe(true);
    expect(writtenEvents(writer)[0].children.map((e: any) => e.sid)).toEqual([91]);
  });

  it('deletes a triggered event with its sub-events, and events next to a sheet\'s existing load-time errors', async () => {
    const { server, writer } = sheetWith([
      // A trigger nested under a trigger: a load-time error that is already in the sheet
      { eventType: 'block', sid: 70, conditions: [onStart(71)], actions: [], children: [
        { eventType: 'block', sid: 72, conditions: [onStart(73)], actions: [] },
      ] },
      { eventType: 'block', sid: 74, conditions: [every(75)], actions: [] },
      { eventType: 'block', sid: 76, conditions: [onStart(77)], actions: [], children: [
        { eventType: 'block', sid: 78, conditions: [every(79)], actions: [] },
        { eventType: 'block', sid: 80, conditions: [elseCond(81)], actions: [] },
      ] },
    ]);
    const unrelated = parseResult(await server.callTool('delete_event_from_sheet', { sheetName: 'Sheet1', sid: 74 }));
    expect(unrelated.success).toBe(true);
    expect(unrelated.warnings).toBeUndefined();

    const withChildren = parseResult(await server.callTool('delete_event_from_sheet', { sheetName: 'Sheet1', sid: 76 }));
    expect(withChildren.success).toBe(true);
    expect(withChildren.childrenRemoved).toBe(2);
    expect(withChildren.warnings).toEqual([expect.stringContaining('2 child event(s)')]);
    expect(writtenEvents(writer).map((e: any) => e.sid)).toEqual([70]);
  });
});

describe('delete_event_from_sheet and names left dangling', () => {
  const onStart = (sid: number) => ({ id: 'on-start-of-layout', objectClass: 'System', sid });
  const fn = (name: string, sid: number, extra: Record<string, unknown> = {}) => ({
    functionName: name, functionDescription: '', functionCategory: '', functionReturnType: 'none',
    functionCopyPicked: false, functionIsAsync: false, functionParameters: [],
    eventType: 'function-block', conditions: [], actions: [], sid, ...extra,
  });
  const variable = (name: string, sid: number) => ({
    eventType: 'variable', name, type: 'number', initialValue: '0', comment: '', isStatic: false, isConstant: false, sid,
  });
  const setVar = (name: string, sid: number) => ({ id: 'set-eventvar-value', objectClass: 'System', sid, parameters: { variable: name, value: '1' } });

  it('refuses to delete a group whose function is called from outside it, and deletes it with force and a warning', async () => {
    const events = () => [
      { eventType: 'group', title: 'Helpers', sid: 10, children: [fn('Reset', 11)] },
      { eventType: 'block', sid: 20, conditions: [onStart(21)], actions: [{ callFunction: 'Reset', sid: 22 }] },
    ];
    const blocked = sheetWith(events());
    const refused = parseResult(await blocked.server.callTool('delete_event_from_sheet', { sheetName: 'Sheet1', sid: 10, dryRun: true }));
    expect(refused.action).toBe('delete_blocked');
    expect(refused.message).toContain('Function "Reset" is still referenced 1 time(s) outside the deleted events (1 Call function action(s))');
    expect(refused.message).toContain('"invalid function name"');
    expect(refused.references).toEqual({ callers: [{ function: 'Reset', via: 'callFunction', sheet: 'Sheet1', path: 'block > action:0', sid: 20 }] });
    expect(blocked.writer.callsFor('writeEntityFile')).toHaveLength(0);

    const { server, writer } = sheetWith(events());
    const forced = parseResult(await server.callTool('delete_event_from_sheet', { sheetName: 'Sheet1', sid: 10, force: true }));
    expect(forced.success).toBe(true);
    expect(forced.warnings[0]).toContain('Deleted with force=true: Function "Reset" is still referenced 1 time(s)');
    expect(forced.references).toEqual({ callers: [{ function: 'Reset', via: 'callFunction', sheet: 'Sheet1', path: 'block > action:0', sid: 20 }] });
    expect(writtenEvents(writer).map((e: any) => e.sid)).toEqual([20]);
  });

  it('lists what a forced delete would leave dangling on a dry run, and writes nothing', async () => {
    const { server, writer, reader } = sheetWith([
      fn('Helper', 10),
      { eventType: 'block', sid: 20, conditions: [onStart(21)], actions: [{ callFunction: 'Helper', sid: 22, parameters: [] }] },
    ]);
    const before = JSON.stringify(await reader.readEventSheet('Sheet1'));
    const data = parseResult(await server.callTool('delete_event_from_sheet', { sheetName: 'Sheet1', sid: 10, dryRun: true, force: true }));
    expect(data).toMatchObject({ success: true, dryRun: true, action: 'would_delete', deletedFunction: 'Helper' });
    expect(data.references.callers).toHaveLength(1);
    expect(data.references.callers[0]).toMatchObject({ function: 'Helper', via: 'callFunction', path: 'block > action:0', sid: 20 });
    expect(data.warnings.some((w: string) => /Would delete with force=true: Function "Helper" is still referenced 1 time\(s\)/.test(w))).toBe(true);
    expect(data.warnings.some((w: string) => w.startsWith('Deleted'))).toBe(false);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    expect(JSON.stringify(await reader.readEventSheet('Sheet1'))).toBe(before);
  });

  it('refuses without force, also on a dry run, when the reference check stopped at its traversal limit', async () => {
    // More events than the reference scan visits (100,000 nodes), in another sheet: the
    // SID lookup walks the whole sheet it deletes from (to find shared SIDs), with the same limit
    const filler = Array.from({ length: 100_001 }, () => ({ eventType: 'comment', text: '' }));
    const { server, writer } = setup({
      eventSheets: new Map([
        ['Sheet1', { name: 'Sheet1', sid: 2, events: [variable('Unused', 10)] }],
        ['Sheet2', { name: 'Sheet2', sid: 3, events: filler }],
      ]),
    });
    const limit = 'The check for references to the deleted functions and variables stopped at its traversal limit ' +
      '(100,000 events across all event sheets), so uses further on are unknown.';
    const blocked = parseResult(await server.callTool('delete_event_from_sheet', { sheetName: 'Sheet1', sid: 10, dryRun: true }));
    expect(blocked).toMatchObject({ success: false, action: 'delete_blocked' });
    expect(blocked.message).toContain(limit);

    const forced = parseResult(await server.callTool('delete_event_from_sheet', { sheetName: 'Sheet1', sid: 10, dryRun: true, force: true }));
    expect(forced.action).toBe('would_delete');
    expect(forced.references).toBeUndefined();
    expect(forced.warnings).toEqual([`Would delete with force=true: ${limit}`]);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('names the sub-events a dry run would remove in its warnings, as the delete does', async () => {
    const { server } = sheetWith([
      { eventType: 'group', title: 'G', sid: 10, children: [
        { eventType: 'block', sid: 11, conditions: [onStart(12)], actions: [] },
      ] },
    ]);
    const data = parseResult(await server.callTool('delete_event_from_sheet', { sheetName: 'Sheet1', sid: 10, dryRun: true }));
    expect(data.childrenCount).toBe(1);
    expect(data.warnings).toEqual(['The group contains 1 child event(s) that would also be removed.']);
  });

  it('counts Functions.Name(...) expression calls, in any case, as references', async () => {
    const { server, writer } = sheetWith([
      fn('Twice', 10, { functionReturnType: 'number' }),
      { eventType: 'block', sid: 20, conditions: [
        { id: 'compare-x', objectClass: 'Hero', sid: 21, parameters: { comparison: 0, 'x-co-ordinate': 'functions.twice(2)' } },
      ], actions: [{ id: 'set-x', objectClass: 'Hero', sid: 22, parameters: { x: 'Functions.Twice(Hero.X)' } }] },
    ]);
    const data = parseResult(await server.callTool('delete_event_from_sheet', { sheetName: 'Sheet1', sid: 10 }));
    expect(data.action).toBe('delete_blocked');
    expect(data.message).toContain('Function "Twice" is still referenced 2 time(s) outside the deleted events (2 expression call(s))');
    expect(data.references.callers.map((c: any) => c.path)).toEqual(['block > condition:0', 'block > action:0']);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('protects a function that a function map names in another case', async () => {
    const { server } = sheetWith([
      fn('Mapped', 70),
      { eventType: 'block', sid: 80, conditions: [onStart(81)], actions: [
        { id: 'map-function', objectClass: 'Functions', sid: 82, parameters: { name: '"m"', string: '"x"', function: 'mapped' } },
      ] },
    ]);
    const data = parseResult(await server.callTool('delete_event_from_sheet', { sheetName: 'Sheet1', sid: 70, dryRun: true }));
    expect(data.action).toBe('delete_blocked');
    expect(data.references.callers[0]).toMatchObject({ function: 'Mapped', via: 'function-map' });
  });

  it('ignores calls inside the deleted events, e.g. a function calling itself', async () => {
    const { server } = sheetWith([
      fn('Recurse', 10, { actions: [{ callFunction: 'Recurse', sid: 12 }] }),
      { eventType: 'group', title: 'G', sid: 20, children: [
        fn('Inner', 21),
        { eventType: 'block', sid: 22, conditions: [onStart(23)], actions: [{ callFunction: 'Inner', sid: 24 }] },
      ] },
    ]);
    expect(parseResult(await server.callTool('delete_event_from_sheet', { sheetName: 'Sheet1', sid: 10 })).success).toBe(true);
    expect(parseResult(await server.callTool('delete_event_from_sheet', { sheetName: 'Sheet1', sid: 20 })).success).toBe(true);
  });

  it('refuses to delete a global variable that events in other sheets still use', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([
        ['Globals', { name: 'Globals', sid: 1, events: [variable('Score', 10), variable('Lives', 11)] }],
        ['Game', { name: 'Game', sid: 2, events: [
          { eventType: 'block', sid: 20, conditions: [
            { id: 'compare-eventvar', objectClass: 'System', sid: 21, parameters: { variable: 'score', comparison: 0, value: '0' } },
          ], actions: [setVar('Score', 22)] },
        ] }],
      ]),
    });
    const data = parseResult(await server.callTool('delete_event_from_sheet', { sheetName: 'Globals', sid: 10 }));
    expect(data.action).toBe('delete_blocked');
    expect(data.message).toContain('Event variable "Score" is still used 2 time(s) outside the deleted events (2 condition(s)/action(s) reading or setting it)');
    expect(data.message).toContain('"cannot find event variable"');
    expect(data.references).toEqual({ variableReferences: [
      { variable: 'Score', via: 'event-variable', sheet: 'Game', path: 'block > condition:0', sid: 20 },
      { variable: 'Score', via: 'event-variable', sheet: 'Game', path: 'block > action:0', sid: 20 },
    ] });
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);

    // A variable nothing uses is deleted as before
    const unused = parseResult(await server.callTool('delete_event_from_sheet', { sheetName: 'Globals', sid: 11 }));
    expect(unused.success).toBe(true);
    expect(unused.warnings).toBeUndefined();
  });

  it('refuses to delete a local variable that later events beside it use, but not one another variable of the name replaces', async () => {
    const { server } = sheetWith([
      variable('Count', 5),
      { eventType: 'group', title: 'G', sid: 10, children: [
        variable('Count', 11),
        variable('Tally', 12),
        { eventType: 'block', sid: 13, conditions: [onStart(14)], actions: [setVar('Tally', 15), setVar('Count', 16)] },
      ] },
    ]);
    const tally = parseResult(await server.callTool('delete_event_from_sheet', { sheetName: 'Sheet1', sid: 12, dryRun: true }));
    expect(tally.action).toBe('delete_blocked');
    expect(tally.references.variableReferences).toEqual([{ variable: 'Tally', via: 'event-variable', sheet: 'Sheet1', path: 'group:G > block > action:0', sid: 13 }]);

    // The global "Count" still resolves the reference once the local one is gone
    const count = parseResult(await server.callTool('delete_event_from_sheet', { sheetName: 'Sheet1', sid: 11, dryRun: true }));
    expect(count.action).toBe('would_delete');
  });

  it('refuses to delete a global variable used only by name in an expression, and deletes it with force', async () => {
    const events = () => [
      variable('Score', 10),
      { eventType: 'block', sid: 20, conditions: [onStart(21)], actions: [
        { id: 'set-x', objectClass: 'Hero', sid: 22, parameters: { x: 'Score * 2' } },
        // Names, not expressions: not uses of the variable
        { id: 'set-instvar-value', objectClass: 'Hero', sid: 23, parameters: { 'instance-variable': 'Score', value: '"Score"' } },
      ] },
    ];
    const blocked = sheetWith(events());
    const refused = parseResult(await blocked.server.callTool('delete_event_from_sheet', { sheetName: 'Sheet1', sid: 10 }));
    expect(refused.success).toBe(false);
    expect(refused.action).toBe('delete_blocked');
    expect(refused.message).toContain('Event variable "Score" is still used 1 time(s) outside the deleted events (1 expression(s) using it by name)');
    expect(refused.references.variableReferences).toEqual([
      { variable: 'Score', via: 'expression', sheet: 'Sheet1', path: 'block > action:0', sid: 20 },
    ]);
    expect(blocked.writer.callsFor('writeEntityFile')).toHaveLength(0);

    const { server, writer } = sheetWith(events());
    const forced = parseResult(await server.callTool('delete_event_from_sheet', { sheetName: 'Sheet1', sid: 10, force: true }));
    expect(forced.success).toBe(true);
    expect(forced.warnings[0]).toContain('Deleted with force=true: Event variable "Score" is still used 1 time(s)');
    expect(forced.references.variableReferences[0].via).toBe('expression');
    expect(writtenEvents(writer).map((e: any) => e.sid)).toEqual([20]);
  });
});
