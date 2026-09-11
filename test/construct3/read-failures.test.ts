/**
 * Real-reader tests for read-failure recording, the raw ID scan, and the two
 * consumers that depend on them (IdGenerator, validateProjectIntegrity).
 *
 * The in-memory MockReader fakes the I/O, so mock-only tests cannot catch a
 * broken production primitive: the 10MB size-cap bypass, path-map (subfolder)
 * resolution, or the real fs error surface (ENOENT, EISDIR). Everything here
 * runs Construct3ProjectReader against files on disk in a temp copy of the
 * minimal-project fixture.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, cp, rm, mkdir, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { validateProjectIntegrity } from '../../src/construct3/analyzers/integrity.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');
/** Must match MAX_FILE_SIZE in src/construct3/project-reader.ts */
const READER_SIZE_CAP = 10 * 1024 * 1024;
/** Pushes a small JSON document just past the cap. ASCII spaces, so byte length equals char length. */
const PADDING = Buffer.alloc(READER_SIZE_CAP + 4096, 0x20);
/** Writing and scanning a 10MB file is well under a second locally; leave room for slow disks and AV scanners. */
const OVERSIZED_TIMEOUT_MS = 15_000;

type Category = 'layouts' | 'objectTypes';

async function createTempProject(): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), 'c3-readfail-'));
  await cp(FIXTURE_DIR, tmp, { recursive: true });
  return tmp;
}

/** Register a name in a c3proj container (root items, or a one-level subfolder) by editing the file. */
async function registerInProject(projectDir: string, category: Category, name: string, subfolder?: string): Promise<void> {
  const c3projPath = join(projectDir, 'project.c3proj');
  const project = JSON.parse(await readFile(c3projPath, 'utf-8'));
  const container = project[category];
  if (subfolder) {
    let sf = container.subfolders.find((s: { name: string }) => s.name === subfolder);
    if (!sf) {
      sf = { name: subfolder, items: [], subfolders: [] };
      container.subfolders.push(sf);
    }
    sf.items.push(name);
  } else {
    container.items.push(name);
  }
  await writeFile(c3projPath, JSON.stringify(project, null, '\t'));
}

/**
 * A valid JSON document padded past the reader's size cap. The padding is a
 * string field placed BEFORE the tail, so the IDs of interest sit after the
 * 10MB mark: a scanner that only read a prefix would miss them. Written with
 * raw fs because Construct3ProjectWriter refuses files over 5MB.
 */
function oversizedJson(head: string, tail: string): Buffer {
  return Buffer.concat([Buffer.from(head), PADDING, Buffer.from(tail)]);
}

async function writeOversizedLayout(projectDir: string, name: string, highUid: number): Promise<void> {
  const head =
    `{"name":${JSON.stringify(name)},"layers":[{"name":"Main","sid":510000000000001,"instances":[` +
    `{"type":"Sprite","uid":5,"sid":510000000000002,"properties":{}},` +
    `{"type":"Sprite","properties":{},"tags":"`;
  const tail = `","uid":${highUid},"sid":510000000000003}]}],"sid":510000000000004}`;
  await writeFile(join(projectDir, 'layouts', `${name}.json`), oversizedJson(head, tail));
}

async function writeOversizedObjectType(projectDir: string, name: string, highUid: number): Promise<void> {
  const head =
    `{"name":${JSON.stringify(name)},"plugin-id":"Keyboard","sid":210000000000001,"isGlobal":true,` +
    `"instanceVariables":[],"behaviorTypes":[],"effectTypes":[],"padding":"`;
  const tail =
    `","singleglobal-inst":{"type":${JSON.stringify(name)},"uid":${highUid},"sid":210000000000002,"properties":{}}}`;
  await writeFile(join(projectDir, 'objectTypes', `${name}.json`), oversizedJson(head, tail));
}

function smallLayoutJson(name: string, uid: number, sidBase: number): string {
  return JSON.stringify({
    name,
    layers: [{ name: 'Main', sid: sidBase + 1, instances: [{ type: 'Sprite', uid, sid: sidBase + 2, properties: {} }] }],
    sid: sidBase,
    eventSheet: 'MainSheet',
    width: 1920,
    height: 1080,
  });
}

async function openReader(projectDir: string): Promise<Construct3ProjectReader> {
  const reader = new Construct3ProjectReader(join(projectDir, 'project.c3proj'));
  await reader.loadProject();
  return reader;
}

let tmpDir: string;

beforeEach(async () => {
  resetProjectIndex();
  tmpDir = await createTempProject();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
});

// ─── Read-failure recording ──────────────────────────────────

describe('Construct3ProjectReader — read failures (real files)', () => {
  it('records E_FILE_TOO_LARGE for a layout over the 10MB cap', async () => {
    await registerInProject(tmpDir, 'layouts', 'Big');
    await writeOversizedLayout(tmpDir, 'Big', 30046);
    const reader = await openReader(tmpDir);

    const layouts = await reader.readAllLayouts();
    expect(layouts.has('Layout 1')).toBe(true);
    expect(layouts.has('Big')).toBe(false);

    const failure = reader.getReadFailures('layouts').get('Big');
    expect(failure).toMatchObject({ code: 'E_FILE_TOO_LARGE' });
    expect(failure!.message).toContain('exceeds 10MB limit');
  }, OVERSIZED_TIMEOUT_MS);

  it('records E_FILE_NOT_FOUND for a registered layout with no file', async () => {
    await registerInProject(tmpDir, 'layouts', 'GhostLayout');
    const reader = await openReader(tmpDir);

    await reader.readAllLayouts();
    expect(reader.getReadFailures('layouts').get('GhostLayout')).toMatchObject({ code: 'E_FILE_NOT_FOUND' });
  });

  it('records E_INVALID_JSON for a corrupt layout', async () => {
    await registerInProject(tmpDir, 'layouts', 'Broken');
    await writeFile(join(tmpDir, 'layouts', 'Broken.json'), '{ "name": "Broken", not json');
    const reader = await openReader(tmpDir);

    await reader.readAllLayouts();
    expect(reader.getReadFailures('layouts').get('Broken')).toMatchObject({ code: 'E_INVALID_JSON' });
  });

  it('records E_READ_ERROR when a directory sits where the file should be', async () => {
    await registerInProject(tmpDir, 'layouts', 'Bad');
    await mkdir(join(tmpDir, 'layouts', 'Bad.json'));
    const reader = await openReader(tmpDir);

    await reader.readAllLayouts();
    expect(reader.getReadFailures('layouts').get('Bad')).toMatchObject({ code: 'E_READ_ERROR' });
  });
});

// ─── Raw ID scan ─────────────────────────────────────────────

describe('Construct3ProjectReader.scanEntityIdsRaw (real files)', () => {
  it('reads past the size cap and returns the highest UID and every SID', async () => {
    await registerInProject(tmpDir, 'layouts', 'Big');
    await writeOversizedLayout(tmpDir, 'Big', 30046);
    const reader = await openReader(tmpDir);

    const scan = await reader.scanEntityIdsRaw('layouts', 'Big');
    expect(scan.highestUid).toBe(30046);
    expect(scan.sids).toEqual([510000000000001, 510000000000002, 510000000000003, 510000000000004]);
  }, OVERSIZED_TIMEOUT_MS);

  it('resolves a layout registered in a c3proj subfolder through the same path map as readLayout', async () => {
    await registerInProject(tmpDir, 'layouts', 'Deep', 'Levels');
    await mkdir(join(tmpDir, 'layouts', 'Levels'), { recursive: true });
    await writeFile(join(tmpDir, 'layouts', 'Levels', 'Deep.json'), smallLayoutJson('Deep', 12, 520000000000000));
    const reader = await openReader(tmpDir);

    expect((await reader.readLayout('Deep')).name).toBe('Deep');
    expect((await reader.scanEntityIdsRaw('layouts', 'Deep')).highestUid).toBe(12);
  });

  it('scans object types through their own path map', async () => {
    await registerInProject(tmpDir, 'objectTypes', 'Kb');
    await writeFile(join(tmpDir, 'objectTypes', 'Kb.json'), JSON.stringify({
      name: 'Kb', 'plugin-id': 'Keyboard', sid: 210000000000001, isGlobal: true,
      'singleglobal-inst': { type: 'Kb', uid: 77, sid: 210000000000002, properties: {} },
    }));
    const reader = await openReader(tmpDir);

    expect((await reader.scanEntityIdsRaw('objectTypes', 'Kb')).highestUid).toBe(77);
  });

  it('rejects with an ENOENT-coded error for a missing file', async () => {
    await registerInProject(tmpDir, 'layouts', 'GhostLayout');
    const reader = await openReader(tmpDir);

    await expect(reader.scanEntityIdsRaw('layouts', 'GhostLayout')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

// ─── IdGenerator ─────────────────────────────────────────────

describe('IdGenerator — real files', () => {
  // The fixture's only instance has uid 0, so a clean project mints 1.

  it('recovers the UID high-water mark from an oversized layout on disk', async () => {
    await registerInProject(tmpDir, 'layouts', 'Big');
    await writeOversizedLayout(tmpDir, 'Big', 30046);
    const reader = await openReader(tmpDir);

    expect(await new IdGenerator().generateUid(reader)).toBe(30047);
  }, OVERSIZED_TIMEOUT_MS);

  it('ignores a registered layout whose file is missing (reviewer repro: GhostLayout)', async () => {
    await registerInProject(tmpDir, 'layouts', 'GhostLayout');
    const reader = await openReader(tmpDir);

    expect(await new IdGenerator().generateUid(reader)).toBe(1);
  });

  it('hard-fails when a layout exists but cannot be read (directory in place of the file)', async () => {
    await registerInProject(tmpDir, 'layouts', 'Bad');
    await mkdir(join(tmpDir, 'layouts', 'Bad.json'));
    const reader = await openReader(tmpDir);

    await expect(new IdGenerator().generateUid(reader))
      .rejects.toThrow(/Cannot generate a safe UID.*layouts\/Bad/);
  });

  it('recovers IDs from a layout whose JSON is invalid', async () => {
    await registerInProject(tmpDir, 'layouts', 'Broken');
    await writeFile(join(tmpDir, 'layouts', 'Broken.json'), smallLayoutJson('Broken', 555, 530000000000000) + '\n}}}');
    const reader = await openReader(tmpDir);

    expect(await new IdGenerator().generateUid(reader)).toBe(556);
  });

  it('recovers singleglobal-inst.uid from an oversized object type on disk', async () => {
    await registerInProject(tmpDir, 'objectTypes', 'BigGlobal');
    await writeOversizedObjectType(tmpDir, 'BigGlobal', 30050);
    const reader = await openReader(tmpDir);

    await reader.readAllObjectTypes();
    expect(reader.getReadFailures('objectTypes').get('BigGlobal')).toMatchObject({ code: 'E_FILE_TOO_LARGE' });
    expect(await new IdGenerator().generateUid(reader)).toBe(30051);
  }, OVERSIZED_TIMEOUT_MS);

  it('ignores a registered object type whose file is missing', async () => {
    await registerInProject(tmpDir, 'objectTypes', 'GhostType');
    const reader = await openReader(tmpDir);

    expect(await new IdGenerator().generateUid(reader)).toBe(1);
  });
});

// ─── validateProjectIntegrity ────────────────────────────────

describe('validateProjectIntegrity — real files', () => {
  it('reports an oversized layout as UNSCANNED with complete: false', async () => {
    await registerInProject(tmpDir, 'layouts', 'Big');
    await writeOversizedLayout(tmpDir, 'Big', 30046);
    const reader = await openReader(tmpDir);

    const result = await validateProjectIntegrity(reader);
    expect(result.errors.find(e => e.entity === 'layouts/Big')).toBeUndefined();
    expect(result.warnings.find(w => w.check === 'unscanned-file' && w.entity === 'layouts/Big')).toBeDefined();
    expect(result.unscannedFiles).toContain('layouts/Big');
    expect(result.summary.unscanned).toBe(1);
    expect(result.valid).toBe(true);
    expect(result.complete).toBe(false);
  }, OVERSIZED_TIMEOUT_MS);

  it('reports a missing layout as a file-existence error with complete: true', async () => {
    await registerInProject(tmpDir, 'layouts', 'GhostLayout');
    const reader = await openReader(tmpDir);

    const result = await validateProjectIntegrity(reader);
    const err = result.errors.find(e => e.check === 'file-existence' && e.entity === 'layouts/GhostLayout');
    expect(err).toBeDefined();
    expect(err!.message).toContain('no file exists at layouts/GhostLayout.json');
    expect(result.valid).toBe(false);
    expect(result.complete).toBe(true);
    expect(result.summary.unscanned).toBe(0);
  });
});
