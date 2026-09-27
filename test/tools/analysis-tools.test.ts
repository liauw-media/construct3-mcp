/**
 * Tests for the find_runtime_traps and get_asset_usage analysis tool registration and handlers.
 */

import { describe, it, expect } from 'vitest';
import { MockServer } from '../mocks/mock-server.js';
import { MockReader } from '../mocks/mock-reader.js';
import { registerAnalysisTools } from '../../src/tools/analysis.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';

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

describe('get_asset_usage', () => {
  it('returns statuses for sprite images and sounds as JSON', async () => {
    resetProjectIndex();
    const server = new MockServer();
    const reader = new MockReader({
      objects: new Map<string, Record<string, unknown>>([
        ['Audio', { name: 'Audio', 'plugin-id': 'Audio', sid: 1 }],
        ['Knight', {
          name: 'Knight', 'plugin-id': 'Sprite', sid: 2,
          animations: { items: [], subfolders: [{ name: 'Moves', items: [{ name: 'Run', sid: 3, frames: [{ sid: 4 }, { sid: 5 }] }], subfolders: [] }] },
        }],
      ]),
      eventSheets: new Map([['Sound', { name: 'Sound', sid: 6, events: [
        { eventType: 'block', sid: 7, conditions: [], actions: [{ id: 'play', objectClass: 'Audio', sid: 8, parameters: { 'audio-file': 'jump' } }] },
      ] }]]),
      files: [{ folder: 'sound', path: 'jump.webm' }, { folder: 'sound', path: 'spare.webm' }],
    });
    registerAnalysisTools(server as any, reader as any);
    const data = parseResult(await server.callTool('get_asset_usage', { detail: 'full' }));
    expect(data.summary).toMatchObject({ totalAssets: 3, byType: { image: 1, sound: 2 }, usedCount: 1, unusedCount: 2, notAnalysedCount: 0 });
    const byName = Object.fromEntries(data.assets.map((a: { name: string }) => [a.name, a]));
    expect(byName['Knight']).toMatchObject({ type: 'image', status: 'unused', animations: 1, frames: 2 });
    expect(byName['jump.webm']).toMatchObject({ status: 'used', via: ['audio-file'] });
    expect(byName['spare.webm'].status).toBe('unused');
  });
});

describe('get_function_map', () => {
  it('counts calls, expression calls and function map registrations, matching names ignoring case', async () => {
    resetProjectIndex();
    const fn = (name: string, sid: number) => ({ functionName: name, functionParameters: [], eventType: 'function-block', conditions: [], actions: [], sid });
    const { server } = setup({
      Main: [
        fn('Twice', 10),
        fn('Mapped', 11),
        fn('Unused', 12),
        { eventType: 'block', sid: 20, conditions: [
          { id: 'compare-x', objectClass: 'Sprite', sid: 21, parameters: { comparison: 0, 'x-co-ordinate': 'functions.twice(1)' } },
        ], actions: [
          { callFunction: 'twice', sid: 22, parameters: ['Functions.Twice(2)'] },
          { id: 'map-function', objectClass: 'Functions', sid: 23, parameters: { name: '"m"', string: '"a"', function: 'mapped' } },
        ] },
      ],
    });
    const data = parseResult(await server.callTool('get_function_map', { detail: 'full' }));
    const twice = data.functions.find((f: { name: string }) => f.name === 'Twice');
    expect(twice.callCount).toBe(3);
    expect(twice.callSites.map((c: { via: string; path: string }) => [c.via, c.path])).toEqual([
      ['expression', 'block > condition:0'],
      ['callFunction', 'block > action:0'],
      ['expression', 'block > action:0'],
    ]);
    expect(data.functions.find((f: { name: string }) => f.name === 'Mapped').callSites).toEqual([
      { sheet: 'Main', path: 'block > action:1', via: 'function-map' },
    ]);
    expect(data.summary.uncalledFunctions).toEqual(['Unused']);
    expect(data.summary.totalCallSites).toBe(4);
    resetProjectIndex();
  });
});
