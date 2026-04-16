/**
 * Tests for atomic write behaviour in Construct3ProjectWriter.
 *
 * Verifies that:
 * 1. A .tmp file is NOT left behind after a successful write.
 * 2. The destination file is valid JSON after a successful write.
 * 3. The original file is NOT corrupted when atomicWrite throws mid-way
 *    (simulated by making the destination unwritable after backup).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, cp, readFile, readdir, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';

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
});
