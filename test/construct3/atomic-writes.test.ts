/**
 * Tests for atomic write behaviour in Construct3ProjectWriter.
 *
 * Verifies that:
 * 1. A .tmp file is NOT left behind after a successful write.
 * 2. The destination file is valid JSON after a successful write.
 * 3. The original file is NOT corrupted when atomicWrite throws mid-way
 *    (simulated by making the destination unwritable after backup).
 * 4. Read-back verification tells a concurrent write (valid JSON, other
 *    content) apart from a corrupted file.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, cp, readFile, readdir, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { isCaseInsensitiveFs } from '../helpers/fs-case.js';

const caseInsensitive = isCaseInsensitiveFs();

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

async function createTempProject(): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), 'c3-atomic-'));
  await cp(FIXTURE_DIR, tmp, { recursive: true });
  return tmp;
}

describe('Construct3ProjectWriter — atomic writes', () => {
  let tmpDir: string;
  let reader: Construct3ProjectReader;
  let writer: Construct3ProjectWriter;
  let idGen: IdGenerator;

  beforeEach(async () => {
    tmpDir = await createTempProject();
    reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
    await reader.loadProject();
    idGen = new IdGenerator();
    writer = new Construct3ProjectWriter(reader, idGen);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('leaves no .tmp file after a successful entity write', async () => {
    await writer.writeEntityFile('eventSheets', 'GameEvents', { name: 'GameEvents', events: [] });

    const allFiles = await readdir(join(tmpDir, 'eventSheets'));
    const tmpFiles = allFiles.filter(f => f.endsWith('.tmp'));
    expect(tmpFiles).toHaveLength(0);
  });

  it('writes valid JSON to the destination file', async () => {
    const data = { name: 'GameEvents', events: [{ eventType: 'comment', text: 'hello' }] };
    await writer.writeEntityFile('eventSheets', 'GameEvents', data);

    const written = await readFile(join(tmpDir, 'eventSheets', 'GameEvents.json'), 'utf-8');
    const parsed = JSON.parse(written);
    expect(parsed.name).toBe('GameEvents');
    expect(parsed.events).toHaveLength(1);
  });

  it('leaves no .tmp file after a successful project.c3proj write', async () => {
    await writer.updateProjectProperties({ description: 'atomic test' });

    const allFiles = await readdir(tmpDir);
    const tmpFiles = allFiles.filter(f => f.endsWith('.tmp'));
    expect(tmpFiles).toHaveLength(0);

    // Verify the project file itself is valid JSON
    const content = await readFile(join(tmpDir, 'project.c3proj'), 'utf-8');
    const project = JSON.parse(content);
    expect(project.properties.description).toBe('atomic test');
  });

  /** Let `content` land on disk right after the writer's own atomic write. */
  function interleaveWrite(content: string): void {
    const target = writer as unknown as { atomicWrite(p: string, c: string): Promise<void> };
    const original = target.atomicWrite.bind(writer);
    target.atomicWrite = async (p: string, c: string) => {
      await original(p, c);
      await writeFile(p, content, 'utf-8');
    };
  }

  it('reports another write landing in between as a concurrent change, not corruption', async () => {
    interleaveWrite(JSON.stringify({ name: 'MainSheet', events: [] }, null, '\t'));

    const write = writer.writeEntityFile('eventSheets', 'MainSheet', { name: 'MainSheet', events: [{ eventType: 'comment', text: 'mine' }] });

    await expect(write).rejects.toThrow(/changed by another write/);
    await expect(write).rejects.not.toThrow(/corrupted/);
  });

  it('reports unparsable read-back content as possible corruption', async () => {
    interleaveWrite('{ "name": "MainSheet", ');

    await expect(writer.writeEntityFile('eventSheets', 'MainSheet', { name: 'MainSheet', events: [] }))
      .rejects.toThrow(/may be corrupted/);
  });
});

describe('Construct3ProjectWriter — file names on disk (issue #29)', () => {
  let tmpDir: string;
  let writer: Construct3ProjectWriter;
  let reader: Construct3ProjectReader;

  const layoutsDir = () => join(tmpDir, 'layouts');
  // Shape of an editor-saved layout, CRLF and tab indent like a Windows checkout
  const layoutText = JSON.stringify({ name: 'layout1', sid: 900000000000001, width: 100, height: 100, layers: [] }, null, '\t')
    .replace(/\n/g, '\r\n');

  async function open(projectFile = 'project.c3proj'): Promise<void> {
    reader = new Construct3ProjectReader(join(tmpDir, projectFile));
    await reader.loadProject();
    writer = new Construct3ProjectWriter(reader, new IdGenerator());
  }

  beforeEach(async () => {
    tmpDir = await createTempProject();
    await open();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('createOnly refuses to replace an existing file, also under another case, without a backup', async () => {
    const path = join(layoutsDir(), 'Layout 1.json');
    const before = await readFile(path, 'utf-8');
    for (const name of ['Layout 1', 'LAYOUT 1']) {
      await expect(writer.writeEntityFile('layouts', name, { name, layers: [] }, undefined, { createOnly: true }))
        .rejects.toThrow(/layouts\/Layout 1\.json already exists/);
    }
    expect(await readFile(path, 'utf-8')).toBe(before);
    expect(await readdir(layoutsDir())).toEqual(['Layout 1.json']);
  });

  it('entityFileRefusal names the existing file and the next step, and is undefined for a free name', async () => {
    expect(await writer.entityFileRefusal('layouts', 'Layout 2')).toBeUndefined();
    const refusal = await writer.entityFileRefusal('layouts', 'layout 1');
    expect(refusal).toMatch(/^Refusing to create "layout 1": the file layouts\/Layout 1\.json already exists/);
    expect(refusal).toContain('Choose another name, or, if the file is a leftover of a deleted entity, check it and remove it first.');
  });

  it('createOnly writes a new file', async () => {
    await writer.writeEntityFile('layouts', 'Layout 2', { name: 'Layout 2', layers: [] }, undefined, { createOnly: true });
    expect((await readdir(layoutsDir())).sort()).toEqual(['Layout 1.json', 'Layout 2.json']);
  });

  describe.skipIf(!caseInsensitive)('on a case-insensitive file system', () => {
    beforeEach(async () => {
      // Registered as "layout1", stored as Layout1.json
      await writer.addToProject('layouts', 'layout1');
      await writeFile(join(layoutsDir(), 'Layout1.json'), layoutText, 'utf-8');
    });

    it('a rewrite keeps the file name and bytes, and backs up under that name', async () => {
      const backup = await writer.writeEntityFile('layouts', 'layout1', await reader.readLayout('layout1'));
      const entries = await readdir(layoutsDir());
      expect(entries.filter(e => e.endsWith('.json')).sort()).toEqual(['Layout 1.json', 'Layout1.json']);
      expect(entries).toContain('Layout1.json.bak');
      expect(backup).toBe(join(layoutsDir(), 'Layout1.json.bak'));
      expect(await readFile(join(layoutsDir(), 'Layout1.json'), 'utf-8')).toBe(layoutText);
    });

    it('a write under another spelling of the name changes the content, not the file name', async () => {
      const data = { ...(await reader.readLayout('layout1')), width: 200 };
      await writer.writeEntityFile('layouts', 'LAYOUT1', data);
      expect((await readdir(layoutsDir())).filter(e => e.endsWith('.json')).sort()).toEqual(['Layout 1.json', 'Layout1.json']);
      expect(JSON.parse(await readFile(join(layoutsDir(), 'Layout1.json'), 'utf-8')).width).toBe(200);
    });

    it('a delete backs the file up under its name on disk', async () => {
      const backup = await writer.deleteEntityFile('layouts', 'layout1');
      expect(backup).toBe(join(layoutsDir(), 'Layout1.json.bak'));
      expect((await readdir(layoutsDir())).sort()).toEqual(['Layout 1.json', 'Layout1.json.bak']);
    });

    it('project.c3proj keeps its file name when the configured path differs in case', async () => {
      await rm(join(tmpDir, 'project.c3proj.bak'), { force: true });
      await open('PROJECT.C3PROJ');
      await writer.updateProjectProperties({ description: 'case test' });
      const entries = await readdir(tmpDir);
      expect(entries).toContain('project.c3proj');
      expect(entries).toContain('project.c3proj.bak');
      expect(entries).not.toContain('PROJECT.C3PROJ');
      expect(entries).not.toContain('PROJECT.C3PROJ.bak');
      expect(JSON.parse(await readFile(join(tmpDir, 'project.c3proj'), 'utf-8')).properties.description).toBe('case test');
    });
  });
});
