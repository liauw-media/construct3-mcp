import { describe, it, expect } from 'vitest';
import { MockServer } from '../mocks/mock-server.js';
import { MockReader } from '../mocks/mock-reader.js';
import { MockWriter } from '../mocks/mock-writer.js';
import { MockIdGenerator } from '../mocks/mock-id-generator.js';
import { registerProjectTools } from '../../src/tools/project-tools.js';

function setup(readerData = {}) {
  const server = new MockServer();
  const reader = new MockReader(readerData);
  const writer = new MockWriter();
  const idGen = new MockIdGenerator();
  registerProjectTools({ server, reader, writer, idGen } as any);
  return { server, reader, writer, idGen };
}

function parseResult(result: any) {
  return JSON.parse(result.content[0].text);
}

describe('update_project_metadata', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('update_project_metadata')).toBe(true);
  });

  it('updates project name', async () => {
    const { server, writer } = setup();
    const result = await server.callTool('update_project_metadata', {
      name: 'My Game',
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.entity).toBe('project');
    expect(data.category).toBe('project');
    expect(writer.callsFor('updateProjectProperties')).toHaveLength(1);
    const updates = writer.callsFor('updateProjectProperties')[0].args[0] as Record<string, unknown>;
    expect(updates.name).toBe('My Game');
  });

  it('updates multiple properties', async () => {
    const { server, writer } = setup();
    const result = await server.callTool('update_project_metadata', {
      name: 'Cool Game',
      version: '2.0.0',
      author: 'Dev',
      description: 'A cool game',
    });
    expect(parseResult(result).success).toBe(true);
    const updates = writer.callsFor('updateProjectProperties')[0].args[0] as Record<string, unknown>;
    expect(updates.name).toBe('Cool Game');
    expect(updates.version).toBe('2.0.0');
    expect(updates.author).toBe('Dev');
    expect(updates.description).toBe('A cool game');
  });

  it('errors with no updates', async () => {
    const { server } = setup();
    const result = await server.callTool('update_project_metadata', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No updates');
  });

  it('only sends provided fields', async () => {
    const { server, writer } = setup();
    await server.callTool('update_project_metadata', { version: '1.2.3' });
    const updates = writer.callsFor('updateProjectProperties')[0].args[0] as Record<string, unknown>;
    expect(updates).toEqual({ version: '1.2.3' });
    expect(updates.name).toBeUndefined();
  });
});

// ─── list_addons ──────────────────────────────────────────

describe('list_addons', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('list_addons')).toBe(true);
  });

  it('lists all addons', async () => {
    const { server } = setup({
      usedAddons: [
        { type: 'plugin', id: 'Sprite', name: 'Sprite', author: 'Scirra', bundled: false },
        { type: 'behavior', id: 'Tween', name: 'Tween', author: 'Scirra', bundled: false },
      ],
    });
    const result = await server.callTool('list_addons', {});
    const data = JSON.parse(result.content[0].text);
    expect(data.count).toBe(2);
    expect(data.addons).toHaveLength(2);
  });

  it('filters by type', async () => {
    const { server } = setup({
      usedAddons: [
        { type: 'plugin', id: 'Sprite', name: 'Sprite', author: 'Scirra', bundled: false },
        { type: 'behavior', id: 'Tween', name: 'Tween', author: 'Scirra', bundled: false },
        { type: 'effect', id: 'hsladjust', name: 'Adjust HSL', author: 'Scirra', bundled: false },
      ],
    });
    const result = await server.callTool('list_addons', { type: 'behavior' });
    const data = JSON.parse(result.content[0].text);
    expect(data.count).toBe(1);
    expect(data.addons[0].id).toBe('Tween');
  });
});

// ─── register_addon ───────────────────────────────────────

describe('register_addon', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('register_addon')).toBe(true);
  });

  it('reports already_registered when addon exists', async () => {
    const { server } = setup({
      usedAddons: [
        { type: 'plugin', id: 'Sprite', name: 'Sprite', author: 'Scirra', bundled: false },
      ],
    });
    const result = await server.callTool('register_addon', {
      type: 'plugin',
      id: 'Sprite',
      name: 'Sprite',
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(true);
    expect(data.action).toBe('already_registered');
  });
});

// ─── unregister_addon ─────────────────────────────────────

describe('unregister_addon', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('unregister_addon')).toBe(true);
  });

  it('errors on addon not found', async () => {
    const { server } = setup({
      usedAddons: [
        { type: 'plugin', id: 'Sprite', name: 'Sprite', author: 'Scirra', bundled: false },
      ],
    });
    const result = await server.callTool('unregister_addon', {
      type: 'behavior',
      id: 'Ghost',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not registered');
  });

  it('blocks removal of known built-in without force', async () => {
    const { server } = setup({
      usedAddons: [
        { type: 'plugin', id: 'Sprite', name: 'Sprite', author: 'Scirra', bundled: false },
      ],
    });
    const result = await server.callTool('unregister_addon', {
      type: 'plugin',
      id: 'Sprite',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('force=true');
  });
});
