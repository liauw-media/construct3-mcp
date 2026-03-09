import { describe, it, expect } from 'vitest';
import { MockServer } from '../mocks/mock-server.js';
import { MockReader } from '../mocks/mock-reader.js';
import { MockWriter } from '../mocks/mock-writer.js';
import { MockIdGenerator } from '../mocks/mock-id-generator.js';
import { registerAnimationTools } from '../../src/tools/animation-tools.js';

function setup(readerData = {}) {
  const server = new MockServer();
  const reader = new MockReader(readerData);
  const writer = new MockWriter();
  const idGen = new MockIdGenerator();
  registerAnimationTools({ server, reader, writer, idGen } as any);
  return { server, reader, writer, idGen };
}

function parseResult(result: any) {
  return JSON.parse(result.content[0].text);
}

function makeSpriteObj(name = 'Hero') {
  return {
    name,
    'plugin-id': 'Sprite',
    sid: 1,
    isGlobal: false,
    instanceVariables: [],
    behaviorTypes: [],
    effectTypes: [],
    animations: {
      items: [{
        frames: [{ width: 100, height: 100, originX: 0.5, originY: 0.5 }],
        sid: 10,
        name: 'Animation 1',
        isLooping: false,
        isPingPong: false,
        repeatCount: 1,
        repeatTo: 0,
        speed: 0,
      }],
      subfolders: [],
    },
  };
}

describe('add_animation_to_sprite', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('add_animation_to_sprite')).toBe(true);
  });

  it('adds an animation to a Sprite', async () => {
    const { server, writer } = setup({
      objects: new Map([['Hero', makeSpriteObj()]]),
    });
    const result = await server.callTool('add_animation_to_sprite', {
      objectName: 'Hero',
      animationName: 'Walk',
      speed: 10,
      isLooping: true,
      frameCount: 4,
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.generatedSid).toBeDefined();

    // Verify the written data has 2 animations
    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const animations = writtenData.animations as Record<string, unknown>;
    const items = animations.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    expect(items[1].name).toBe('Walk');
    expect(items[1].speed).toBe(10);
    expect((items[1].frames as unknown[]).length).toBe(4);
  });

  it('writes placeholder PNGs for each frame with imageSpriteId', async () => {
    const { server, writer } = setup({
      objects: new Map([['Hero', makeSpriteObj()]]),
    });
    await server.callTool('add_animation_to_sprite', {
      objectName: 'Hero',
      animationName: 'Run',
      frameCount: 3,
    });

    // Verify writeImageFiles was called with 3 files
    const imageCalls = writer.callsFor('writeImageFiles');
    expect(imageCalls).toHaveLength(1);
    const files = imageCalls[0].args[0] as Array<Record<string, unknown>>;
    expect(files).toHaveLength(3);
    expect(files[0].objectName).toBe('Hero');
    expect(files[0].animationName).toBe('Run');
    expect(files[0].frameIndex).toBe(0);
    expect(files[1].frameIndex).toBe(1);
    expect(files[2].frameIndex).toBe(2);

    // Verify each frame in the written data has an imageSpriteId
    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const animations = writtenData.animations as Record<string, unknown>;
    const items = animations.items as Array<Record<string, unknown>>;
    const newAnim = items[1];
    const frames = newAnim.frames as Array<Record<string, unknown>>;
    for (const frame of frames) {
      expect(frame.imageSpriteId).toBeDefined();
      expect(typeof frame.imageSpriteId).toBe('number');
    }
    // Each frame should have a unique imageSpriteId
    const ids = frames.map(f => f.imageSpriteId);
    expect(new Set(ids).size).toBe(3);
  });

  it('errors on nonexistent object', async () => {
    const { server } = setup();
    const result = await server.callTool('add_animation_to_sprite', {
      objectName: 'NonExistent',
      animationName: 'Walk',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  it('errors on non-Sprite object', async () => {
    const { server } = setup({
      objects: new Map([['Label', { name: 'Label', 'plugin-id': 'Text', sid: 1 }]]),
    });
    const result = await server.callTool('add_animation_to_sprite', {
      objectName: 'Label',
      animationName: 'Walk',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not a Sprite');
  });

  it('errors on duplicate animation name', async () => {
    const { server } = setup({
      objects: new Map([['Hero', makeSpriteObj()]]),
    });
    const result = await server.callTool('add_animation_to_sprite', {
      objectName: 'Hero',
      animationName: 'Animation 1',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already exists');
  });

  it('uses existing sprite dimensions for frames by default', async () => {
    const { server, writer } = setup({
      objects: new Map([['Hero', makeSpriteObj()]]),
    });
    await server.callTool('add_animation_to_sprite', {
      objectName: 'Hero',
      animationName: 'Idle',
      frameCount: 1,
    });
    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const animations = writtenData.animations as Record<string, unknown>;
    const items = animations.items as Array<Record<string, unknown>>;
    const newAnim = items[1];
    const frames = newAnim.frames as Array<Record<string, unknown>>;
    expect(frames[0].width).toBe(100);
    expect(frames[0].height).toBe(100);
  });
});

describe('update_animation_properties', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('update_animation_properties')).toBe(true);
  });

  it('updates speed and looping', async () => {
    const { server, writer } = setup({
      objects: new Map([['Hero', makeSpriteObj()]]),
    });
    const result = await server.callTool('update_animation_properties', {
      objectName: 'Hero',
      animationName: 'Animation 1',
      speed: 15,
      isLooping: true,
    });
    expect(parseResult(result).success).toBe(true);

    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const animations = writtenData.animations as Record<string, unknown>;
    const items = animations.items as Array<Record<string, unknown>>;
    expect(items[0].speed).toBe(15);
    expect(items[0].isLooping).toBe(true);
  });

  it('errors with no updates', async () => {
    const { server } = setup({
      objects: new Map([['Hero', makeSpriteObj()]]),
    });
    const result = await server.callTool('update_animation_properties', {
      objectName: 'Hero',
      animationName: 'Animation 1',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No updates');
  });

  it('errors on nonexistent animation', async () => {
    const { server } = setup({
      objects: new Map([['Hero', makeSpriteObj()]]),
    });
    const result = await server.callTool('update_animation_properties', {
      objectName: 'Hero',
      animationName: 'NonExistent',
      speed: 5,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  it('errors on nonexistent object', async () => {
    const { server } = setup();
    const result = await server.callTool('update_animation_properties', {
      objectName: 'Ghost',
      animationName: 'Walk',
      speed: 5,
    });
    expect(result.isError).toBe(true);
  });

  it('errors on non-Sprite', async () => {
    const { server } = setup({
      objects: new Map([['Label', { name: 'Label', 'plugin-id': 'Text', sid: 1 }]]),
    });
    const result = await server.callTool('update_animation_properties', {
      objectName: 'Label',
      animationName: 'X',
      speed: 5,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not a Sprite');
  });
});
