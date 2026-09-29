/**
 * Entity files the reader skips (issue #49), through the tools on a temp copy
 * of the minimal fixture with the real reader, writer and ID generator:
 * - add_instance_to_layout and create_object allocate UIDs above those in a
 *   layout or object type over the reader's 10MB cap, and refuse when a
 *   registered file exists but cannot be scanned at all
 * - validate_project reports such files as not checked (`complete: false`)
 * - get_layout_details does not suggest other names for a file it found
 *
 * The big files are valid JSON padded past the cap BEFORE the highest UID,
 * so a scan that only read the first 10MB would miss it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, cp, rm, mkdir, readFile, writeFile, stat } from 'fs/promises';
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
/** Must match MAX_FILE_SIZE in src/construct3/project-reader.ts */
const READER_SIZE_CAP = 10 * 1024 * 1024;
/** Writing and scanning a file over 10MB takes well under a second locally; leave room for slow disks and AV scanners. */
const BIG_FILE_TIMEOUT_MS = 15_000;

let tmpDir: string;
let server: MockServer;

async function registerInProject(category: 'layouts' | 'objectTypes', name: string): Promise<void> {
  const c3projPath = join(tmpDir, 'project.c3proj');
  const project = JSON.parse(await readFile(c3projPath, 'utf-8'));
  project[category].items.push(name);
  await writeFile(c3projPath, JSON.stringify(project, null, '\t'));
}

/** Valid JSON: a string field of spaces pushes `tail` (which holds the high UID) past the size cap. */
function paddedJson(head: string, tail: string): Buffer {
  return Buffer.concat([Buffer.from(head), Buffer.alloc(READER_SIZE_CAP + 4096, 0x20), Buffer.from(tail)]);
}

async function writeBigLayout(name: string, highUid: number): Promise<void> {
  const head =
    `{"name":${JSON.stringify(name)},"layers":[{"name":"Main","sid":610000000000001,"instances":[` +
    `{"type":"Sprite","uid":7,"sid":610000000000002,"properties":{}},` +
    `{"type":"Sprite","properties":{},"tags":"`;
  const tail = `","uid":${highUid},"sid":610000000000003}]}],"sid":610000000000004,"eventSheet":"MainSheet","width":1920,"height":1080}`;
  await writeFile(join(tmpDir, 'layouts', `${name}.json`), paddedJson(head, tail));
}

async function writeBigGlobalObject(name: string, highUid: number): Promise<void> {
  const head =
    `{"name":${JSON.stringify(name)},"plugin-id":"Keyboard","sid":620000000000001,"isGlobal":true,` +
    `"instanceVariables":[],"behaviorTypes":[],"effectTypes":[],"padding":"`;
  const tail = `","singleglobal-inst":{"type":${JSON.stringify(name)},"uid":${highUid},"sid":620000000000002,"properties":{}}}`;
  await writeFile(join(tmpDir, 'objectTypes', `${name}.json`), paddedJson(head, tail));
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

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const result = await server.callTool(name, args);
  expect(result.isError, result.content[0].text).toBeUndefined();
  return JSON.parse(result.content[0].text);
}

async function layoutUids(name: string): Promise<number[]> {
  const layout = JSON.parse(await readFile(join(tmpDir, 'layouts', `${name}.json`), 'utf-8'));
  return layout.layers[0].instances.map((i: { uid: number }) => i.uid);
}

const PLACE_SPRITE = { layoutName: 'Layout 1', layerName: 'Main', objectType: 'Sprite', x: 10, y: 20 };

beforeEach(async () => {
  resetProjectIndex();
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-bigfiles-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
});

describe('UIDs next to files over the read cap', () => {
  it('add_instance_to_layout allocates above the UIDs of a layout over 10MB', async () => {
    await registerInProject('layouts', 'Big');
    await writeBigLayout('Big', 40000);
    await startServer();

    const result = await call('add_instance_to_layout', PLACE_SPRITE);
    expect(result.generatedUid).toBe(40001);
    expect(await layoutUids('Layout 1')).toEqual([0, 40001]);
  }, BIG_FILE_TIMEOUT_MS);

  it('create_object allocates the singleglobal-inst UID above an object type over 10MB', async () => {
    await registerInProject('objectTypes', 'BigKeys');
    await writeBigGlobalObject('BigKeys', 50000);
    await startServer();

    await call('create_object', { name: 'Keys', pluginId: 'Keyboard' });
    const keys = JSON.parse(await readFile(join(tmpDir, 'objectTypes', 'Keys.json'), 'utf-8'));
    expect(keys['singleglobal-inst'].uid).toBe(50001);
  }, BIG_FILE_TIMEOUT_MS);

  it('add_instance_to_layout refuses, and writes nothing, when a registered layout cannot be scanned', async () => {
    await registerInProject('layouts', 'Bad');
    await mkdir(join(tmpDir, 'layouts', 'Bad.json'));
    await startServer();
    const before = await readFile(join(tmpDir, 'layouts', 'Layout 1.json'));

    const result = await server.callTool('add_instance_to_layout', PLACE_SPRITE);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Cannot generate a safe UID.*layouts\/Bad/);
    expect(result.content[0].text).not.toContain(tmpDir);
    expect(Buffer.compare(await readFile(join(tmpDir, 'layouts', 'Layout 1.json')), before)).toBe(0);
  });

  it('create_object refuses a global plugin, and writes nothing, when a registered layout cannot be scanned', async () => {
    await registerInProject('layouts', 'Bad');
    await mkdir(join(tmpDir, 'layouts', 'Bad.json'));
    await startServer();
    const c3projPath = join(tmpDir, 'project.c3proj');
    const before = await readFile(c3projPath);

    // Keyboard is not in usedAddons yet: registering it writes project.c3proj
    const result = await server.callTool('create_object', { name: 'Keys', pluginId: 'Keyboard' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Cannot generate a safe UID.*layouts\/Bad/);
    expect(Buffer.compare(await readFile(c3projPath), before)).toBe(0);
    await expect(stat(`${c3projPath}.bak`)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(tmpDir, 'objectTypes', 'Keys.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a registered layout without a file does not block add_instance_to_layout', async () => {
    await registerInProject('layouts', 'Ghost');
    await startServer();

    const result = await call('add_instance_to_layout', PLACE_SPRITE);
    expect(result.generatedUid).toBe(1);
  });
});

describe('validate_project and get_layout_details on a layout over the read cap', () => {
  it('validate_project reports the layout as unscanned and the result as not complete', async () => {
    await registerInProject('layouts', 'Big');
    await writeBigLayout('Big', 40000);
    await startServer();

    const result = await call('validate_project', {});
    expect(result.complete).toBe(false);
    expect(result.unscannedFiles).toEqual(['layouts/Big']);
    expect(result.summary.unscanned).toBe(1);
    expect(result.errors.filter((e: { entity: string }) => e.entity === 'layouts/Big')).toEqual([]);
    const warning = result.warnings.find((w: { check: string; entity: string }) =>
      w.check === 'unscanned-file' && w.entity === 'layouts/Big');
    expect(warning?.message).toContain('exceeds 10MB limit');
    // valid keeps its meaning: no errors in the files that were checked
    expect(result.valid).toBe(true);
  }, BIG_FILE_TIMEOUT_MS);

  it('get_layout_details names the size limit without suggesting the name it was given', async () => {
    await registerInProject('layouts', 'Big');
    await writeBigLayout('Big', 40000);
    await startServer();

    const result = await server.callTool('get_layout_details', { name: 'Big' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('exceeds 10MB limit');
    expect(result.content[0].text).not.toContain('Did you mean');
  }, BIG_FILE_TIMEOUT_MS);

  it('get_layout_details still suggests names for a layout that does not exist', async () => {
    await startServer();

    const result = await server.callTool('get_layout_details', { name: 'Layout' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Did you mean: Layout 1?');
  });
});
