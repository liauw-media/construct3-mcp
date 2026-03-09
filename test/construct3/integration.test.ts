/**
 * Integration tests for project-reader, project-writer, and id-generator
 * against a real (minimal) C3 project fixture on the filesystem.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, cp, readFile, readdir, writeFile, stat, rm } from 'fs/promises';
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

// ─── Image Pipeline Tests ───────────────────────────────────

describe('Image pipeline (integration)', () => {
  let tmpDir: string;
  let reader: Construct3ProjectReader;
  let writer: Construct3ProjectWriter;
  let idGen: IdGenerator;

  /** PNG magic bytes: 137 80 78 71 13 10 26 10 */
  const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

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

  it('writeImageFile creates PNG in images/ directory', async () => {
    const filePath = await writer.writeImageFile('Hero', 'Walk', 0, 'Sprite');

    await expect(stat(filePath)).resolves.toBeDefined();
    // animationName is case-preserved; only objectName is lowercased
    expect(filePath).toContain(join('images', 'hero-Walk-000.png'));
  });

  it('written PNG has valid signature', async () => {
    const filePath = await writer.writeImageFile('Hero', 'Idle', 0, 'Sprite');

    const content = await readFile(filePath);
    const header = content.subarray(0, 8);
    expect(Buffer.compare(header, PNG_MAGIC)).toBe(0);
  });

  it('writeImageFiles writes multiple PNGs', async () => {
    const paths = await writer.writeImageFiles([
      { objectName: 'Player', animationName: 'Run', frameIndex: 0 },
      { objectName: 'Player', animationName: 'Run', frameIndex: 1 },
      { objectName: 'Player', animationName: 'Run', frameIndex: 2 },
    ]);

    expect(paths).toHaveLength(3);
    const imagesDir = join(tmpDir, 'images');
    const files = await readdir(imagesDir);
    // animationName is case-preserved
    expect(files).toContain('player-Run-000.png');
    expect(files).toContain('player-Run-001.png');
    expect(files).toContain('player-Run-002.png');
  });

  it('Sprite creation round-trip: JSON has imageSpriteId + PNG exists', async () => {
    const sid = await idGen.generateSid(reader);
    const animSid = await idGen.generateSid(reader);
    const imgId = await idGen.generateImageSpriteId(reader);

    // Write the PNG
    await writer.writeImageFile('TestSprite', 'Animation 1', 0, 'Sprite');

    // Write the object JSON with imageSpriteId
    const { createSpriteObject } = await import('../../src/construct3/templates.js');
    const spriteData = createSpriteObject('TestSprite', sid, animSid, imgId);
    await writer.writeEntityFile('objectTypes', 'TestSprite', spriteData);
    await writer.addToProject('objectTypes', 'TestSprite');

    // Verify PNG exists
    const pngPath = join(tmpDir, 'images', 'testsprite-animation 1-000.png');
    await expect(stat(pngPath)).resolves.toBeDefined();

    // Verify JSON has imageSpriteId on the frame
    const readBack = await reader.readObjectType('TestSprite');
    const frame = (readBack.animations as { items: Array<{ frames: Array<Record<string, unknown>> }> }).items[0].frames[0];
    expect(frame.imageSpriteId).toBe(imgId);
  });

  it('TiledBg creation round-trip: JSON has imageSpriteId + PNG exists', async () => {
    const sid = await idGen.generateSid(reader);
    const imgId = await idGen.generateImageSpriteId(reader);

    // Write the PNG (TiledBg convention: just objectname.png)
    await writer.writeImageFile('MyBackground', '', 0, 'TiledBg');

    // Write the object JSON
    const { createTiledBgObject } = await import('../../src/construct3/templates.js');
    const bgData = createTiledBgObject('MyBackground', sid, imgId);
    await writer.writeEntityFile('objectTypes', 'MyBackground', bgData);
    await writer.addToProject('objectTypes', 'MyBackground');

    // Verify PNG exists with TiledBg naming
    const pngPath = join(tmpDir, 'images', 'mybackground.png');
    await expect(stat(pngPath)).resolves.toBeDefined();

    // Verify JSON has imageSpriteId on the image field
    const readBack = await reader.readObjectType('MyBackground');
    const image = (readBack as Record<string, unknown>).image as Record<string, unknown>;
    expect(image.imageSpriteId).toBe(imgId);
  });

  it('generateImageSpriteId returns 7-digit unique values', async () => {
    const id = await idGen.generateImageSpriteId(reader);
    expect(id).toBeGreaterThanOrEqual(1_000_000);
    expect(id).toBeLessThanOrEqual(9_999_999);
  });

  it('imageSpriteIds are unique across multiple calls', async () => {
    const ids = new Set<number>();
    for (let i = 0; i < 10; i++) {
      ids.add(await idGen.generateImageSpriteId(reader));
    }
    expect(ids.size).toBe(10);
  });
});

// ─── Behavior Workflow Tests ────────────────────────────────

describe('Behavior workflow (integration)', () => {
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

  it('add behavior to object: JSON has correct behaviorTypes entry', async () => {
    // Read existing Sprite, add a behavior, write back
    const obj = await reader.readObjectType('Sprite') as Record<string, unknown>;
    const sid = await idGen.generateSid(reader);
    const { createBehavior } = await import('../../src/construct3/templates.js');
    const behavior = createBehavior('Platform', 'Platform', sid);

    const behaviors = obj.behaviorTypes as Array<Record<string, unknown>>;
    behaviors.push(behavior);

    await writer.writeEntityFile('objectTypes', 'Sprite', obj);

    // Read back and verify
    reader.invalidateCaches();
    const readBack = await reader.readObjectType('Sprite');
    const readBehaviors = readBack.behaviorTypes as Array<Record<string, unknown>>;
    expect(readBehaviors).toHaveLength(1);
    expect(readBehaviors[0].behaviorId).toBe('Platform');
    expect(readBehaviors[0].name).toBe('Platform');
    expect(readBehaviors[0].sid).toBe(sid);
  });

  it('add behavior registers addon in usedAddons', async () => {
    await writer.ensureAddonRegistered('behavior', 'Platform');

    const content = await readFile(join(tmpDir, 'project.c3proj'), 'utf-8');
    const project = JSON.parse(content);
    const platformAddon = project.usedAddons.find(
      (a: { type: string; id: string }) => a.type === 'behavior' && a.id === 'Platform',
    );
    expect(platformAddon).toBeDefined();
    expect(platformAddon.name).toBe('Platform');
    expect(platformAddon.author).toBe('Scirra');
  });

  it('add multiple behaviors: all present with unique SIDs', async () => {
    const obj = await reader.readObjectType('Sprite') as Record<string, unknown>;
    const { createBehavior } = await import('../../src/construct3/templates.js');

    const sid1 = await idGen.generateSid(reader);
    const sid2 = await idGen.generateSid(reader);
    const behaviors = obj.behaviorTypes as Array<Record<string, unknown>>;
    behaviors.push(createBehavior('Platform', 'Platform', sid1));
    behaviors.push(createBehavior('Solid', 'Solid', sid2));

    await writer.writeEntityFile('objectTypes', 'Sprite', obj);

    reader.invalidateCaches();
    const readBack = await reader.readObjectType('Sprite');
    const readBehaviors = readBack.behaviorTypes as Array<Record<string, unknown>>;
    expect(readBehaviors).toHaveLength(2);
    expect(readBehaviors[0].behaviorId).toBe('Platform');
    expect(readBehaviors[1].behaviorId).toBe('Solid');
    expect(readBehaviors[0].sid).not.toBe(readBehaviors[1].sid);
  });

  it('add behavior preserves all existing object fields', async () => {
    const obj = await reader.readObjectType('Sprite') as Record<string, unknown>;
    const originalKeys = Object.keys(obj).sort();

    const { createBehavior } = await import('../../src/construct3/templates.js');
    const sid = await idGen.generateSid(reader);
    (obj.behaviorTypes as Array<Record<string, unknown>>).push(
      createBehavior('Tween', 'Tween', sid),
    );
    await writer.writeEntityFile('objectTypes', 'Sprite', obj);

    reader.invalidateCaches();
    const readBack = await reader.readObjectType('Sprite') as Record<string, unknown>;
    const readBackKeys = Object.keys(readBack).sort();
    expect(readBackKeys).toEqual(originalKeys);

    // Verify animations are intact
    const animations = readBack.animations as { items: Array<Record<string, unknown>> };
    expect(animations.items).toHaveLength(1);
    expect(animations.items[0].name).toBe('Animation 1');
  });

  it('layout instance has behaviors and instanceVariables dicts', async () => {
    // Verify the fixture layout instance has the standard fields
    const layout = await reader.readLayout('Layout 1');
    const instance = layout.layers[0].instances[0] as Record<string, unknown>;
    expect(instance.behaviors).toBeDefined();
    expect(instance.instanceVariables).toBeDefined();
    expect(typeof instance.behaviors).toBe('object');
    expect(typeof instance.instanceVariables).toBe('object');
  });

  it('full round-trip: create Sprite, add behavior, verify project integrity', async () => {
    const { createSpriteObject, createBehavior } = await import('../../src/construct3/templates.js');

    // Create a new Sprite
    const sid = await idGen.generateSid(reader);
    const animSid = await idGen.generateSid(reader);
    const imgId = await idGen.generateImageSpriteId(reader);
    const spriteData = createSpriteObject('Hero', sid, animSid, imgId);
    await writer.writeImageFiles([{
      objectName: 'Hero', animationName: 'Animation 1',
      frameIndex: 0, pluginId: 'Sprite',
    }]);
    await writer.writeEntityFile('objectTypes', 'Hero', spriteData);
    await writer.addToProject('objectTypes', 'Hero');

    // Add Platform behavior
    await writer.ensureAddonRegistered('behavior', 'Platform');
    reader.invalidateCaches();
    idGen.reset();

    const obj = await reader.readObjectType('Hero') as Record<string, unknown>;
    const bSid = await idGen.generateSid(reader);
    (obj.behaviorTypes as Array<Record<string, unknown>>).push(
      createBehavior('Platform', 'Platform', bSid),
    );
    await writer.writeEntityFile('objectTypes', 'Hero', obj);

    // Verify object type
    reader.invalidateCaches();
    const finalObj = await reader.readObjectType('Hero');
    expect(finalObj.name).toBe('Hero');
    expect(finalObj['plugin-id']).toBe('Sprite');
    expect(finalObj.behaviorTypes).toHaveLength(1);
    expect((finalObj.behaviorTypes as Array<Record<string, unknown>>)[0].behaviorId).toBe('Platform');

    // Verify usedAddons
    await reader.reloadProject();
    const addons = reader.getUsedAddons();
    expect(addons.some(a => a.type === 'behavior' && a.id === 'Platform')).toBe(true);

    // Verify animations still intact
    const animations = (finalObj as Record<string, unknown>).animations as { items: Array<Record<string, unknown>> };
    expect(animations.items).toHaveLength(1);
    expect(animations.items[0].name).toBe('Animation 1');

    // Verify PNG still exists
    const pngPath = join(tmpDir, 'images', 'hero-Animation 1-000.png');
    await expect(stat(pngPath)).resolves.toBeDefined();
  });
});
