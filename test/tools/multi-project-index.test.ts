/**
 * Two projects open in one process (issue #38, point 14): each project keeps
 * its own cross-reference index. Before, one module-wide index served every
 * reader, so validate_project reported the other project's objects as missing
 * and delete_object deleted an object the project uses. Runs the real reader,
 * writer and tool handlers on two copies of the minimal fixture: A as it is
 * (object "Sprite"), B with the object renamed to "Enemy" in its object file,
 * the layout instance and the event.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, cp, readFile, rename, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { getProjectIndex, resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { registerAnalysisTools } from '../../src/tools/analysis.js';
import { registerMutationTools } from '../../src/tools/mutations.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

interface OpenProject {
  dir: string;
  reader: Construct3ProjectReader;
  server: MockServer;
  call: (tool: string, args?: Record<string, unknown>) => Promise<Record<string, any>>;
}

let root: string;
let dirA: string;
let dirB: string;

async function editJson(file: string, edit: (data: Record<string, any>) => void): Promise<void> {
  const data = JSON.parse(await readFile(file, 'utf-8'));
  edit(data);
  await writeFile(file, JSON.stringify(data, null, '\t'));
}

/** A fresh reader, writer and ID generator on the project, with the tools registered on their own server. */
async function open(dir: string): Promise<OpenProject> {
  const reader = new Construct3ProjectReader(join(dir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  const writer = new Construct3ProjectWriter(reader, idGen);
  const server = new MockServer();
  registerAnalysisTools(server as any, reader);
  registerMutationTools(server as any, reader, writer, idGen);
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    const result = await server.callTool(tool, args);
    expect(result.isError, `${tool}: ${result.content[0].text}`).toBeFalsy();
    return JSON.parse(result.content[0].text);
  };
  return { dir, reader, server, call };
}

const brokenReferences = (validation: Record<string, any>) =>
  [...(validation.errors ?? []), ...(validation.warnings ?? [])].filter(i => i.check === 'broken-object-reference');

beforeEach(async () => {
  resetProjectIndex();
  root = await mkdtemp(join(tmpdir(), 'c3-multi-project-'));
  dirA = join(root, 'A');
  dirB = join(root, 'B');
  await cp(FIXTURE_DIR, dirA, { recursive: true });
  await cp(FIXTURE_DIR, dirB, { recursive: true });
  // B: the object is called Enemy (object file, project bar, layout instance, event)
  await editJson(join(dirB, 'project.c3proj'), p => {
    p.name = 'ProjectB';
    p.objectTypes.items = ['Enemy'];
  });
  await rename(join(dirB, 'objectTypes', 'Sprite.json'), join(dirB, 'objectTypes', 'Enemy.json'));
  await editJson(join(dirB, 'objectTypes', 'Enemy.json'), o => { o.name = 'Enemy'; });
  await editJson(join(dirB, 'layouts', 'Layout 1.json'), l => { l.layers[0].instances[0].type = 'Enemy'; });
  await editJson(join(dirB, 'eventSheets', 'MainSheet.json'), s => { s.events[0].actions[0].objectClass = 'Enemy'; });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('two projects in one process', () => {
  it('validate_project reports the same for each project, whichever was validated first', async () => {
    const first = { A: await open(dirA), B: await open(dirB) };
    const aThenB = { A: await first.A.call('validate_project'), B: await first.B.call('validate_project') };
    const second = { B: await open(dirB), A: await open(dirA) };
    const bThenA = { B: await second.B.call('validate_project'), A: await second.A.call('validate_project') };

    expect(brokenReferences(aThenB.A)).toEqual([]);
    expect(brokenReferences(aThenB.B)).toEqual([]);
    expect(aThenB.A.summary.warnings).toBe(0);
    expect(aThenB.B.summary.warnings).toBe(0);
    expect(bThenA.A).toEqual(aThenB.A);
    expect(bThenA.B).toEqual(aThenB.B);
  });

  it('delete_object refuses an object project B uses after project A built its index, and the other way round', async () => {
    const a = await open(dirA);
    const b = await open(dirB);
    await a.call('find_orphaned_objects');

    const blockedB = await b.call('delete_object', { name: 'Enemy' });
    expect(blockedB.success).toBe(false);
    expect(blockedB.action).toBe('delete_blocked');
    expect(existsSync(join(dirB, 'objectTypes', 'Enemy.json'))).toBe(true);
    expect(await b.reader.listObjectTypes()).toEqual(['Enemy']);

    // B's index is built now; A still sees its own uses
    const blockedA = await a.call('delete_object', { name: 'Sprite' });
    expect(blockedA.success).toBe(false);
    expect(blockedA.action).toBe('delete_blocked');
    expect(existsSync(join(dirA, 'objectTypes', 'Sprite.json'))).toBe(true);
  });

  it('a write in one project resets only that project\'s index', async () => {
    const a = await open(dirA);
    const b = await open(dirB);
    const indexA = await getProjectIndex(a.reader);
    const indexB = await getProjectIndex(b.reader);
    expect(indexA.allObjects).toEqual(['Sprite']);
    expect(indexB.allObjects).toEqual(['Enemy']);

    // Through the writer (create_object) and through an event tool (add_event_to_sheet)
    await a.call('create_object', { name: 'Coin', pluginId: 'Sprite' });
    expect(await getProjectIndex(b.reader)).toBe(indexB);
    await a.call('add_event_to_sheet', { sheetName: 'MainSheet', eventType: 'function', functionName: 'Collect' });
    expect(await getProjectIndex(b.reader)).toBe(indexB);

    const rebuiltA = await getProjectIndex(a.reader);
    expect(rebuiltA).not.toBe(indexA);
    expect(rebuiltA.allObjects.sort()).toEqual(['Coin', 'Sprite']);
    expect(rebuiltA.functionDefinitions.has('Collect')).toBe(true);

    // B's index is untouched and still B's
    expect(indexB.allObjects).toEqual(['Enemy']);
    expect(indexB.functionDefinitions.size).toBe(0);
    expect((await b.call('find_orphaned_objects')).orphanedObjects).toEqual([]);
    expect((await b.call('delete_object', { name: 'Enemy' })).action).toBe('delete_blocked');

    // A's new object is not placed or used anywhere in A
    const orphansA = (await a.call('find_orphaned_objects')).orphanedObjects;
    expect(orphansA.map((o: Record<string, any>) => o.name)).toEqual(['Coin']);
  });

  it('resetProjectIndex resets one project\'s index with a reader, every project\'s without', async () => {
    const a = await open(dirA);
    const b = await open(dirB);
    const indexA = await getProjectIndex(a.reader);
    const indexB = await getProjectIndex(b.reader);
    expect(await getProjectIndex(a.reader)).toBe(indexA);

    resetProjectIndex(a.reader);
    const rebuiltA = await getProjectIndex(a.reader);
    expect(rebuiltA).not.toBe(indexA);
    expect(await getProjectIndex(b.reader)).toBe(indexB);

    resetProjectIndex();
    expect(await getProjectIndex(a.reader)).not.toBe(rebuiltA);
    expect(await getProjectIndex(b.reader)).not.toBe(indexB);
  });
});
