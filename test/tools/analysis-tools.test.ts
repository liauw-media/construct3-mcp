/**
 * Tests for the find_runtime_traps analysis tool registration and handler.
 */

import { describe, it, expect } from 'vitest';
import { MockServer } from '../mocks/mock-server.js';
import { MockReader } from '../mocks/mock-reader.js';
import { registerAnalysisTools } from '../../src/tools/analysis.js';

function setup(eventSheets: Record<string, unknown[]> = {}) {
  const server = new MockServer();
  const sheets = new Map<string, Record<string, unknown>>();
  for (const [name, events] of Object.entries(eventSheets)) sheets.set(name, { name, events, sid: 1 });
  const reader = new MockReader({ eventSheets: sheets });
  registerAnalysisTools(server as any, reader as any);
  return { server, reader };
}

function parseResult(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

const waitBlock = (tag: string) => ({
  eventType: 'block',
  conditions: [],
  actions: [{ id: 'wait-for-signal', objectClass: 'System', sid: 2, parameters: { tag: `"${tag}"` } }],
  sid: 3,
});

describe('find_runtime_traps', () => {
  it('is registered with the analysis tools', () => {
    const { server } = setup();
    expect(server.hasTool('find_runtime_traps')).toBe(true);
    expect(server.getTool('find_runtime_traps')!.description).toContain('construct3://docs/pitfalls');
  });

  it('returns the analyzer result as JSON', async () => {
    const { server } = setup({ Main: [waitBlock('hit')] });
    const result = await server.callTool('find_runtime_traps', {});
    expect(result.isError).toBeUndefined();
    const data = parseResult(result);
    expect(data.summary.warning).toBe(1);
    expect(data.issues[0].check).toBe('signal-pairing');
    expect(data.signals).toBeUndefined(); // default detail is standard
  });

  it('passes the eventsheet filter and detail through', async () => {
    const { server } = setup({ Main: [waitBlock('a')], Other: [waitBlock('b')] });
    const data = parseResult(await server.callTool('find_runtime_traps', { eventsheet: 'Other', detail: 'full' }));
    expect(data.issues.map((i: { tag: string }) => i.tag)).toEqual(['b']);
    expect(data.signals).toHaveLength(2);
  });

  it('returns an error result for an unknown event sheet', async () => {
    const { server } = setup({ Main: [] });
    const result = await server.callTool('find_runtime_traps', { eventsheet: 'Missing' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Event sheet "Missing" not found');
  });
});
