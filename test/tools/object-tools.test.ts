import { describe, it, expect, beforeEach } from 'vitest';
import { MockServer } from '../mocks/mock-server.js';
import { MockReader } from '../mocks/mock-reader.js';
import { MockWriter } from '../mocks/mock-writer.js';
import { MockIdGenerator } from '../mocks/mock-id-generator.js';
import { registerObjectTools } from '../../src/tools/object-tools.js';

function setup(readerData = {}) {
  const server = new MockServer();
  const reader = new MockReader(readerData);
  const writer = new MockWriter();
  const idGen = new MockIdGenerator();
  registerObjectTools({ server, reader, writer, idGen } as any);
  return { server, reader, writer, idGen };
}

function parseResult(result: any) {
  return JSON.parse(result.content[0].text);
}

describe('create_object', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('create_object')).toBe(true);
  });

  it('creates a Sprite object', async () => {
    const { server, writer } = setup();
    const result = await server.callTool('create_object', { name: 'Hero', pluginId: 'Sprite' });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.entity).toBe('Hero');
    expect(data.category).toBe('object');
    expect(data.action).toBe('created');
    expect(data.generatedSid).toBeDefined();
    expect(writer.callsFor('writeEntityFile')).toHaveLength(1);
    expect(writer.callsFor('addToProject')).toHaveLength(1);
  });

  it('creates a Text object', async () => {
    const { server } = setup();
    const result = await server.callTool('create_object', { name: 'Label', pluginId: 'Text' });
    expect(parseResult(result).success).toBe(true);
  });

  it('creates a TiledBg object', async () => {
    const { server } = setup();
    const result = await server.callTool('create_object', { name: 'BG', pluginId: 'TiledBg' });
    expect(parseResult(result).success).toBe(true);
  });

  it('creates a global plugin object (Audio)', async () => {
    const { server } = setup();
    const result = await server.callTool('create_object', { name: 'Audio', pluginId: 'Audio' });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.generatedUid).toBeDefined();
  });

  it('creates a generic object', async () => {
    const { server } = setup();
    const result = await server.callTool('create_object', { name: 'Custom', pluginId: 'Particles' });
    expect(parseResult(result).success).toBe(true);
  });

  it('rejects duplicate name', async () => {
    const { server } = setup({
      objects: new Map([['Hero', { name: 'Hero', 'plugin-id': 'Sprite', sid: 1 }]]),
    });
    const result = await server.callTool('create_object', { name: 'Hero', pluginId: 'Sprite' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already exists');
  });

  it('rejects invalid name', async () => {
    const { server } = setup();
    const result = await server.callTool('create_object', { name: '123bad', pluginId: 'Sprite' });
    expect(result.isError).toBe(true);
  });

  it('rejects reserved name', async () => {
    const { server } = setup();
    const result = await server.callTool('create_object', { name: 'System', pluginId: 'Sprite' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('reserved');
  });

  it('creates with subfolder', async () => {
    const { server, writer } = setup();
    const result = await server.callTool('create_object', { name: 'Button', pluginId: 'Sprite', subfolder: 'UI/Buttons' });
    expect(parseResult(result).success).toBe(true);
    const writeCall = writer.callsFor('writeEntityFile')[0];
    expect(writeCall.args[3]).toBe('UI/Buttons');
  });
});

describe('update_object_properties', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('update_object_properties')).toBe(true);
  });

  it('adds a variable', async () => {
    const { server, writer } = setup({
      objects: new Map([['Player', {
        name: 'Player', 'plugin-id': 'Sprite', sid: 1,
        instanceVariables: [], behaviorTypes: [],
      }]]),
    });
    const result = await server.callTool('update_object_properties', {
      name: 'Player',
      addVariables: [{ name: 'health', type: 'number' }],
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    // Check the written data contains the variable
    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const vars = writtenData.instanceVariables as Array<Record<string, unknown>>;
    expect(vars).toHaveLength(1);
    expect(vars[0].name).toBe('health');
  });

  it('adds a behavior', async () => {
    const { server, writer } = setup({
      objects: new Map([['Player', {
        name: 'Player', 'plugin-id': 'Sprite', sid: 1,
        instanceVariables: [], behaviorTypes: [],
      }]]),
    });
    const result = await server.callTool('update_object_properties', {
      name: 'Player',
      addBehaviors: [{ behaviorId: 'Platform', name: 'Platform' }],
    });
    expect(parseResult(result).success).toBe(true);
    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const behaviors = writtenData.behaviorTypes as Array<Record<string, unknown>>;
    expect(behaviors).toHaveLength(1);
    expect(behaviors[0].behaviorId).toBe('Platform');
  });

  it('warns on duplicate variable', async () => {
    const { server } = setup({
      objects: new Map([['Player', {
        name: 'Player', 'plugin-id': 'Sprite', sid: 1,
        instanceVariables: [{ name: 'health', type: 'number', sid: 10 }],
      }]]),
    });
    const result = await server.callTool('update_object_properties', {
      name: 'Player',
      addVariables: [{ name: 'health', type: 'number' }],
    });
    const data = parseResult(result);
    expect(data.warnings).toBeDefined();
    expect(data.warnings[0]).toContain('already exists');
  });

  it('errors on nonexistent object', async () => {
    const { server } = setup();
    const result = await server.callTool('update_object_properties', { name: 'Ghost' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  it('removes a variable', async () => {
    const { server, writer } = setup({
      objects: new Map([['Player', {
        name: 'Player', 'plugin-id': 'Sprite', sid: 1,
        instanceVariables: [{ name: 'health', type: 'number', sid: 10 }],
      }]]),
    });
    const result = await server.callTool('update_object_properties', {
      name: 'Player',
      removeVariables: ['health'],
    });
    expect(parseResult(result).success).toBe(true);
    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    expect(writtenData.instanceVariables).toEqual([]);
  });
});

describe('delete_object', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('delete_object')).toBe(true);
  });

  it('errors on nonexistent object', async () => {
    const { server } = setup();
    const result = await server.callTool('delete_object', { name: 'Ghost' });
    expect(result.isError).toBe(true);
  });
});
