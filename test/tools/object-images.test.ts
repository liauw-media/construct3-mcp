/**
 * The image files of a deleted object type (issue #38): delete_object keeps
 * the files its frames or single image use as <file>.bak, as the frame tools
 * keep the image of a deleted frame, and validate_project reports files in
 * images/ named after no object type (orphaned-image). Checked on a temp copy
 * of the minimal fixture with the real reader and writer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { registerObjectTools } from '../../src/tools/object-tools.js';
import { validateProjectIntegrity } from '../../src/construct3/analyzers/integrity.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

type Json = Record<string, any>;

let tmpDir: string;
let reader: Construct3ProjectReader;
let writer: Construct3ProjectWriter;
let server: MockServer;

const imagesDir = () => join(tmpDir, 'images');
const images = async () => (await readdir(imagesDir())).sort();
const objectPath = (name: string) => join(tmpDir, 'objectTypes', `${name}.json`);
const call = async (tool: string, args: Json) => JSON.parse((await server.callTool(tool, args)).content[0].text);

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-object-images-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
  reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  writer = new Construct3ProjectWriter(reader, idGen);
  server = new MockServer();
  registerObjectTools({ server, reader, writer, idGen } as never);
  resetProjectIndex();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/**
 * A Sprite "Coin" with animation "Spin" (a PNG and a JPEG frame) in an
 * animation folder next to the placeholder animation, and the image files.
 */
async function createCoin(): Promise<void> {
  expect((await call('create_object', { name: 'Coin', pluginId: 'Sprite' })).success).toBe(true);
  const obj = JSON.parse(await readFile(objectPath('Coin'), 'utf8'));
  obj.animations.subfolders = [{
    name: 'Moves',
    items: [{
      ...obj.animations.items[0], name: 'Spin', sid: 300000000000777,
      frames: [
        { ...obj.animations.items[0].frames[0], imageSpriteId: 1234567 },
        { ...obj.animations.items[0].frames[0], imageSpriteId: 1234568, fileType: 'image/jpeg' },
      ],
    }],
    subfolders: [],
  }];
  await writeFile(objectPath('Coin'), JSON.stringify(obj, null, '\t'));
  await writeFile(join(imagesDir(), 'coin-spin-000.png'), 'spin 0');
  await writeFile(join(imagesDir(), 'coin-spin-001.jpg'), 'spin 1');
  await reader.loadProject();
}

describe('delete_object keeps the object\'s image files as .bak', () => {
  it('renames every frame image of every animation, animation folders and JPEG frames included', async () => {
    await createCoin();
    expect(await images()).toEqual(['coin-animation 1-000.png', 'coin-spin-000.png', 'coin-spin-001.jpg']);

    const data = await call('delete_object', { name: 'Coin' });
    expect(data.success).toBe(true);
    expect(await images()).toEqual(['coin-animation 1-000.png.bak', 'coin-spin-000.png.bak', 'coin-spin-001.jpg.bak']);
    expect(await readFile(join(imagesDir(), 'coin-spin-001.jpg.bak'), 'utf8')).toBe('spin 1');
    expect(data.warnings.join(' ')).toContain('Kept the object\'s 3 image file(s) in images/ as .bak');

    resetProjectIndex();
    const result = await validateProjectIntegrity(reader);
    expect(result.info.filter(i => i.check === 'orphaned-image')).toEqual([]);
    expect(result.info.filter(i => i.check === 'backup-file' && i.entity.startsWith('images/'))).toHaveLength(3);
  });

  it('keeps the single image of a Tiled Background, next to an existing .bak', async () => {
    expect((await call('create_object', { name: 'Wall', pluginId: 'TiledBg' })).success).toBe(true);
    await writeFile(join(imagesDir(), 'wall.png.bak'), 'older backup');
    await reader.loadProject();

    const data = await call('delete_object', { name: 'Wall' });
    expect(data.success).toBe(true);
    expect(await images()).toEqual(['wall.png.1.bak', 'wall.png.bak']);
    expect(await readFile(join(imagesDir(), 'wall.png.bak'), 'utf8')).toBe('older backup');
  });

  it('leaves a file in place that another object type\'s frames use under the same name', async () => {
    await createCoin();
    // Another object type whose file names it "coin" (a hand-edited copy) with an animation
    // "Spin": its frames use the same image files as those of "Coin"
    const other = JSON.parse(await readFile(objectPath('Coin'), 'utf8'));
    other.name = 'coin';
    other.sid = 200000000000999;
    other.animations = { items: [{ ...other.animations.subfolders[0].items[0], sid: 300000000000999 }], subfolders: [] };
    await writeFile(objectPath('CoinCopy'), JSON.stringify(other, null, '\t'));
    const project = JSON.parse(await readFile(join(tmpDir, 'project.c3proj'), 'utf8'));
    project.objectTypes.items.push('CoinCopy');
    await writeFile(join(tmpDir, 'project.c3proj'), JSON.stringify(project, null, '\t'));
    await reader.loadProject();

    const data = await call('delete_object', { name: 'Coin' });
    expect(data.success).toBe(true);
    expect(await images()).toEqual(['coin-animation 1-000.png.bak', 'coin-spin-000.png', 'coin-spin-001.jpg']);
    expect(data.warnings.join(' ')).toContain('another object type\'s frames use a file of the same name');
  });

  it('renames the image files back when the object file cannot be deleted', async () => {
    await createCoin();
    writer.deleteEntityFile = async () => { throw new Error('disk full'); };

    const result = await server.callTool('delete_object', { name: 'Coin' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Its image files were renamed back from .bak');
    expect(await images()).toEqual(['coin-animation 1-000.png', 'coin-spin-000.png', 'coin-spin-001.jpg']);
  });

  it('restores the object file and renames the images back when project.c3proj cannot be updated', async () => {
    await createCoin();
    const before = await readFile(objectPath('Coin'), 'utf8');
    writer.removeFromProject = async () => { throw new Error('project.c3proj is read-only'); };

    const result = await server.callTool('delete_object', { name: 'Coin' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('project.c3proj is read-only. The object file was restored from its backup. ' +
      'Its image files were renamed back from .bak.');
    expect(await readFile(objectPath('Coin'), 'utf8')).toBe(before);
    expect(await images()).toEqual(['coin-animation 1-000.png', 'coin-spin-000.png', 'coin-spin-001.jpg']);
    resetProjectIndex();
    const check = await validateProjectIntegrity(reader);
    expect(check.errors.filter(e => e.check === 'file-existence')).toEqual([]);
  });

  it('names the image files to rename back by hand when renaming them back fails', async () => {
    await createCoin();
    writer.removeFromProject = async () => { throw new Error('project.c3proj is read-only'); };
    const rename = writer.renameImageFiles.bind(writer);
    let calls = 0;
    writer.renameImageFiles = async renames => {
      if (++calls > 1) throw new Error('images/ is locked');
      return rename(renames);
    };

    const result = await server.callTool('delete_object', { name: 'Coin' });
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain('The object file was restored from its backup.');
    expect(text).toContain('Renaming its image files back from .bak failed too (images/ is locked); rename them back by hand: ' +
      '"images/coin-animation 1-000.png.bak" → "images/coin-animation 1-000.png"');
    expect(text).toContain('"images/coin-spin-001.jpg.bak" → "images/coin-spin-001.jpg".');
  });
});

/**
 * A write refused because its file changed on disk during the call (#51):
 * the writer puts back what the call changed, or names the files it has to
 * leave as they are; delete_object renames the images back, which the writer
 * does not track, and never restores the object file over a save of the
 * editor.
 */
describe('delete_object refused because a file changed on disk during the call', () => {
  const IMAGES = ['coin-animation 1-000.png', 'coin-spin-000.png', 'coin-spin-001.jpg'];

  /** The object file as the editor saves it with a new instance variable. */
  async function editorText(): Promise<string> {
    const obj = JSON.parse(await readFile(objectPath('Coin'), 'utf8'));
    obj.instanceVariables = [...(obj.instanceVariables ?? []), { name: 'fromEditor', type: 'number', initialValue: 0, sid: 900000000000123 }];
    return JSON.stringify(obj, null, '\t');
  }

  it('renames the images back when the object file was saved in the editor before its delete', async () => {
    await createCoin();
    const saved = await editorText();
    const deleteEntityFile = writer.deleteEntityFile.bind(writer);
    writer.deleteEntityFile = async (...args) => {
      await writeFile(objectPath('Coin'), saved);
      return deleteEntityFile(...args);
    };

    const result = await server.callTool('delete_object', { name: 'Coin' });
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain('objectTypes/Coin.json was changed on disk after this server read it');
    expect(text).toContain('it reads the file as it is now. Its image files were renamed back from .bak.');
    expect(text).not.toContain('The object file was restored');
    expect(await readFile(objectPath('Coin'), 'utf8')).toBe(saved);
    expect(await images()).toEqual(IMAGES);
    expect(reader.getProject().objectTypes.items).toContain('Coin');
  });

  it('leaves an object file the editor saved again after the delete as it is when project.c3proj keeps changing', async () => {
    await createCoin();
    const saved = await editorText();
    const removeFromProject = writer.removeFromProject.bind(writer);
    writer.removeFromProject = async (...args) => {
      // The object file is deleted by now: the editor saves it again
      await writeFile(objectPath('Coin'), saved);
      return removeFromProject(...args);
    };
    // project.c3proj changes between each read of the update and its write, so the update is refused
    const internals = writer as unknown as { createBackup: (path: string) => Promise<string> };
    const createBackup = internals.createBackup.bind(writer);
    let saves = 0;
    internals.createBackup = async (path: string) => {
      const backup = await createBackup(path);
      if (path.endsWith('project.c3proj')) {
        const project = JSON.parse(await readFile(join(tmpDir, 'project.c3proj'), 'utf8'));
        project.properties.author = `Editor${'!'.repeat(++saves)}`;
        await writeFile(join(tmpDir, 'project.c3proj'), JSON.stringify(project, null, '\t'));
      }
      return backup;
    };

    const result = await server.callTool('delete_object', { name: 'Coin' });
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain('project.c3proj was changed on disk after this server read it');
    expect(text).toContain('left as they are (changed on disk again after this call wrote them, or their backup was replaced): ' +
      'objectTypes/Coin.json (its state from before the call is in objectTypes/Coin.json.bak)');
    expect(text).toContain('before you run the tool again. Its image files were renamed back from .bak.');
    expect(text).not.toContain('The object file was restored');
    expect(await readFile(objectPath('Coin'), 'utf8')).toBe(saved);
    expect(await images()).toEqual(IMAGES);
  });
});

/**
 * An update of project.c3proj that fails for another reason than a refusal
 * as stale: the writer puts back the object file (undoToolCall), with the
 * same checks as after a refusal, so one saved in the editor during the call
 * is never overwritten with its backup.
 */
describe('delete_object whose project.c3proj update fails otherwise', () => {
  it('leaves an object file the editor saved again after the delete as it is when project.c3proj cannot be read', async () => {
    await createCoin();
    const obj = JSON.parse(await readFile(objectPath('Coin'), 'utf8'));
    obj.instanceVariables = [...(obj.instanceVariables ?? []), { name: 'fromEditor', type: 'number', initialValue: 0, sid: 900000000000123 }];
    const saved = JSON.stringify(obj, null, '\t');
    const removeFromProject = writer.removeFromProject.bind(writer);
    writer.removeFromProject = async (...args) => {
      // The object file is deleted by now: the editor saves it again and is still writing project.c3proj
      await writeFile(objectPath('Coin'), saved);
      const project = await readFile(join(tmpDir, 'project.c3proj'), 'utf8');
      await writeFile(join(tmpDir, 'project.c3proj'), project.slice(0, project.length / 2));
      return removeFromProject(...args);
    };

    const result = await server.callTool('delete_object', { name: 'Coin' });
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain('project.c3proj changed on disk and could not be read again');
    expect(text).toContain('Left as they are (changed on disk again after this call wrote them, or their backup was replaced): ' +
      'objectTypes/Coin.json (its state from before the call is in objectTypes/Coin.json.bak). ' +
      'Check the project (validate_project, git diff) before you run the tool again. Its image files were renamed back from .bak.');
    expect(text).not.toContain('The object file was restored');
    expect(await readFile(objectPath('Coin'), 'utf8')).toBe(saved);
    expect(await images()).toEqual(['coin-animation 1-000.png', 'coin-spin-000.png', 'coin-spin-001.jpg']);
  });
});

describe('validate_project orphaned-image', () => {
  it('reports files in images/ named after no object type, grouped by the name they were stored for', async () => {
    await mkdir(imagesDir(), { recursive: true });
    await writeFile(join(imagesDir(), 'sprite-animation 1-000.png'), 'used by Sprite');
    await writeFile(join(imagesDir(), 'sprite-animation 1-007.png'), 'past the last frame of Sprite');
    await writeFile(join(imagesDir(), 'ghost-walk-000.png'), 'deleted object');
    await writeFile(join(imagesDir(), 'ghost-walk-001.png'), 'deleted object');
    await writeFile(join(imagesDir(), 'rock.png'), 'deleted tiled background');
    await writeFile(join(imagesDir(), 'rock.png.bak'), 'a backup');

    const result = await validateProjectIntegrity(reader);
    const orphaned = result.info.filter(i => i.check === 'orphaned-image');
    expect(orphaned.map(i => i.entity)).toEqual(['images/ghost-walk-000.png', 'images/rock.png']);
    expect(orphaned[0].message).toContain('2 file(s) in images/ are named after no object type');
    expect(orphaned[0].message).toContain('images/ghost-walk-001.png');
  });
});
