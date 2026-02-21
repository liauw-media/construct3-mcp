import { describe, it, expect } from 'vitest';
import { MockServer } from '../mocks/mock-server.js';
import { MockReader } from '../mocks/mock-reader.js';
import { MockWriter } from '../mocks/mock-writer.js';
import { MockIdGenerator } from '../mocks/mock-id-generator.js';
import { registerEventTools } from '../../src/tools/event-tools.js';

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

  it('rejects block without conditions', async () => {
    const { server } = setup({
      eventSheets: new Map([['MainSheet', { name: 'MainSheet', events: [], sid: 10 }]]),
    });
    const result = await server.callTool('add_event_block', {
      sheetName: 'MainSheet',
      conditions: [],
      actions: [],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('At least one condition');
  });

  it('allows else block without conditions', async () => {
    const { server } = setup({
      eventSheets: new Map([['MainSheet', { name: 'MainSheet', events: [], sid: 10 }]]),
    });
    const result = await server.callTool('add_event_block', {
      sheetName: 'MainSheet',
      conditions: [],
      actions: [{ id: 'log', objectClass: 'System' }],
      isElse: true,
    });
    expect(parseResult(result).success).toBe(true);
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
