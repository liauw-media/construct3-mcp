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

  it('add_event_block rejects triggers combined with isOr and says what to do instead', async () => {
    const { server } = setupSheet([]);
    const result = await server.callTool('add_event_block', {
      sheetName: 'MainSheet',
      conditions: [
        { id: 'on-key-pressed', objectClass: 'Keyboard', parameters: { key: 32 } },
        { id: 'on-key-pressed', objectClass: 'Keyboard', parameters: { key: 38 }, isOr: true },
      ],
    });
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain('separate events');
    expect(text).not.toContain('"isOrBlock": true');
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
