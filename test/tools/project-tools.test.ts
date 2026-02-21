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
