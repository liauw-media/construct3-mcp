import { describe, it, expect } from 'vitest';
import { MockServer } from '../mocks/mock-server.js';
import { MockReader } from '../mocks/mock-reader.js';
import { MockWriter } from '../mocks/mock-writer.js';
import { MockIdGenerator } from '../mocks/mock-id-generator.js';
import { registerLayoutTools } from '../../src/tools/layout-tools.js';

function setup(readerData = {}) {
  const server = new MockServer();
  const reader = new MockReader(readerData);
  const writer = new MockWriter();
  const idGen = new MockIdGenerator();
  registerLayoutTools({ server, reader, writer, idGen } as any);
  return { server, reader, writer, idGen };
}

function parseResult(result: any) {
  return JSON.parse(result.content[0].text);
}

describe('create_layout', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('create_layout')).toBe(true);
  });

  it('creates a layout with defaults', async () => {
    const { server, writer } = setup();
    const result = await server.callTool('create_layout', { name: 'Level 1' });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.entity).toBe('Level 1');
    expect(data.category).toBe('layout');
    expect(data.generatedSid).toBeDefined();
    expect(writer.callsFor('writeEntityFile')).toHaveLength(1);
    expect(writer.callsFor('addToProject')).toHaveLength(1);
  });

  it('creates a layout with custom dimensions', async () => {
    const { server, writer } = setup();
    const result = await server.callTool('create_layout', {
      name: 'SmallLevel',
      width: 800,
      height: 600,
    });
    expect(parseResult(result).success).toBe(true);
    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    expect(writtenData.width).toBe(800);
    expect(writtenData.height).toBe(600);
  });

  it('creates layout with event sheet binding', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['LevelSheet', { name: 'LevelSheet', events: [], sid: 1 }]]),
    });
    const result = await server.callTool('create_layout', {
      name: 'Level 1',
      eventSheet: 'LevelSheet',
    });
    expect(parseResult(result).success).toBe(true);
    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    expect(writtenData.eventSheet).toBe('LevelSheet');
  });

  it('creates layout with custom layers', async () => {
    const { server, writer } = setup();
    const result = await server.callTool('create_layout', {
      name: 'Level 1',
      layers: ['Background', 'Main', 'UI'],
    });
    expect(parseResult(result).success).toBe(true);
    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const layers = writtenData.layers as Array<Record<string, unknown>>;
    expect(layers).toHaveLength(3);
    expect(layers[0].name).toBe('Background');
    expect(layers[1].name).toBe('Main');
    expect(layers[2].name).toBe('UI');
  });

  it('rejects duplicate name', async () => {
    const { server } = setup({
      layouts: new Map([['Level 1', { name: 'Level 1', layers: [], sid: 1 }]]),
    });
    const result = await server.callTool('create_layout', { name: 'Level 1' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already exists');
  });

  it('rejects nonexistent event sheet', async () => {
    const { server } = setup();
    const result = await server.callTool('create_layout', {
      name: 'Level 1',
      eventSheet: 'NonExistent',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('does not exist');
  });
});

describe('add_instance_to_layout', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('add_instance_to_layout')).toBe(true);
  });

  it('places a Sprite instance on a layer', async () => {
    const { server, writer } = setup({
      objects: new Map([['Player', {
        name: 'Player', 'plugin-id': 'Sprite', sid: 1,
        isGlobal: false, instanceVariables: [], behaviorTypes: [],
      }]]),
      layouts: new Map([['Level 1', {
        name: 'Level 1', sid: 10,
        layers: [{ name: 'Main', sid: 20, instances: [] }],
        'nonworld-instances': [],
      }]]),
    });
    const result = await server.callTool('add_instance_to_layout', {
      layoutName: 'Level 1',
      layerName: 'Main',
      objectType: 'Player',
      x: 100, y: 200,
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.generatedUid).toBeDefined();
    expect(data.generatedSid).toBeDefined();
  });

  it('errors on nonexistent object', async () => {
    const { server } = setup({
      layouts: new Map([['Level 1', {
        name: 'Level 1', sid: 10,
        layers: [{ name: 'Main', sid: 20, instances: [] }],
        'nonworld-instances': [],
      }]]),
    });
    const result = await server.callTool('add_instance_to_layout', {
      layoutName: 'Level 1',
      layerName: 'Main',
      objectType: 'NonExistent',
      x: 0, y: 0,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('does not exist');
  });

  it('errors on nonexistent layout', async () => {
    const { server } = setup({
      objects: new Map([['Player', { name: 'Player', 'plugin-id': 'Sprite', sid: 1 }]]),
    });
    const result = await server.callTool('add_instance_to_layout', {
      layoutName: 'NonExistent',
      layerName: 'Main',
      objectType: 'Player',
      x: 0, y: 0,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  it('errors on nonexistent layer', async () => {
    const { server } = setup({
      objects: new Map([['Player', {
        name: 'Player', 'plugin-id': 'Sprite', sid: 1,
        isGlobal: false,
      }]]),
      layouts: new Map([['Level 1', {
        name: 'Level 1', sid: 10,
        layers: [{ name: 'Main', sid: 20, instances: [] }],
        'nonworld-instances': [],
      }]]),
    });
    const result = await server.callTool('add_instance_to_layout', {
      layoutName: 'Level 1',
      layerName: 'BadLayer',
      objectType: 'Player',
      x: 0, y: 0,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  it('blocks singleglobal-inst objects', async () => {
    const { server } = setup({
      objects: new Map([['Audio', {
        name: 'Audio', 'plugin-id': 'Audio', sid: 1,
        'singleglobal-inst': { type: 'Audio', properties: {}, uid: 1, sid: 2 },
      }]]),
      layouts: new Map([['Level 1', {
        name: 'Level 1', sid: 10,
        layers: [{ name: 'Main', sid: 20, instances: [] }],
        'nonworld-instances': [],
      }]]),
    });
    const result = await server.callTool('add_instance_to_layout', {
      layoutName: 'Level 1',
      layerName: 'Main',
      objectType: 'Audio',
      x: 0, y: 0,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('global plugin');
  });

  it('places nonworld-global object in nonworld-instances', async () => {
    const { server } = setup({
      objects: new Map([['GameData', {
        name: 'GameData', 'plugin-id': 'Json', sid: 1,
        isGlobal: true,
      }]]),
      layouts: new Map([['Level 1', {
        name: 'Level 1', sid: 10,
        layers: [{ name: 'Main', sid: 20, instances: [] }],
        'nonworld-instances': [],
      }]]),
    });
    const result = await server.callTool('add_instance_to_layout', {
      layoutName: 'Level 1',
      layerName: 'Main',
      objectType: 'GameData',
      x: 0, y: 0,
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.warnings).toBeDefined();
    expect(data.warnings[0]).toContain('nonworld');
  });

  it('creates instance with angle, color, zElevation', async () => {
    const { server, writer } = setup({
      objects: new Map([['Player', {
        name: 'Player', 'plugin-id': 'Sprite', sid: 1,
        isGlobal: false, instanceVariables: [], behaviorTypes: [],
      }]]),
      layouts: new Map([['Level 1', {
        name: 'Level 1', sid: 10,
        layers: [{ name: 'Main', sid: 20, instances: [] }],
        'nonworld-instances': [],
      }]]),
    });
    const result = await server.callTool('add_instance_to_layout', {
      layoutName: 'Level 1',
      layerName: 'Main',
      objectType: 'Player',
      x: 100, y: 200,
      angle: 1.57,
      color: [1, 0, 0, 0.5],
      zElevation: 10,
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    const writtenLayout = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const layers = writtenLayout.layers as Array<Record<string, unknown>>;
    const instance = (layers[0].instances as Array<Record<string, unknown>>)[0];
    const world = instance.world as Record<string, unknown>;
    expect(world.angle).toBe(1.57);
    expect(world.color).toEqual([1, 0, 0, 0.5]);
    expect(world.zElevation).toBe(10);
  });

  it('creates instance with instanceVariables and behaviors', async () => {
    const { server, writer } = setup({
      objects: new Map([['Player', {
        name: 'Player', 'plugin-id': 'Sprite', sid: 1,
        isGlobal: false,
        instanceVariables: [{ name: 'health', type: 'number', sid: 2 }],
        behaviorTypes: [{ behaviorId: 'Platform', name: 'Platform', sid: 3 }],
      }]]),
      layouts: new Map([['Level 1', {
        name: 'Level 1', sid: 10,
        layers: [{ name: 'Main', sid: 20, instances: [] }],
        'nonworld-instances': [],
      }]]),
    });
    const result = await server.callTool('add_instance_to_layout', {
      layoutName: 'Level 1',
      layerName: 'Main',
      objectType: 'Player',
      x: 0, y: 0,
      instanceVariables: { health: 100 },
      behaviors: { Platform: { maxSpeed: 300 } },
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    const writtenLayout = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const layers = writtenLayout.layers as Array<Record<string, unknown>>;
    const instance = (layers[0].instances as Array<Record<string, unknown>>)[0];
    expect(instance.instanceVariables).toEqual({ health: 100 });
    expect(instance.behaviors).toEqual({ Platform: { maxSpeed: 300 } });
  });

  it('creates instance with tags, showing=false, locked=true', async () => {
    const { server, writer } = setup({
      objects: new Map([['Player', {
        name: 'Player', 'plugin-id': 'Sprite', sid: 1,
        isGlobal: false, instanceVariables: [], behaviorTypes: [],
      }]]),
      layouts: new Map([['Level 1', {
        name: 'Level 1', sid: 10,
        layers: [{ name: 'Main', sid: 20, instances: [] }],
        'nonworld-instances': [],
      }]]),
    });
    const result = await server.callTool('add_instance_to_layout', {
      layoutName: 'Level 1',
      layerName: 'Main',
      objectType: 'Player',
      x: 0, y: 0,
      tags: 'enemy, boss',
      showing: false,
      locked: true,
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    const writtenLayout = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const layers = writtenLayout.layers as Array<Record<string, unknown>>;
    const instance = (layers[0].instances as Array<Record<string, unknown>>)[0];
    expect(instance.tags).toBe('enemy, boss');
    expect(instance.showing).toBe(false);
    expect(instance.locked).toBe(true);
  });

  it('creates instance with originX and originY overrides', async () => {
    const { server, writer } = setup({
      objects: new Map([['Player', {
        name: 'Player', 'plugin-id': 'Sprite', sid: 1,
        isGlobal: false, instanceVariables: [], behaviorTypes: [],
      }]]),
      layouts: new Map([['Level 1', {
        name: 'Level 1', sid: 10,
        layers: [{ name: 'Main', sid: 20, instances: [] }],
        'nonworld-instances': [],
      }]]),
    });
    const result = await server.callTool('add_instance_to_layout', {
      layoutName: 'Level 1',
      layerName: 'Main',
      objectType: 'Player',
      x: 0, y: 0,
      originX: 0,
      originY: 1,
    });
    expect(parseResult(result).success).toBe(true);
    const writtenLayout = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const layers = writtenLayout.layers as Array<Record<string, unknown>>;
    const instance = (layers[0].instances as Array<Record<string, unknown>>)[0];
    const world = instance.world as Record<string, unknown>;
    expect(world.originX).toBe(0);
    expect(world.originY).toBe(1);
  });

  it('warns on unknown instanceVariable key', async () => {
    const { server } = setup({
      objects: new Map([['Player', {
        name: 'Player', 'plugin-id': 'Sprite', sid: 1,
        isGlobal: false,
        instanceVariables: [{ name: 'health', type: 'number', sid: 2 }],
        behaviorTypes: [],
      }]]),
      layouts: new Map([['Level 1', {
        name: 'Level 1', sid: 10,
        layers: [{ name: 'Main', sid: 20, instances: [] }],
        'nonworld-instances': [],
      }]]),
    });
    const result = await server.callTool('add_instance_to_layout', {
      layoutName: 'Level 1',
      layerName: 'Main',
      objectType: 'Player',
      x: 0, y: 0,
      instanceVariables: { unknownVar: 42 },
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.warnings).toBeDefined();
    expect(data.warnings.some((w: string) => w.includes('unknownVar'))).toBe(true);
  });

  it('warns on unknown behavior key', async () => {
    const { server } = setup({
      objects: new Map([['Player', {
        name: 'Player', 'plugin-id': 'Sprite', sid: 1,
        isGlobal: false,
        instanceVariables: [],
        behaviorTypes: [{ behaviorId: 'Platform', name: 'Platform', sid: 3 }],
      }]]),
      layouts: new Map([['Level 1', {
        name: 'Level 1', sid: 10,
        layers: [{ name: 'Main', sid: 20, instances: [] }],
        'nonworld-instances': [],
      }]]),
    });
    const result = await server.callTool('add_instance_to_layout', {
      layoutName: 'Level 1',
      layerName: 'Main',
      objectType: 'Player',
      x: 0, y: 0,
      behaviors: { NonExistentBehavior: { speed: 10 } },
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.warnings).toBeDefined();
    expect(data.warnings.some((w: string) => w.includes('NonExistentBehavior'))).toBe(true);
  });

  it('preserves showing and locked on nonworld instances', async () => {
    const { server, writer } = setup({
      objects: new Map([['GameData', {
        name: 'GameData', 'plugin-id': 'Json', sid: 1,
        isGlobal: true,
      }]]),
      layouts: new Map([['Level 1', {
        name: 'Level 1', sid: 10,
        layers: [{ name: 'Main', sid: 20, instances: [] }],
        'nonworld-instances': [],
      }]]),
    });
    const result = await server.callTool('add_instance_to_layout', {
      layoutName: 'Level 1',
      layerName: 'Main',
      objectType: 'GameData',
      x: 0, y: 0,
      showing: false,
      locked: true,
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);

    const writtenLayout = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const nonworld = writtenLayout['nonworld-instances'] as Array<Record<string, unknown>>;
    expect(nonworld[0].showing).toBe(false);
    expect(nonworld[0].locked).toBe(true);
  });
});

describe('delete_layout', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('delete_layout')).toBe(true);
  });

  it('errors on nonexistent layout', async () => {
    const { server } = setup();
    const result = await server.callTool('delete_layout', { name: 'NonExistent' });
    expect(result.isError).toBe(true);
  });

  it('blocks deletion of startup layout', async () => {
    const { server } = setup({
      layouts: new Map([['Layout 1', { name: 'Layout 1', layers: [], sid: 1 }]]),
      metadata: { firstLayout: 'Layout 1' },
    });
    const result = await server.callTool('delete_layout', { name: 'Layout 1' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('startup layout');
  });
});

describe('update_layout', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('update_layout')).toBe(true);
  });

  it('errors with no updates', async () => {
    const { server } = setup({
      layouts: new Map([['Level 1', { name: 'Level 1', layers: [], sid: 1 }]]),
    });
    const result = await server.callTool('update_layout', { name: 'Level 1' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No updates');
  });

  it('updates dimensions', async () => {
    const { server, writer } = setup({
      layouts: new Map([['Level 1', { name: 'Level 1', layers: [], sid: 1, width: 1920, height: 1080 }]]),
    });
    const result = await server.callTool('update_layout', {
      name: 'Level 1',
      width: 3840,
      height: 2160,
    });
    expect(parseResult(result).success).toBe(true);
    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    expect(writtenData.width).toBe(3840);
    expect(writtenData.height).toBe(2160);
  });

  it('updates event sheet binding', async () => {
    const { server, writer } = setup({
      layouts: new Map([['Level 1', { name: 'Level 1', layers: [], sid: 1 }]]),
      eventSheets: new Map([['NewSheet', { name: 'NewSheet', events: [], sid: 2 }]]),
    });
    const result = await server.callTool('update_layout', {
      name: 'Level 1',
      eventSheet: 'NewSheet',
    });
    expect(parseResult(result).success).toBe(true);
    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    expect(writtenData.eventSheet).toBe('NewSheet');
  });

  it('rejects nonexistent event sheet', async () => {
    const { server } = setup({
      layouts: new Map([['Level 1', { name: 'Level 1', layers: [], sid: 1 }]]),
    });
    const result = await server.callTool('update_layout', {
      name: 'Level 1',
      eventSheet: 'NonExistent',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('does not exist');
  });

  it('errors on nonexistent layout', async () => {
    const { server } = setup();
    const result = await server.callTool('update_layout', {
      name: 'NonExistent',
      width: 800,
    });
    expect(result.isError).toBe(true);
  });
});
