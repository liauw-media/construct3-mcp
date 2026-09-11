/**
 * Real-writer tests for delete_layout ordering.
 *
 * delete_* handlers deregister the entity from project.c3proj BEFORE deleting
 * its file, so a failure between the two steps leaves an orphaned file (info)
 * rather than a dangling registration (a file-existence error, and formerly a
 * UID-minting block). The mock-writer tests pin the call order; these prove
 * the on-disk outcome and the failure path through the real reader, writer,
 * project index and IdGenerator.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, cp, rm, readFile, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { validateProjectIntegrity } from '../../src/construct3/analyzers/integrity.js';
import { getProjectIndex, resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { MockServer } from '../mocks/mock-server.js';
import { registerLayoutTools } from '../../src/tools/layout-tools.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

function parseResult(result: { content: Array<{ type: string; text: string }>; isError?: boolean }) {
  return JSON.parse(result.content[0].text);
}

describe('delete_layout (real project on disk)', () => {
  let tmpDir: string;
  let reader: Construct3ProjectReader;
  let writer: Construct3ProjectWriter;
  let idGen: IdGenerator;
  let server: MockServer;

  beforeEach(async () => {
    resetProjectIndex();
    tmpDir = await mkdtemp(join(tmpdir(), 'c3-layout-int-'));
    await cp(FIXTURE_DIR, tmpDir, { recursive: true });

    reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
    await reader.loadProject();
    idGen = new IdGenerator();
    writer = new Construct3ProjectWriter(reader, idGen);
    server = new MockServer();
    registerLayoutTools({ server, reader, writer, idGen } as any);

    // The fixture's only layout is the startup layout and has references;
    // work on a fresh, unreferenced one instead.
    const created = parseResult(await server.callTool('create_layout', { name: 'Level 2' }));
    expect(created.success).toBe(true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function registeredLayouts(): Promise<string[]> {
    const project = JSON.parse(await readFile(join(tmpDir, 'project.c3proj'), 'utf-8'));
    return project.layouts.items;
  }

  it('removes both the c3proj registration and the file', async () => {
    const result = parseResult(await server.callTool('delete_layout', { name: 'Level 2' }));
    expect(result.success).toBe(true);
    expect(result.action).toBe('deleted');

    await expect(stat(join(tmpDir, 'layouts', 'Level 2.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(tmpDir, 'layouts', 'Level 2.json.bak'))).resolves.toBeDefined();
    expect(await registeredLayouts()).not.toContain('Level 2');
    expect(await reader.listLayouts()).not.toContain('Level 2');
  });

  it('leaves an orphaned file, not a dangling registration, when the file delete fails', async () => {
    vi.spyOn(writer, 'deleteEntityFile').mockRejectedValueOnce(new Error('simulated unlink failure'));

    const result = await server.callTool('delete_layout', { name: 'Level 2' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('simulated unlink failure');
    // The caller is told which file to clean up: delete_layout cannot retry
    // an unregistered name.
    expect(result.content[0].text).toContain('layouts/Level 2.json');

    // Deregistered on disk, file still present
    expect(await registeredLayouts()).not.toContain('Level 2');
    await expect(stat(join(tmpDir, 'layouts', 'Level 2.json'))).resolves.toBeDefined();

    // Nothing downstream still believes the layout is registered: the index
    // was built inside the handler before deregistration and must have been
    // invalidated; UID minting and validate_project see a consistent project.
    expect((await getProjectIndex(reader)).allLayouts).not.toContain('Level 2');
    expect(await new IdGenerator().generateUid(reader)).toBe(1);
    const integrity = await validateProjectIntegrity(reader);
    expect(integrity.errors.find(e => e.entity === 'layouts/Level 2')).toBeUndefined();
  });
});
