/**
 * Integration tests for project-reader, project-writer, and id-generator
 * against a real (minimal) C3 project fixture on the filesystem.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, cp, readFile, writeFile, stat, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

/** Create a temp copy of the fixture so tests don't mutate it. */
async function createTempProject(): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), 'c3-test-'));
  await cp(FIXTURE_DIR, tmp, { recursive: true });
  return tmp;
}

// ─── Reader Tests ───────────────────────────────────────────

describe('Construct3ProjectReader (integration)', () => {
  let tmpDir: string;
  let reader: Construct3ProjectReader;

  beforeEach(async () => {
    tmpDir = await createTempProject();
    reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
    await reader.loadProject();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('loads project and returns valid metadata', () => {
    const meta = reader.getMetadata();
    expect(meta.name).toBe('TestProject');
    expect(meta.version).toBe('1.0.0');
    expect(meta.author).toBe('TestAuthor');
    expect(meta.viewportWidth).toBe(1920);
    expect(meta.viewportHeight).toBe(1080);
    expect(meta.firstLayout).toBe('Layout 1');
  });

  it('lists object types', async () => {
    const objects = await reader.listObjectTypes();
    expect(objects).toContain('Sprite');
  });

  it('lists event sheets', async () => {
    const sheets = await reader.listEventSheets();
    expect(sheets).toContain('MainSheet');
  });

  it('lists layouts', async () => {
    const layouts = await reader.listLayouts();
    expect(layouts).toContain('Layout 1');
  });

  it('reads individual object type', async () => {
    const sprite = await reader.readObjectType('Sprite');
    expect(sprite.name).toBe('Sprite');
    expect(sprite['plugin-id']).toBe('Sprite');
    expect(sprite.sid).toBe(200000000000001);
  });

  it('reads individual event sheet', async () => {
    const sheet = await reader.readEventSheet('MainSheet');
    expect(sheet.name).toBe('MainSheet');
    expect(sheet.events).toHaveLength(1);
    expect(sheet.events[0].eventType).toBe('block');
  });

  it('reads individual layout', async () => {
    const layout = await reader.readLayout('Layout 1');
    expect(layout.name).toBe('Layout 1');
    expect(layout.layers).toHaveLength(1);
    expect(layout.layers[0].instances).toHaveLength(1);
  });

  it('rejects path traversal', async () => {
    await expect(reader.readObjectType('../../../etc/passwd')).rejects.toThrow('Path traversal');
  });

  it('findNearestName returns suggestions', () => {
    const matches = reader.findNearestName('Spr', 'objects');
    expect(matches).toContain('Sprite');
  });

  it('invalidateCaches forces re-read', async () => {
    // Read all objects (populates cache)
    const first = await reader.readAllObjectTypes();
    expect(first.size).toBe(1);

    // Invalidate and read again — should still work
    reader.invalidateCaches();
    const second = await reader.readAllObjectTypes();
    expect(second.size).toBe(1);
    // They should be different Map instances (cache was cleared)
    expect(second).not.toBe(first);
  });

  it('reloadProject picks up c3proj changes', async () => {
    const projectPath = join(tmpDir, 'project.c3proj');
    const content = await readFile(projectPath, 'utf-8');
    const project = JSON.parse(content);
    project.name = 'RenamedProject';
    await writeFile(projectPath, JSON.stringify(project, null, '\t'), 'utf-8');

    await reader.reloadProject();
    expect(reader.getMetadata().name).toBe('RenamedProject');
  });
});

// ─── Writer Tests ───────────────────────────────────────────

describe('Construct3ProjectWriter (integration)', () => {
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

  it('writeEntityFile creates backup and writes valid JSON', async () => {
    const data = {
      name: 'NewSprite',
      'plugin-id': 'Sprite',
      sid: 999999999999999,
      isGlobal: false,
      instanceVariables: [],
      behaviorTypes: [],
      effectTypes: [],
      animations: { items: [], subfolders: [] },
    };

    const backupPath = await writer.writeEntityFile('objectTypes', 'NewSprite', data);
    expect(backupPath).toContain('.bak');

    // File should exist and be valid JSON
    const written = await readFile(join(tmpDir, 'objectTypes', 'NewSprite.json'), 'utf-8');
    const parsed = JSON.parse(written);
    expect(parsed.name).toBe('NewSprite');
  });

  it('writeEntityFile rejects oversized data', async () => {
    // Create a string that produces >5MB JSON
    const huge = { name: 'Big', data: 'x'.repeat(6 * 1024 * 1024) };
    await expect(
      writer.writeEntityFile('objectTypes', 'Big', huge),
    ).rejects.toThrow('too large');
  });

  it('writeEntityFile rejects path traversal', async () => {
    await expect(
      writer.writeEntityFile('objectTypes', '../../etc/evil', { name: 'evil' }),
    ).rejects.toThrow('Path traversal');
  });

  it('addToProject adds name to c3proj container', async () => {
    await writer.addToProject('objectTypes', 'Enemy');

    const content = await readFile(join(tmpDir, 'project.c3proj'), 'utf-8');
    const project = JSON.parse(content);
    expect(project.objectTypes.items).toContain('Enemy');
  });

  it('removeFromProject removes name from c3proj container', async () => {
    await writer.removeFromProject('objectTypes', 'Sprite');

    const content = await readFile(join(tmpDir, 'project.c3proj'), 'utf-8');
    const project = JSON.parse(content);
    expect(project.objectTypes.items).not.toContain('Sprite');
  });

  it('deleteEntityFile creates backup and removes file', async () => {
    const filePath = join(tmpDir, 'objectTypes', 'Sprite.json');
    // File should exist before deletion
    await expect(stat(filePath)).resolves.toBeDefined();

    const backupPath = await writer.deleteEntityFile('objectTypes', 'Sprite');
    expect(backupPath).toContain('.bak');

    // File should be gone
    await expect(stat(filePath)).rejects.toThrow();
    // Backup should exist
    await expect(stat(backupPath)).resolves.toBeDefined();
  });

  it('updateProjectProperties updates allowed keys', async () => {
    await writer.updateProjectProperties({ version: '2.0.0', author: 'NewAuthor' });

    const content = await readFile(join(tmpDir, 'project.c3proj'), 'utf-8');
    const project = JSON.parse(content);
    expect(project.properties.version).toBe('2.0.0');
    expect(project.properties.author).toBe('NewAuthor');
  });

  it('updateProjectProperties rejects unknown keys', async () => {
    await expect(
      writer.updateProjectProperties({ hackerField: 'bad', anotherBad: 123 }),
    ).rejects.toThrow('Unknown project property key(s): hackerField, anotherBad');
  });

  it('updateProjectProperties updates top-level name', async () => {
    await writer.updateProjectProperties({ name: 'NewName' });

    const content = await readFile(join(tmpDir, 'project.c3proj'), 'utf-8');
    const project = JSON.parse(content);
    expect(project.name).toBe('NewName');
  });
});

// ─── IdGenerator Tests ──────────────────────────────────────

describe('IdGenerator (integration)', () => {
  let tmpDir: string;
  let reader: Construct3ProjectReader;
  let idGen: IdGenerator;

  beforeEach(async () => {
    tmpDir = await createTempProject();
    reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
    await reader.loadProject();
    idGen = new IdGenerator();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('initializes from fixture and collects existing SIDs', async () => {
    const sid = await idGen.generateSid(reader);
    // Should be a 15-digit number
    expect(sid).toBeGreaterThanOrEqual(100_000_000_000_000);
    expect(sid).toBeLessThanOrEqual(999_999_999_999_999);
  });

  it('generateSid returns unique values', async () => {
    const sids = new Set<number>();
    for (let i = 0; i < 10; i++) {
      sids.add(await idGen.generateSid(reader));
    }
    expect(sids.size).toBe(10);
  });

  it('generateUid returns sequential IDs starting after highest existing', async () => {
    const uid1 = await idGen.generateUid(reader);
    const uid2 = await idGen.generateUid(reader);
    expect(uid2).toBe(uid1 + 1);
    // The fixture has uid 0, so first generated should be 1
    expect(uid1).toBe(1);
  });

  it('reset clears state for re-initialization', async () => {
    await idGen.generateSid(reader);
    idGen.reset();
    // After reset, it should re-scan on next call (no error)
    const sid = await idGen.generateSid(reader);
    expect(sid).toBeGreaterThanOrEqual(100_000_000_000_000);
  });
});

// ─── Mutex Tests ────────────────────────────────────────────

describe('Project lock (mutex)', () => {
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

  it('two concurrent addToProject calls both succeed (no lost writes)', async () => {
    // Fire two concurrent adds
    await Promise.all([
      writer.addToProject('objectTypes', 'EnemyA'),
      writer.addToProject('objectTypes', 'EnemyB'),
    ]);

    const content = await readFile(join(tmpDir, 'project.c3proj'), 'utf-8');
    const project = JSON.parse(content);
    expect(project.objectTypes.items).toContain('EnemyA');
    expect(project.objectTypes.items).toContain('EnemyB');
  });

  it('error inside lock releases it so next call proceeds', async () => {
    // First call: force an error by trying to add to a nonexistent category
    // We'll use updateProjectProperties with a valid key but sabotage the file
    const projectPath = join(tmpDir, 'project.c3proj');
    await writeFile(projectPath, 'NOT JSON', 'utf-8');

    // This should fail (can't parse the file)
    await expect(writer.addToProject('objectTypes', 'WillFail')).rejects.toThrow();

    // Restore valid project file so next call can succeed
    await cp(join(FIXTURE_DIR, 'project.c3proj'), projectPath);
    await reader.reloadProject();

    // Next call should succeed — lock was released despite the error
    await writer.addToProject('objectTypes', 'AfterError');
    const content = await readFile(projectPath, 'utf-8');
    const project = JSON.parse(content);
    expect(project.objectTypes.items).toContain('AfterError');
  });

  it('concurrent ensureAddonRegistered for same addon produces exactly one entry', async () => {
    // AJAX is a known Scirra plugin not in the fixture's usedAddons
    await Promise.all([
      writer.ensureAddonRegistered('plugin', 'AJAX'),
      writer.ensureAddonRegistered('plugin', 'AJAX'),
    ]);

    const content = await readFile(join(tmpDir, 'project.c3proj'), 'utf-8');
    const project = JSON.parse(content);
    const ajaxEntries = project.usedAddons.filter(
      (a: { type: string; id: string }) => a.type === 'plugin' && a.id === 'AJAX',
    );
    expect(ajaxEntries).toHaveLength(1);
  });
});

// ─── Round-trip Test ────────────────────────────────────────

describe('Round-trip write→read', () => {
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

  it('write entity then read back returns matching data', async () => {
    const original = {
      name: 'RoundTrip',
      'plugin-id': 'Sprite',
      sid: 888888888888888,
      isGlobal: false,
      instanceVariables: [],
      behaviorTypes: [],
      effectTypes: [],
      animations: { items: [], subfolders: [] },
    };

    await writer.writeEntityFile('objectTypes', 'RoundTrip', original);
    await writer.addToProject('objectTypes', 'RoundTrip');

    const readBack = await reader.readObjectType('RoundTrip');
    expect(readBack.name).toBe('RoundTrip');
    expect(readBack['plugin-id']).toBe('Sprite');
    expect(readBack.sid).toBe(888888888888888);
    expect(readBack.isGlobal).toBe(false);
  });
});
