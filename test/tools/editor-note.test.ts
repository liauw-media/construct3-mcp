/**
 * Every successful mutation response carries the editor reload note
 * (EDITOR_RELOAD_NOTE as `editorNote`); read-only results, dry runs,
 * blocked deletes, no-ops and errors do not.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, cp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { MockReader } from '../mocks/mock-reader.js';
import { MockWriter } from '../mocks/mock-writer.js';
import { MockIdGenerator } from '../mocks/mock-id-generator.js';
import { EDITOR_RELOAD_NOTE } from '../../src/tools/shared.js';
import { registerObjectTools } from '../../src/tools/object-tools.js';
import { registerEventTools } from '../../src/tools/event-tools.js';
import { registerLayoutTools } from '../../src/tools/layout-tools.js';
import { registerAnimationTools } from '../../src/tools/animation-tools.js';
import { registerProjectTools } from '../../src/tools/project-tools.js';
import { registerTimelineTools } from '../../src/tools/timeline-tools.js';
import { registerRuntimeTools } from '../../src/tools/runtime-tools.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';

type ToolResponse = { content: Array<{ type: string; text: string }>; isError?: boolean };

const sprite = {
  name: 'Hero',
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

const layout = {
  name: 'Level 1',
  sid: 1,
  layers: [
    { name: 'Layer 0', sid: 2, instances: [{ uid: 1, type: 'Hero' }], effectTypes: [] },
    { name: 'HUD', sid: 3, instances: [], effectTypes: [] },
  ],
  'nonworld-instances': [],
  effectTypes: [],
  width: 1920,
  height: 1080,
};

const sheet = {
  name: 'MainSheet',
  sid: 1,
  events: [{ eventType: 'block', sid: 100, conditions: [], actions: [] }],
};

/** All mutation domains on mock deps (no filesystem I/O). */
function mockServer(): MockServer {
  const server = new MockServer();
  const reader = new MockReader({
    objects: new Map([['Hero', structuredClone(sprite)]]),
    layouts: new Map([['Level 1', structuredClone(layout)]]),
    eventSheets: new Map([['MainSheet', structuredClone(sheet)]]),
  });
  const deps = { server, reader, writer: new MockWriter(), idGen: new MockIdGenerator() } as never;
  registerObjectTools(deps);
  registerEventTools(deps);
  registerLayoutTools(deps);
  registerAnimationTools(deps);
  registerProjectTools(deps);
  registerTimelineTools(deps);
  return server;
}

function payload(result: ToolResponse): Record<string, unknown> {
  expect(result.isError).toBeUndefined();
  return JSON.parse(result.content[0].text);
}

describe('editor reload note — mutation responses', () => {
  it('is short and asks to close and reopen the project (not the script-only reload)', () => {
    expect(EDITOR_RELOAD_NOTE.length).toBeLessThan(140);
    expect(EDITOR_RELOAD_NOTE).toMatch(/close and reopen/i);
    expect(EDITOR_RELOAD_NOTE).not.toMatch(/reload/i);
  });

  it.each([
    ['create_object', { name: 'Enemy', pluginId: 'Sprite' }],
    ['create_event_sheet', { name: 'Menu' }],
    ['add_event_block', { sheetName: 'MainSheet', conditions: [{ id: 'on-start-of-layout', objectClass: 'System' }] }],
    ['create_layout', { name: 'Level 2' }],
    ['add_layer', { layoutName: 'Level 1', layerName: 'Effects' }],
    ['delete_layer', { layoutName: 'Level 1', layerName: 'HUD' }],
    ['add_animation_to_sprite', { objectName: 'Hero', animationName: 'Walk' }],
    ['update_project_metadata', { name: 'Renamed' }],
  ])('%s success includes the note', async (tool, args) => {
    const data = payload(await mockServer().callTool(tool, args));
    expect(data.success).toBe(true);
    expect(data.editorNote).toBe(EDITOR_RELOAD_NOTE);
  });

  it.each([
    ['list_addons', {}],
    ['list_timelines', {}],
  ])('read-only %s has no note', async (tool, args) => {
    expect(payload(await mockServer().callTool(tool, args)).editorNote).toBeUndefined();
  });

  it('dry run has no note', async () => {
    const data = payload(await mockServer().callTool('delete_event_from_sheet', { sheetName: 'MainSheet', sid: 100, dryRun: true }));
    expect(data.dryRun).toBe(true);
    expect(data.editorNote).toBeUndefined();
  });

  it('blocked delete has no note', async () => {
    const data = payload(await mockServer().callTool('delete_layer', { layoutName: 'Level 1', layerName: 'Layer 0' }));
    expect(data.action).toBe('delete_blocked');
    expect(data.editorNote).toBeUndefined();
  });

  it('no-op register_addon reports success but has no note', async () => {
    const data = payload(await mockServer().callTool('register_addon', { type: 'plugin', id: 'Sprite', name: 'Sprite' }));
    expect(data.success).toBe(true);
    expect(data.action).toBe('already_registered');
    expect(data.editorNote).toBeUndefined();
  });

  it('fix_legacy_behavior_keys has the note only when it rewrote a sheet', async () => {
    // Nothing to rename: success, but no sheet was written
    const clean = payload(await mockServer().callTool('fix_legacy_behavior_keys', { dryRun: false }));
    expect(clean.success).toBe(true);
    expect(clean.totalRenamed).toBe(0);
    expect(clean.editorNote).toBeUndefined();

    const server = new MockServer();
    const reader = new MockReader({
      objects: new Map([['Hero', { ...structuredClone(sprite), behaviorTypes: [{ behaviorId: 'Flash', name: 'Flash', sid: 20 }] }]]),
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet',
        sid: 1,
        events: [{
          eventType: 'block', sid: 100, conditions: [],
          actions: [{ id: 'flash', objectClass: 'Hero', sid: 101, 'behavior-type': 'Flash' }],
        }],
      }]]),
    });
    registerEventTools({ server, reader, writer: new MockWriter(), idGen: new MockIdGenerator() } as never);

    const dry = payload(await server.callTool('fix_legacy_behavior_keys', {}));
    expect(dry.totalRenamed).toBe(1);
    expect(dry.editorNote).toBeUndefined();

    const fixed = payload(await server.callTool('fix_legacy_behavior_keys', { dryRun: false }));
    expect(fixed.totalRenamed).toBe(1);
    expect(fixed.editorNote).toBe(EDITOR_RELOAD_NOTE);
  });

  it('error responses have no note', async () => {
    const result = await mockServer().callTool('create_object', { name: 'Hero', pluginId: 'Sprite' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain(EDITOR_RELOAD_NOTE);
  });
});

describe('editor reload note — runtime tools on a real project', () => {
  let dir: string;
  let outDir: string;

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  });

  async function runtimeServer(): Promise<MockServer> {
    dir = await mkdtemp(join(tmpdir(), 'c3-note-'));
    outDir = await mkdtemp(join(tmpdir(), 'c3-note-out-'));
    await cp(join(__dirname, '..', 'fixtures', 'minimal-project'), dir, { recursive: true });
    const reader = new Construct3ProjectReader(join(dir, 'project.c3proj'));
    await reader.loadProject();
    const idGen = new IdGenerator();
    const server = new MockServer();
    registerRuntimeTools({ server, reader, writer: new Construct3ProjectWriter(reader, idGen) } as never);
    return server;
  }

  it('bridge injection and removal include the note', async () => {
    const server = await runtimeServer();
    for (const [tool, args] of [
      ['inject_runtime_bridge', {}],
      ['inject_runtime_bridge', {}], // already registered: the script is still rewritten
      ['export_for_preview', { injectBridge: true }],
      ['pack_project', { outputPath: join(outDir, 'with-bridge.c3p'), injectBridge: true }],
      ['remove_runtime_bridge', {}],
    ] as const) {
      const data = payload(await server.callTool(tool, args));
      expect(data.success, tool).toBe(true);
      expect(data.editorNote, tool).toBe(EDITOR_RELOAD_NOTE);
    }
  });

  it('tools that leave the project untouched report success without the note', async () => {
    const server = await runtimeServer();
    expect(payload(await server.callTool('get_bridge_commands', {})).editorNote).toBeUndefined();
    for (const [tool, args] of [
      ['export_for_preview', { injectBridge: false }],
      ['pack_project', { outputPath: join(outDir, 'out.c3p'), injectBridge: false }],
      ['clone_project', { targetDir: join(outDir, 'clone'), includeBridge: true }],
    ] as const) {
      const data = payload(await server.callTool(tool, args));
      expect(data.success, tool).toBe(true);
      expect(data.editorNote, tool).toBeUndefined();
    }
  });
});
