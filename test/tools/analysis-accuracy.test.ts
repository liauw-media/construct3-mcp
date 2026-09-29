/**
 * What the analysis tools count on editor-saved event shapes (issue #38),
 * through the tools on a temp copy of the minimal fixture with the real
 * reader, writer and ID generator:
 * - get_function_map lists the parameters the editor saves in
 *   `functionParameters` (item 6)
 * - analyze_performance counts only the event blocks that run every tick
 *   (item 7)
 * - System "Create object (by name)" with a literal name counts as a use of
 *   the object for find_orphaned_objects, get_object_dependencies and the
 *   delete_object check, as in get_asset_usage (item 9)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, cp, rm, readFile, writeFile, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { registerMutationTools } from '../../src/tools/mutations.js';
import { registerQueryTools } from '../../src/tools/query.js';
import { registerAnalysisTools } from '../../src/tools/analysis.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

let tmpDir: string;
let server: MockServer;
let nextSid = 810000000000000;
const sid = () => ++nextSid;

async function readJson(path: string): Promise<any> {
  return JSON.parse(await readFile(join(tmpDir, path), 'utf-8'));
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await writeFile(join(tmpDir, path), JSON.stringify(data, null, '\t'));
}

/** Add an event sheet with these events to the project (file and registration). */
async function addSheet(name: string, events: unknown[]): Promise<void> {
  await writeJson(`eventSheets/${name}.json`, { name, events, sid: sid() });
  const project = await readJson('project.c3proj');
  project.eventSheets.items.push(name);
  await writeJson('project.c3proj', project);
}

/** Add a Sprite object type with one animation (file and registration). */
async function addSprite(name: string): Promise<void> {
  const frame = { width: 32, height: 32, originX: 0.5, originY: 0.5, duration: 1, imageSpriteId: 1000000 + (nextSid % 1000) };
  await writeJson(`objectTypes/${name}.json`, {
    name, 'plugin-id': 'Sprite', sid: sid(), isGlobal: false, instanceVariables: [], behaviorTypes: [], effectTypes: [],
    animations: { items: [{ name: 'Default', sid: sid(), speed: 5, isLooping: false, isPingPong: false, repeatCount: 1, repeatTo: 0, frames: [frame] }], subfolders: [] },
  });
  const project = await readJson('project.c3proj');
  project.objectTypes.items.push(name);
  await writeJson('project.c3proj', project);
}

/** Start the tools on the project as it is on disk now (the reader loads project.c3proj once). */
async function startServer(): Promise<void> {
  const reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  server = new MockServer();
  registerMutationTools(server as never, reader, new Construct3ProjectWriter(reader, idGen), idGen);
  registerQueryTools(server as never, reader);
  registerAnalysisTools(server as never, reader);
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const result = await server.callTool(name, args);
  expect(result.isError, result.content[0].text).toBeUndefined();
  return JSON.parse(result.content[0].text);
}

beforeEach(async () => {
  resetProjectIndex();
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-analysis-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
});

// ─── get_function_map (#38 item 6) ──────────────────────────

describe('get_function_map parameters', () => {
  it('lists the parameters of editor-saved function blocks and of functions add_event_to_sheet creates', async () => {
    // An editor-saved function block: the parameters are under functionParameters
    await addSheet('Functions', [{
      functionName: 'Damage', functionDescription: '', functionCategory: '', functionReturnType: 'none',
      functionCopyPicked: false, functionIsAsync: false,
      functionParameters: [
        { name: 'amount', type: 'number', initialValue: '0', comment: '', sid: sid() },
        { name: 'source', type: 'string', initialValue: '', comment: '', sid: sid() },
      ],
      eventType: 'function-block', conditions: [], actions: [], sid: sid(),
    }]);
    await startServer();
    const added = await call('add_event_to_sheet', {
      sheetName: 'MainSheet', eventType: 'function', functionName: 'Heal', functionParams: [{ name: 'hp', type: 'number' }],
    });
    expect(added.success).toBe(true);

    for (const detail of ['summary', 'standard', 'full']) {
      const map = await call('get_function_map', { detail });
      const params = Object.fromEntries(map.functions.map((f: { name: string; params: string[] }) => [f.name, f.params]));
      expect(params).toEqual({ Damage: ['amount', 'source'], Heal: ['hp'] });
    }
  });

  it('still reads the parameters of a function block that has them under "parameters" only', async () => {
    await addSheet('Old', [{
      functionName: 'Legacy', eventType: 'function-block', conditions: [], actions: [], sid: sid(),
      parameters: [{ name: 'value', type: 'number' }],
    }]);
    await startServer();

    const map = await call('get_function_map', { eventsheet: 'Old' });
    expect(map.functions).toEqual([expect.objectContaining({ name: 'Legacy', params: ['value'] })]);
  });
});
