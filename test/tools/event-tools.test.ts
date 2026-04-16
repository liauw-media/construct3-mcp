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
    expect(data.warnings.some((w: string) => w.includes('unconditionally'))).toBe(true);
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
    const hasUnconditionalWarning = data.warnings?.some((w: string) => w.includes('unconditionally')) ?? false;
    expect(hasUnconditionalWarning).toBe(false);
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
