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

  it('Sprite creation writes placeholder PNG and sets imageSpriteId', async () => {
    const { server, writer } = setup();
    await server.callTool('create_object', { name: 'Hero', pluginId: 'Sprite' });

    // Verify image file was written
    const imageCalls = writer.callsFor('writeImageFiles');
    expect(imageCalls).toHaveLength(1);
    const files = imageCalls[0].args[0] as Array<Record<string, unknown>>;
    expect(files).toHaveLength(1);
    expect(files[0].objectName).toBe('Hero');
    expect(files[0].animationName).toBe('Animation 1');
    expect(files[0].frameIndex).toBe(0);

    // Verify the written object data has imageSpriteId
    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const animations = writtenData.animations as Record<string, unknown>;
    const items = animations.items as Array<Record<string, unknown>>;
    const frames = items[0].frames as Array<Record<string, unknown>>;
    expect(frames[0].imageSpriteId).toBeDefined();
    expect(typeof frames[0].imageSpriteId).toBe('number');
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

  it('TiledBg creation writes placeholder PNG and sets imageSpriteId', async () => {
    const { server, writer } = setup();
    await server.callTool('create_object', { name: 'BG', pluginId: 'TiledBg' });

    // Verify image file was written
    const imageCalls = writer.callsFor('writeImageFiles');
    expect(imageCalls).toHaveLength(1);
    const files = imageCalls[0].args[0] as Array<Record<string, unknown>>;
    expect(files).toHaveLength(1);
    expect(files[0].objectName).toBe('BG');
    expect(files[0].pluginId).toBe('TiledBg');

    // Verify the written object data has imageSpriteId on the image field
    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const image = writtenData.image as Record<string, unknown>;
    expect(image.imageSpriteId).toBeDefined();
    expect(typeof image.imageSpriteId).toBe('number');
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

  it('errors with no updates', async () => {
    const { server } = setup({
      objects: new Map([['Player', {
        name: 'Player', 'plugin-id': 'Sprite', sid: 1,
        instanceVariables: [], behaviorTypes: [],
      }]]),
    });
    const result = await server.callTool('update_object_properties', { name: 'Player' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No updates');
  });

  it('errors on nonexistent object', async () => {
    const { server } = setup();
    const result = await server.callTool('update_object_properties', {
      name: 'Ghost',
      addVariables: [{ name: 'x', type: 'number' }],
    });
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

  it('adding behavior syncs layout instances', async () => {
    const { server, reader, writer } = setup({
      objects: new Map([['Player', {
        name: 'Player', 'plugin-id': 'Sprite', sid: 1,
        instanceVariables: [], behaviorTypes: [],
      }]]),
    });
    // Add a layout with a Player instance that lacks behaviors/instanceVariables
    reader.addLayout('Level1', {
      name: 'Level1',
      layers: [{
        name: 'Main',
        sid: 100,
        instances: [{
          type: 'Player',
          uid: 0,
          sid: 200,
          properties: {},
          world: { x: 0, y: 0, width: 64, height: 64 },
        }],
      }],
      sid: 300,
    });

    const result = await server.callTool('update_object_properties', {
      name: 'Player',
      addBehaviors: [{ behaviorId: 'Platform', name: 'Platform' }],
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);

    // Should have written the objectType AND the layout
    const entityWrites = writer.callsFor('writeEntityFile');
    expect(entityWrites).toHaveLength(2);
    expect(entityWrites[0].args[0]).toBe('objectTypes');
    expect(entityWrites[1].args[0]).toBe('layouts');
    expect(entityWrites[1].args[1]).toBe('Level1');

    // The layout data should have behaviors and instanceVariables on the instance
    const layoutData = entityWrites[1].args[2] as Record<string, unknown>;
    const layers = (layoutData as any).layers as Array<{ instances: Array<Record<string, unknown>> }>;
    expect(layers[0].instances[0].behaviors).toEqual({});
    expect(layers[0].instances[0].instanceVariables).toEqual({});
  });

  it('adding behavior skips layout sync when no instances exist', async () => {
    const { server, writer } = setup({
      objects: new Map([['Player', {
        name: 'Player', 'plugin-id': 'Sprite', sid: 1,
        instanceVariables: [], behaviorTypes: [],
      }]]),
    });

    const result = await server.callTool('update_object_properties', {
      name: 'Player',
      addBehaviors: [{ behaviorId: 'Tween', name: 'Tween' }],
    });
    expect(parseResult(result).success).toBe(true);

    // Only the objectType file should be written (no layouts)
    const entityWrites = writer.callsFor('writeEntityFile');
    expect(entityWrites).toHaveLength(1);
    expect(entityWrites[0].args[0]).toBe('objectTypes');
  });

  it('adding behavior does not overwrite existing instance behaviors', async () => {
    const { server, writer, reader } = setup({
      objects: new Map([['Player', {
        name: 'Player', 'plugin-id': 'Sprite', sid: 1,
        instanceVariables: [], behaviorTypes: [],
      }]]),
    });
    reader.addLayout('Level1', {
      name: 'Level1',
      layers: [{
        name: 'Main',
        sid: 100,
        instances: [{
          type: 'Player',
          uid: 0,
          sid: 200,
          properties: {},
          behaviors: { Tween: { enabled: true } },
          instanceVariables: { health: 100 },
          world: { x: 0, y: 0, width: 64, height: 64 },
        }],
      }],
      sid: 300,
    });

    await server.callTool('update_object_properties', {
      name: 'Player',
      addBehaviors: [{ behaviorId: 'Platform', name: 'Platform' }],
    });

    // Layout should NOT be rewritten since it already has behaviors/instanceVariables
    const entityWrites = writer.callsFor('writeEntityFile');
    expect(entityWrites).toHaveLength(1);
    expect(entityWrites[0].args[0]).toBe('objectTypes');
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
