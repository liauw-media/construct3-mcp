/**
 * Construct3ProjectWriter: listing and renaming files in images/ (all or
 * nothing), restoring an entity file from its backup (also after a failed
 * write), and image files written only directly in images/, on a temp copy of
 * the minimal fixture. Directory listings are compared exactly, since
 * stat/exists ignore case on Windows and macOS.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, cp, mkdir, readFile, readdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter, EntityWriteError } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

let tmpDir: string;
let writer: Construct3ProjectWriter;

async function images(): Promise<string[]> {
  return (await readdir(join(tmpDir, 'images'))).sort();
}

async function addImages(files: Record<string, string>): Promise<void> {
  await mkdir(join(tmpDir, 'images'), { recursive: true });
  for (const [name, content] of Object.entries(files)) await writeFile(join(tmpDir, 'images', name), content);
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-image-renames-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
  const reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  writer = new Construct3ProjectWriter(reader, new IdGenerator());
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('listImageFiles', () => {
  it('is empty without an images/ folder and lists its entries otherwise', async () => {
    expect(await writer.listImageFiles()).toEqual([]);
    await addImages({ 'a-b-000.png': 'a', 'a-b-001.jpg': 'b' });
    expect((await writer.listImageFiles()).sort()).toEqual(['a-b-000.png', 'a-b-001.jpg']);
  });
});

describe('renameImageFiles', () => {
  it('renames the files and keeps their content', async () => {
    await addImages({ 'hero-walk-000.png': 'frame 0', 'hero-walk-001.jpg': 'frame 1' });
    await writer.renameImageFiles([
      { from: 'hero-walk-000.png', to: 'hero-run-000.png' },
      { from: 'hero-walk-001.jpg', to: 'hero-run-001.jpg' },
    ]);
    expect(await images()).toEqual(['hero-run-000.png', 'hero-run-001.jpg']);
    expect(await readFile(join(tmpDir, 'images', 'hero-run-001.jpg'), 'utf8')).toBe('frame 1');
  });

  it('changes only the case of a name', async () => {
    await addImages({ 'Hero-Walk-000.png': 'frame 0' });
    await writer.renameImageFiles([{ from: 'Hero-Walk-000.png', to: 'hero-walk-000.png' }]);
    expect(await images()).toEqual(['hero-walk-000.png']);
    expect(await readFile(join(tmpDir, 'images', 'hero-walk-000.png'), 'utf8')).toBe('frame 0');
  });

  it('renames nothing when a target name is taken, also by a name that differs only in case', async () => {
    await addImages({ 'hero-walk-000.png': 'frame 0', 'hero-walk-001.png': 'frame 1', 'Hero-Run-001.png': 'other' });
    await expect(writer.renameImageFiles([
      { from: 'hero-walk-000.png', to: 'hero-run-000.png' },
      { from: 'hero-walk-001.png', to: 'hero-run-001.png' },
    ])).rejects.toThrow('images/Hero-Run-001.png already exists. No image file was renamed.');
    expect(await images()).toEqual(['Hero-Run-001.png', 'hero-walk-000.png', 'hero-walk-001.png']);
    expect(await readFile(join(tmpDir, 'images', 'Hero-Run-001.png'), 'utf8')).toBe('other');
  });

  it('renames nothing when two files would get the same name', async () => {
    await addImages({ 'hero-walk-000.png': 'frame 0', 'hero-idle-000.png': 'other' });
    await expect(writer.renameImageFiles([
      { from: 'hero-walk-000.png', to: 'hero-run-000.png' },
      { from: 'hero-idle-000.png', to: 'Hero-Run-000.png' },
    ])).rejects.toThrow('Cannot rename two files to images/Hero-Run-000.png. No image file was renamed.');
    expect(await images()).toEqual(['hero-idle-000.png', 'hero-walk-000.png']);
  });

  it('renames the files back when a later rename fails', async () => {
    await addImages({ 'hero-walk-000.png': 'frame 0', 'hero-walk-001.png': 'frame 1' });
    await expect(writer.renameImageFiles([
      { from: 'hero-walk-000.png', to: 'hero-run-000.png' },
      { from: 'hero-walk-001.png', to: 'hero-run-001.png' },
      { from: 'hero-walk-002.png', to: 'hero-run-002.png' },
    ])).rejects.toThrow('The files renamed before were renamed back.');
    expect(await images()).toEqual(['hero-walk-000.png', 'hero-walk-001.png']);
  });

  it('renames in order, so files can move along a chain, and the reverse chain undoes it', async () => {
    await addImages({ 'hero-walk-000.png': 'frame 0', 'hero-walk-001.png': 'frame 1', 'hero-walk-002.png': 'left over' });
    const chain = [
      { from: 'hero-walk-002.png', to: 'hero-walk-002.png.bak' },
      { from: 'hero-walk-001.png', to: 'hero-walk-002.png' },
      { from: 'hero-walk-000.png', to: 'hero-walk-001.png' },
    ];
    await writer.renameImageFiles(chain);
    expect(await images()).toEqual(['hero-walk-001.png', 'hero-walk-002.png', 'hero-walk-002.png.bak']);
    expect(await readFile(join(tmpDir, 'images', 'hero-walk-002.png'), 'utf8')).toBe('frame 1');
    expect(await readFile(join(tmpDir, 'images', 'hero-walk-002.png.bak'), 'utf8')).toBe('left over');

    await writer.renameImageFiles(chain.map(r => ({ from: r.to, to: r.from })).reverse());
    expect(await images()).toEqual(['hero-walk-000.png', 'hero-walk-001.png', 'hero-walk-002.png']);
    expect(await readFile(join(tmpDir, 'images', 'hero-walk-002.png'), 'utf8')).toBe('left over');
  });

  it('refuses a chain in the wrong order before renaming anything', async () => {
    await addImages({ 'hero-walk-000.png': 'frame 0', 'hero-walk-001.png': 'frame 1' });
    await expect(writer.renameImageFiles([
      { from: 'hero-walk-000.png', to: 'hero-walk-001.png' },
      { from: 'hero-walk-001.png', to: 'hero-walk-002.png' },
    ])).rejects.toThrow('Cannot rename images/hero-walk-000.png to images/hero-walk-001.png: images/hero-walk-001.png already exists. No image file was renamed.');
    expect(await images()).toEqual(['hero-walk-000.png', 'hero-walk-001.png']);
    expect(await readFile(join(tmpDir, 'images', 'hero-walk-001.png'), 'utf8')).toBe('frame 1');
  });

  it('refuses names that are not plain file names in images/', async () => {
    await addImages({ 'hero-walk-000.png': 'frame 0' });
    for (const to of ['../hero-run-000.png', 'sub/hero-run-000.png', 'sub\\hero-run-000.png', '..', '']) {
      await expect(writer.renameImageFiles([{ from: 'hero-walk-000.png', to }])).rejects.toThrow('Invalid image file name');
    }
    expect(await images()).toEqual(['hero-walk-000.png']);
  });
});

describe('restoreEntityFile', () => {
  it('puts back the exact content the file had before writeEntityFile', async () => {
    const path = join(tmpDir, 'objectTypes', 'Sprite.json');
    const before = await readFile(path);
    const obj = JSON.parse(before.toString('utf8'));
    const backup = await writer.writeEntityFile('objectTypes', 'Sprite', { ...obj, isGlobal: !obj.isGlobal });
    expect(Buffer.compare(await readFile(path), before)).not.toBe(0);

    await writer.restoreEntityFile(backup);
    expect(Buffer.compare(await readFile(path), before)).toBe(0);
  });

  it('refuses paths that are not entity backups in the project', async () => {
    await expect(writer.restoreEntityFile(join(tmpDir, 'objectTypes', 'Sprite.json'))).rejects.toThrow('Not a backup');
    await expect(writer.restoreEntityFile(join(tmpDir, '..', 'elsewhere.json.bak'))).rejects.toThrow('Path traversal');
  });

  it('leaves a file that already holds the backup\'s content as it is', async () => {
    const path = join(tmpDir, 'objectTypes', 'Sprite.json');
    const obj = JSON.parse(await readFile(path, 'utf8'));
    const backup = await writer.writeEntityFile('objectTypes', 'Sprite', { ...obj, isGlobal: !obj.isGlobal });
    await writer.restoreEntityFile(backup);

    const atomicWrite = vi.spyOn(writer as unknown as { atomicWrite: () => Promise<void> }, 'atomicWrite');
    await writer.restoreEntityFile(backup);
    expect(atomicWrite).not.toHaveBeenCalled();
  });
});

describe('writeEntityFile failures', () => {
  it('carries the backup path when the file was replaced but the post-write check failed', async () => {
    const path = join(tmpDir, 'objectTypes', 'Sprite.json');
    const before = await readFile(path);
    const obj = JSON.parse(before.toString('utf8'));
    const failing = writer as unknown as { verifyWrittenFile: () => Promise<void> };
    failing.verifyWrittenFile = async () => { throw new Error('Post-write verification failed for "Sprite"'); };

    const error = await writer.writeEntityFile('objectTypes', 'Sprite', { ...obj, isGlobal: !obj.isGlobal }).catch(e => e);
    expect(error).toBeInstanceOf(EntityWriteError);
    expect(error.message).toBe('Post-write verification failed for "Sprite"');
    expect(error.backupPath).toBe(`${path}.bak`);
    // The file holds the new content until it is restored
    expect(Buffer.compare(await readFile(path), before)).not.toBe(0);
    await writer.restoreEntityFile(error.backupPath);
    expect(Buffer.compare(await readFile(path), before)).toBe(0);
  });

  it('throws the plain error when the data is refused before anything is written', async () => {
    const error = await writer.writeEntityFile('objectTypes', 'Sprite', null).catch(e => e);
    expect(error).not.toBeInstanceOf(EntityWriteError);
    expect(error.message).toContain('Cannot write null/undefined data');
  });
});

describe('writeImageFile', () => {
  it('refuses a file name with a path separator instead of writing into a subfolder of images/', async () => {
    await expect(writer.writeImageFile('Hero', 'Walk/Left', 0, 'Sprite')).rejects.toThrow('Invalid image file name "hero-walk/left-000.png"');
    await expect(writer.writeImageFile('Hero', 'Walk\\Left', 0, 'Sprite')).rejects.toThrow('Invalid image file name');
    await expect(readdir(join(tmpDir, 'images', 'hero-walk'))).rejects.toThrow();
  });
});
