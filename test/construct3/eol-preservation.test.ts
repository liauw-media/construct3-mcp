/**
 * Writes keep the on-disk text style of Construct 3 files:
 * - an existing CRLF file stays CRLF, an existing LF file stays LF;
 * - the trailing whitespace and BOM of an existing file are kept exactly;
 * - a new file follows the project's convention (project.c3proj);
 * - rewriting unchanged data reproduces the original bytes.
 *
 * Test projects are restyled explicitly after copying, so the results do
 * not depend on how git checked out the fixtures (core.autocrlf).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, cp, readFile, readdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { MockServer } from '../mocks/mock-server.js';
import { registerProjectTools } from '../../src/tools/project-tools.js';
import { registerTimelineTools } from '../../src/tools/timeline-tools.js';
import { registerRuntimeTools } from '../../src/tools/runtime-tools.js';

const MINIMAL_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');
const LOADABLE_DIR = join(__dirname, '..', 'fixtures', 'c3-loadable-minimal');
const BOM = '\uFEFF';

type Eol = '\n' | '\r\n';

interface Style {
  eol: Eol;
  /** Exact text appended after the closing bracket (default: none). */
  trailing?: string;
  bom?: boolean;
}

async function listJsonFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await listJsonFiles(p));
    else if (/\.(json|c3proj)$/.test(entry.name)) out.push(p);
  }
  return out;
}

/** Rewrite a file's text in the given style (content unchanged). */
async function restyle(file: string, style: Style): Promise<void> {
  const text = (await readFile(file, 'utf-8'))
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+$/, '');
  let out = (style.eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text) + (style.trailing ?? '');
  if (style.bom) out = BOM + out;
  await writeFile(file, out, 'utf-8');
}

/** Copy a fixture to a temp dir and give every JSON file the same style. */
async function createProject(fixture: string, style: Style): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'c3-eol-'));
  await cp(fixture, dir, { recursive: true });
  for (const f of await listJsonFiles(dir)) await restyle(f, style);
  return dir;
}

function lineEndings(text: string): { crlf: number; bareLf: number } {
  const crlf = (text.match(/\r\n/g) || []).length;
  return { crlf, bareLf: (text.match(/\n/g) || []).length - crlf };
}

async function open(dir: string) {
  const reader = new Construct3ProjectReader(join(dir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  const writer = new Construct3ProjectWriter(reader, idGen);
  return { reader, writer, idGen };
}

const read = (dir: string, ...p: string[]) => readFile(join(dir, ...p), 'utf-8');

describe('Construct3ProjectWriter — text style preservation', () => {
  let dir: string;

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('existing CRLF entity file stays CRLF (in an LF project)', async () => {
    dir = await createProject(MINIMAL_DIR, { eol: '\n' });
    await restyle(join(dir, 'eventSheets', 'MainSheet.json'), { eol: '\r\n' });
    const { reader, writer } = await open(dir);

    const sheet = await reader.readEventSheet('MainSheet');
    sheet.events.push({ eventType: 'comment', text: 'added' } as never);
    await writer.writeEntityFile('eventSheets', 'MainSheet', sheet);

    const text = await read(dir, 'eventSheets', 'MainSheet.json');
    expect(lineEndings(text).bareLf).toBe(0);
    expect(lineEndings(text).crlf).toBeGreaterThan(0);
    expect(text.endsWith('}')).toBe(true);
    expect(JSON.parse(text).events.at(-1).text).toBe('added');
  });

  it('existing LF entity file stays LF (in a CRLF project)', async () => {
    dir = await createProject(MINIMAL_DIR, { eol: '\r\n' });
    await restyle(join(dir, 'eventSheets', 'MainSheet.json'), { eol: '\n' });
    const { reader, writer } = await open(dir);

    const sheet = await reader.readEventSheet('MainSheet');
    await writer.writeEntityFile('eventSheets', 'MainSheet', sheet);

    const text = await read(dir, 'eventSheets', 'MainSheet.json');
    expect(lineEndings(text).crlf).toBe(0);
    expect(lineEndings(text).bareLf).toBeGreaterThan(0);
  });

  it('keeps trailing newline and BOM of an existing file, and the reader still parses it', async () => {
    dir = await createProject(MINIMAL_DIR, { eol: '\n' });
    await restyle(join(dir, 'eventSheets', 'MainSheet.json'), { eol: '\r\n', trailing: '\r\n', bom: true });
    const { reader, writer } = await open(dir);

    const sheet = await reader.readEventSheet('MainSheet');
    await writer.writeEntityFile('eventSheets', 'MainSheet', sheet);

    const text = await read(dir, 'eventSheets', 'MainSheet.json');
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text.startsWith(BOM + '{\r\n')).toBe(true);
    expect(text.endsWith('}\r\n')).toBe(true);
    expect(lineEndings(text).bareLf).toBe(0);
    expect((await reader.readEventSheet('MainSheet')).name).toBe('MainSheet');
  });

  it.each([
    ['bare LF after CRLF lines', '\n'],
    ['two CRLF newlines', '\r\n\r\n'],
    ['two LF newlines', '\n\n'],
  ])('keeps the exact trailing whitespace of an existing file (%s)', async (_label, trailing) => {
    dir = await createProject(MINIMAL_DIR, { eol: '\n' });
    await restyle(join(dir, 'eventSheets', 'MainSheet.json'), { eol: '\r\n', trailing });
    const original = await read(dir, 'eventSheets', 'MainSheet.json');
    const { reader, writer } = await open(dir);

    await writer.writeEntityFile('eventSheets', 'MainSheet', await reader.readEventSheet('MainSheet'));

    expect(await read(dir, 'eventSheets', 'MainSheet.json')).toBe(original);
  });

  it('does not add a trailing newline or BOM to a file that has none', async () => {
    dir = await createProject(MINIMAL_DIR, { eol: '\r\n', trailing: '\r\n', bom: true });
    await restyle(join(dir, 'eventSheets', 'MainSheet.json'), { eol: '\r\n' });
    const { reader, writer } = await open(dir);

    await writer.writeEntityFile('eventSheets', 'MainSheet', await reader.readEventSheet('MainSheet'));

    const text = await read(dir, 'eventSheets', 'MainSheet.json');
    expect(text.startsWith('{')).toBe(true);
    expect(text.endsWith('}')).toBe(true);
  });

  it.each([
    ['CRLF', '\r\n' as Eol],
    ['LF', '\n' as Eol],
  ])('new entity file follows the project convention (%s)', async (_label, eol) => {
    dir = await createProject(MINIMAL_DIR, { eol });
    const { writer } = await open(dir);

    await writer.writeEntityFile('eventSheets', 'Fresh', { name: 'Fresh', events: [] });
    await writer.writeEntityFile('eventSheets', 'Nested', { name: 'Nested', events: [] }, 'UI/Menus');

    for (const text of [await read(dir, 'eventSheets', 'Fresh.json'), await read(dir, 'eventSheets', 'UI', 'Menus', 'Nested.json')]) {
      const counts = lineEndings(text);
      expect(eol === '\r\n' ? counts.bareLf : counts.crlf).toBe(0);
      expect(counts.crlf + counts.bareLf).toBeGreaterThan(0);
    }
  });

  it('new entity file takes trailing newline and BOM from project.c3proj', async () => {
    dir = await createProject(MINIMAL_DIR, { eol: '\n' });
    await restyle(join(dir, 'project.c3proj'), { eol: '\r\n', trailing: '\r\n', bom: true });
    const { writer } = await open(dir);

    await writer.writeEntityFile('objectTypes', 'Brand', { name: 'Brand' });

    const text = await read(dir, 'objectTypes', 'Brand.json');
    expect(text).toBe(BOM + '{\r\n\t"name": "Brand"\r\n}\r\n');
  });

  it('project.c3proj keeps CRLF, trailing newline and BOM across all project writes', async () => {
    dir = await createProject(MINIMAL_DIR, { eol: '\n' });
    await restyle(join(dir, 'project.c3proj'), { eol: '\r\n', trailing: '\r\n', bom: true });
    const { reader, writer } = await open(dir);

    await writer.updateProjectProperties({ description: 'eol test' });
    await writer.addToProject('eventSheets', 'Extra');
    await writer.removeFromProject('eventSheets', 'Extra');
    await writer.ensureAddonRegistered('behavior', 'Tween');

    const text = await read(dir, 'project.c3proj');
    expect(text.startsWith(BOM + '{\r\n')).toBe(true);
    expect(text.endsWith('}\r\n')).toBe(true);
    expect(lineEndings(text).bareLf).toBe(0);
    expect(reader.getProject().properties.description).toBe('eol test');
    expect(reader.getUsedAddons().some(a => a.id === 'Tween')).toBe(true);
  });

  it('backup holds the original bytes and no .tmp file is left behind', async () => {
    dir = await createProject(MINIMAL_DIR, { eol: '\r\n', trailing: '\r\n' });
    const original = await read(dir, 'eventSheets', 'MainSheet.json');
    const { reader, writer } = await open(dir);

    const sheet = await reader.readEventSheet('MainSheet');
    sheet.events.push({ eventType: 'comment', text: 'changed' } as never);
    const backupPath = await writer.writeEntityFile('eventSheets', 'MainSheet', sheet);

    expect(await readFile(backupPath, 'utf-8')).toBe(original);
    expect((await readdir(join(dir, 'eventSheets'))).filter(f => f.endsWith('.tmp'))).toHaveLength(0);
  });

  it.each([
    ['LF, as Construct 3 saves it', { eol: '\n' as Eol }],
    ['CRLF (git autocrlf checkout)', { eol: '\r\n' as Eol }],
    ['CRLF + trailing newline + BOM', { eol: '\r\n' as Eol, trailing: '\r\n', bom: true }],
  ])('rewriting unchanged data reproduces the editor-verified fixture byte for byte (%s)', async (_label, style) => {
    dir = await createProject(LOADABLE_DIR, style);
    const before = new Map<string, string>();
    for (const f of await listJsonFiles(dir)) before.set(f, await readFile(f, 'utf-8'));
    const { reader, writer } = await open(dir);

    await writer.writeEntityFile('eventSheets', 'MainSheet', await reader.readEventSheet('MainSheet'));
    await writer.writeEntityFile('layouts', 'Start', await reader.readLayout('Start'));
    await writer.updateProjectProperties({ description: reader.getProject().properties.description });

    for (const [file, text] of before) {
      expect(await readFile(file, 'utf-8'), file).toBe(text);
    }
  });
});

describe('Tool writes outside the writer keep project.c3proj text style', () => {
  let dir: string;

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function setup() {
    dir = await createProject(MINIMAL_DIR, { eol: '\r\n', trailing: '\r\n' });
    const { reader, writer, idGen } = await open(dir);
    const server = new MockServer();
    const deps = { server, reader, writer, idGen } as never;
    registerProjectTools(deps);
    registerTimelineTools(deps);
    registerRuntimeTools(deps);
    return server;
  }

  async function expectProjectStyleKept() {
    const text = await read(dir, 'project.c3proj');
    expect(lineEndings(text).bareLf).toBe(0);
    expect(text.endsWith('}\r\n')).toBe(true);
  }

  it('register_addon and unregister_addon', async () => {
    const server = await setup();
    expect((await server.callTool('register_addon', { type: 'effect', id: 'hsladjust', name: 'Adjust HSL' })).isError).toBeUndefined();
    await expectProjectStyleKept();
    expect((await server.callTool('unregister_addon', { type: 'effect', id: 'hsladjust' })).isError).toBeUndefined();
    await expectProjectStyleKept();
  });

  it('create_timeline writes the new timeline in the project style', async () => {
    const server = await setup();
    expect((await server.callTool('create_timeline', { name: 'Intro' })).isError).toBeUndefined();
    await expectProjectStyleKept();

    const timeline = await read(dir, 'timelines', 'Intro.json');
    expect(lineEndings(timeline).bareLf).toBe(0);
    expect(timeline.endsWith('}\r\n')).toBe(true);
  });

  it('inject_runtime_bridge and remove_runtime_bridge', async () => {
    const server = await setup();
    expect((await server.callTool('inject_runtime_bridge', {})).isError).toBeUndefined();
    await expectProjectStyleKept();
    expect((await server.callTool('remove_runtime_bridge', {})).isError).toBeUndefined();
    await expectProjectStyleKept();
  });
});
