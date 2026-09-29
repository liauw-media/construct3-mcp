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
import { basename, join } from 'path';
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

type Category = 'layouts' | 'objectTypes' | 'families';

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

  it('keeps the path traversal check: a registered name that leaves the project folder is not read', async () => {
    // A file outside the project that "layouts/<name>.json" reaches through "../.."
    const outsideDir = await mkdtemp(join(tmpdir(), 'c3-outside-'));
    try {
      await writeFile(join(outsideDir, 'Secret.json'), '{"uid": 99999, "sid": 990000000000001}');
      const name = `../../${basename(outsideDir)}/Secret`;
      await registerInProject(tmpDir, 'layouts', name);
      const reader = await openReader(tmpDir);

      await expect(reader.scanEntityIdsRaw('layouts', name)).rejects.toThrow(/Path traversal/);
      // The outside file's UID is never used; the unreadable registration blocks minting instead
      await expect(new IdGenerator().generateUid(reader)).rejects.toThrow(/Cannot generate a safe UID/);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
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

  it('names the registered subfolder path for a missing file', async () => {
    await registerInProject(tmpDir, 'layouts', 'Deep', 'Levels');
    const reader = await openReader(tmpDir);

    const result = await validateProjectIntegrity(reader);
    const err = result.errors.find(e => e.check === 'file-existence' && e.entity === 'layouts/Deep');
    expect(err).toBeDefined();
    expect(err!.message).toContain('no file exists at layouts/Levels/Deep.json');
    expect(err!.message).not.toContain(tmpDir);
  });

  it('reports a directory in place of a layout as an error and as not checked (complete: false)', async () => {
    await registerInProject(tmpDir, 'layouts', 'Bad');
    await mkdir(join(tmpDir, 'layouts', 'Bad.json'));
    const reader = await openReader(tmpDir);

    const result = await validateProjectIntegrity(reader);
    const err = result.errors.find(e => e.check === 'file-existence' && e.entity === 'layouts/Bad');
    expect(err).toBeDefined();
    expect(err!.message).toContain('could not be read');
    expect(err!.message).not.toContain(tmpDir);
    expect(result.unscannedFiles).toEqual(['layouts/Bad']);
    expect(result.summary.unscanned).toBe(1);
    expect(result.complete).toBe(false);
    expect(result.valid).toBe(false);
  });

  it('reports a layout with invalid JSON as an error and as not checked (complete: false)', async () => {
    await registerInProject(tmpDir, 'layouts', 'Broken');
    await writeFile(join(tmpDir, 'layouts', 'Broken.json'), '{ "name": "Broken", not json');
    const reader = await openReader(tmpDir);

    const result = await validateProjectIntegrity(reader);
    expect(result.errors.find(e => e.check === 'file-existence' && e.entity === 'layouts/Broken')).toBeDefined();
    expect(result.unscannedFiles).toEqual(['layouts/Broken']);
    expect(result.complete).toBe(false);
  });

  it('checks family files too: invalid JSON is not complete, a missing file is an error only', async () => {
    await registerInProject(tmpDir, 'families', 'BrokenFamily');
    await mkdir(join(tmpDir, 'families'), { recursive: true });
    await writeFile(join(tmpDir, 'families', 'BrokenFamily.json'), '{ "name": "BrokenFamily", ');
    await registerInProject(tmpDir, 'families', 'GhostFamily');
    const reader = await openReader(tmpDir);

    const result = await validateProjectIntegrity(reader);
    const broken = result.errors.find(e => e.check === 'file-existence' && e.entity === 'families/BrokenFamily');
    expect(broken).toBeDefined();
    expect(broken!.message).toContain('could not be read');
    const ghost = result.errors.find(e => e.check === 'file-existence' && e.entity === 'families/GhostFamily');
    expect(ghost).toBeDefined();
    expect(ghost!.message).toContain('no file exists at families/GhostFamily.json');
    expect(result.unscannedFiles).toEqual(['families/BrokenFamily']);
    expect(result.complete).toBe(false);
  });
});

// ─── Read failures under concurrent calls ────────────────────
//
// Tool calls run concurrently, and several (update_project_metadata,
// register_addon, create_object's addon registration, ...) reload the project,
// which drops the reader's caches while another call may be in the middle of a
// bulk read. The failures a bulk read found must stay with the result it
// returns and caches, or the ID generator and validate_project lose a skipped
// file and treat it as absent.

/**
 * Make the next read of `name` reload the project first, as a concurrent
 * tool call that rewrites project.c3proj would, mid bulk read.
 */
function reloadWhenReadingLayout(reader: Construct3ProjectReader, name: string): void {
  const readLayout = reader.readLayout.bind(reader);
  let reloaded = false;
  reader.readLayout = async (layoutName: string) => {
    if (!reloaded && layoutName === name) {
      reloaded = true;
      await reader.reloadProject();
    }
    return readLayout(layoutName);
  };
}

describe('Read failures survive a project reload during the bulk read (real files)', () => {
  /** Big (over the cap) is read before After, whose read triggers the reload. */
  async function projectWithBigThenAfter(): Promise<void> {
    await registerInProject(tmpDir, 'layouts', 'Big');
    await writeOversizedLayout(tmpDir, 'Big', 30046);
    await registerInProject(tmpDir, 'layouts', 'After');
    await writeFile(join(tmpDir, 'layouts', 'After.json'), smallLayoutJson('After', 3, 540000000000000));
  }

  it('generateUid still allocates above an oversized layout', async () => {
    await projectWithBigThenAfter();
    const reader = await openReader(tmpDir);
    reloadWhenReadingLayout(reader, 'After');

    expect(await new IdGenerator().generateUid(reader)).toBe(30047);
  });

  it('generateUid still allocates above the singleglobal-inst UID of an oversized object type', async () => {
    await registerInProject(tmpDir, 'objectTypes', 'BigGlobal');
    await writeOversizedObjectType(tmpDir, 'BigGlobal', 30050);
    const reader = await openReader(tmpDir);
    // Object types are read first; the reload lands while the layouts are read
    reloadWhenReadingLayout(reader, 'Layout 1');

    expect(await new IdGenerator().generateUid(reader)).toBe(30051);
  });

  it('a later validate_project still reports the oversized layout as unscanned', async () => {
    await projectWithBigThenAfter();
    const reader = await openReader(tmpDir);
    reloadWhenReadingLayout(reader, 'After');
    await reader.readAllLayouts();

    expect(reader.getReadFailures('layouts').get('Big')).toMatchObject({ code: 'E_FILE_TOO_LARGE' });
    const result = await validateProjectIntegrity(reader);
    expect(result.errors.find(e => e.entity === 'layouts/Big')).toBeUndefined();
    expect(result.warnings.find(w => w.check === 'unscanned-file' && w.entity === 'layouts/Big')).toBeDefined();
    expect(result.complete).toBe(false);
  });

  it('two concurrent first generateUid calls both refuse while a layout cannot be scanned', async () => {
    await registerInProject(tmpDir, 'layouts', 'Bad');
    await mkdir(join(tmpDir, 'layouts', 'Bad.json'));
    const reader = await openReader(tmpDir);

    // Pin the interleaving: call A has scanned Bad and waits in readAllFamilies
    // until call B has started its own scan of Bad; B's scan waits until A is done.
    let aInFamilies!: () => void;
    const aReachedFamilies = new Promise<void>(resolve => { aInFamilies = resolve; });
    let bInScan!: () => void;
    const bReachedScan = new Promise<void>(resolve => { bInScan = resolve; });
    let releaseB!: () => void;
    const bReleased = new Promise<void>(resolve => { releaseB = resolve; });

    const readAllFamilies = reader.readAllFamilies.bind(reader);
    let familyReads = 0;
    reader.readAllFamilies = async () => {
      if (++familyReads === 1) {
        aInFamilies();
        await bReachedScan;
      }
      return readAllFamilies();
    };
    const scanEntityIdsRaw = reader.scanEntityIdsRaw.bind(reader);
    let scans = 0;
    reader.scanEntityIdsRaw = async (category, name) => {
      if (++scans === 2) {
        bInScan();
        await bReleased;
      }
      return scanEntityIdsRaw(category, name);
    };

    const idGen = new IdGenerator();
    const settle = (p: Promise<number>) => p.then(uid => `uid ${uid}`, (error: Error) => error.message);
    const a = settle(idGen.generateUid(reader));
    await aReachedFamilies;
    const b = settle(idGen.generateUid(reader));

    const resultA = await a;
    releaseB();
    const resultB = await b;
    expect(resultA).toMatch(/Cannot generate a safe UID.*layouts\/Bad/);
    expect(resultB).toMatch(/Cannot generate a safe UID.*layouts\/Bad/);
  });
});
