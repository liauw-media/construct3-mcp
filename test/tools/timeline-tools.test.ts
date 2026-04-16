import { describe, it, expect } from 'vitest';
import { MockServer } from '../mocks/mock-server.js';
import { MockReader } from '../mocks/mock-reader.js';
import { MockWriter } from '../mocks/mock-writer.js';
import { MockIdGenerator } from '../mocks/mock-id-generator.js';
import { registerTimelineTools } from '../../src/tools/timeline-tools.js';

function setup(readerData: Record<string, unknown> = {}) {
  const server = new MockServer();
  const reader = new MockReader(readerData);
  const writer = new MockWriter();
  const idGen = new MockIdGenerator();
  registerTimelineTools({ server, reader, writer, idGen } as any);
  return { server, reader, writer, idGen };
}

function parseResult(result: any) {
  return JSON.parse(result.content[0].text);
}

// ─── list_timelines ───────────────────────────────────────

describe('list_timelines', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('list_timelines')).toBe(true);
  });

  it('returns empty list when no timelines', async () => {
    const { server } = setup();
    const result = await server.callTool('list_timelines', {});
    const data = parseResult(result);
    expect(data.timelines).toEqual([]);
    expect(data.count).toBe(0);
  });

  it('lists timelines from project root', async () => {
    // Override getProject to return timelines
    const server = new MockServer();
    const reader = new MockReader();
    // Patch getProject to include timelines
    const origGetProject = reader.getProject.bind(reader);
    (reader as any).getProject = () => ({
      ...origGetProject(),
      timelines: { items: ['Timeline 1', 'reelStop'], subfolders: [] },
    });
    const writer = new MockWriter();
    const idGen = new MockIdGenerator();
    registerTimelineTools({ server, reader, writer, idGen } as any);

    const result = await server.callTool('list_timelines', {});
    const data = parseResult(result);
    expect(data.count).toBe(2);
    expect(data.timelines).toContain('Timeline 1');
    expect(data.timelines).toContain('reelStop');
  });

  it('lists timelines from subfolders too', async () => {
    const server = new MockServer();
    const reader = new MockReader();
    const origGetProject = reader.getProject.bind(reader);
    (reader as any).getProject = () => ({
      ...origGetProject(),
      timelines: {
        items: ['Timeline 1'],
        subfolders: [{ name: 'transitions', items: ['inback', 'reelStop'], subfolders: [] }],
      },
    });
    const writer = new MockWriter();
    const idGen = new MockIdGenerator();
    registerTimelineTools({ server, reader, writer, idGen } as any);

    const result = await server.callTool('list_timelines', {});
    const data = parseResult(result);
    expect(data.count).toBe(3);
    expect(data.timelines).toContain('inback');
  });
});

// ─── get_timeline_details ─────────────────────────────────

describe('get_timeline_details', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('get_timeline_details')).toBe(true);
  });

  it('errors when timeline not in project', async () => {
    const { server } = setup();
    const result = await server.callTool('get_timeline_details', { name: 'Ghost' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('"Ghost" not found');
  });
});

// ─── create_timeline ──────────────────────────────────────

describe('create_timeline', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('create_timeline')).toBe(true);
  });

  it('rejects duplicate timeline name', async () => {
    const server = new MockServer();
    const reader = new MockReader();
    const origGetProject = reader.getProject.bind(reader);
    (reader as any).getProject = () => ({
      ...origGetProject(),
      timelines: { items: ['Timeline 1'], subfolders: [] },
    });
    const writer = new MockWriter();
    const idGen = new MockIdGenerator();
    registerTimelineTools({ server, reader, writer, idGen } as any);

    const result = await server.callTool('create_timeline', { name: 'Timeline 1' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already exists');
  });
});

// ─── update_timeline ──────────────────────────────────────

describe('update_timeline', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('update_timeline')).toBe(true);
  });

  it('errors with no updates', async () => {
    const server = new MockServer();
    const reader = new MockReader();
    const origGetProject = reader.getProject.bind(reader);
    (reader as any).getProject = () => ({
      ...origGetProject(),
      timelines: { items: ['Timeline 1'], subfolders: [] },
    });
    const writer = new MockWriter();
    const idGen = new MockIdGenerator();
    registerTimelineTools({ server, reader, writer, idGen } as any);

    const result = await server.callTool('update_timeline', { name: 'Timeline 1' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No updates');
  });

  it('errors when timeline not found', async () => {
    const { server } = setup();
    const result = await server.callTool('update_timeline', {
      name: 'Ghost',
      totalTime: 10,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('"Ghost" not found');
  });
});

// ─── delete_timeline ──────────────────────────────────────

describe('delete_timeline', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('delete_timeline')).toBe(true);
  });

  it('errors when timeline not found', async () => {
    const { server } = setup();
    const result = await server.callTool('delete_timeline', { name: 'Ghost' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('"Ghost" not found');
  });
});
