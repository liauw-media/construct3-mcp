/**
 * Frame image files move with their frames (issue #36): the editor names a
 * frame's image lower("<object>-<animation>-NNN.<ext>") by frame index, so
 * add_frame_to_animation with an index and delete_frame_from_animation rename
 * the image files of the frames after it, keep the deleted frame's image and
 * any file in the way as .bak, and undo everything when a step fails.
 * validate_project reports frames without an image file (frame-image).
 * Checked on a temp copy of the minimal fixture with the real reader and
 * writer; every image has distinct content, compared by hash before and after.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { generatePlaceholderPng } from '../../src/construct3/png-generator.js';
import { registerAnimationTools } from '../../src/tools/animation-tools.js';
import { validateProjectIntegrity } from '../../src/construct3/analyzers/integrity.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');
const ANIMATION = 'Animation 1';
const PREFIX = 'sprite-animation 1-';

let tmpDir: string;
let reader: Construct3ProjectReader;
let server: MockServer;
/** Content hash → label of every image a test wrote */
let labels: Map<string, string>;

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const objectPath = () => join(tmpDir, 'objectTypes', 'Sprite.json');
const imagesDir = () => join(tmpDir, 'images');

function register(writer: Construct3ProjectWriter, idGen: IdGenerator): MockServer {
  const mock = new MockServer();
  registerAnimationTools({ server: mock, reader, writer, idGen } as never);
  return mock;
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-frame-images-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
  reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  server = register(new Construct3ProjectWriter(reader, idGen), idGen);
  labels = new Map([[sha(generatePlaceholderPng(1, 1)), 'NEW']]);
  resetProjectIndex();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

interface FrameSetup {
  /** Label of the frame's image content */
  label: string;
  fileType?: string;
  /** File name of its image in images/ (default: the editor's name); null for none */
  file?: string | null;
}

const EXTENSIONS: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif' };

/**
 * Give the fixture Sprite's "Animation 1" these frames (imageSpriteId 1000 +
 * index) with their images, and write `extra` files (name → label) to images/.
 */
async function setupFrames(frames: FrameSetup[], extra: Record<string, string> = {}): Promise<void> {
  const obj = JSON.parse(await readFile(objectPath(), 'utf8'));
  obj.animations.items[0].frames = frames.map((frame, index) => ({
    width: 64, height: 64, originX: 0.5, originY: 0.5, duration: 1, imageSpriteId: 1000 + index,
    ...(frame.fileType !== undefined ? { fileType: frame.fileType } : {}),
  }));
  await writeFile(objectPath(), JSON.stringify(obj, null, '\t'));
  await mkdir(imagesDir(), { recursive: true });
  const files: Record<string, string> = { ...extra };
  frames.forEach((frame, index) => {
    if (frame.file === null) return;
    const ext = EXTENSIONS[frame.fileType ?? 'image/png'];
    files[frame.file ?? `${PREFIX}${String(index).padStart(3, '0')}.${ext}`] = frame.label;
  });
  for (const [name, label] of Object.entries(files)) {
    const content = Buffer.from(`image ${label}`);
    labels.set(sha(content), label);
    await writeFile(join(imagesDir(), name), content);
  }
  reader.invalidateCaches();
}

/** images/ as name → label of its content, names exactly as on disk. */
async function snapshot(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of (await readdir(imagesDir())).sort()) {
    const hash = sha(await readFile(join(imagesDir(), name)));
    out[name] = labels.get(hash) ?? `unknown ${hash.slice(0, 12)}`;
  }
  return out;
}

/** Shorthand: "000.png" → "sprite-animation 1-000.png". */
function images(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).map(([name, label]) => [`${PREFIX}${name}`, label]));
}

async function frameIds(): Promise<unknown[]> {
  const obj = JSON.parse(await readFile(objectPath(), 'utf8'));
  return obj.animations.items[0].frames.map((f: { imageSpriteId: number }) => f.imageSpriteId);
}

async function ok(tool: string, args: Record<string, unknown>, mock = server): Promise<Record<string, any>> {
  const result = await mock.callTool(tool, { objectName: 'Sprite', animationName: ANIMATION, ...args });
  expect(result.isError, result.content[0].text).toBeUndefined();
  return JSON.parse(result.content[0].text);
}

const ABC: FrameSetup[] = [{ label: 'A' }, { label: 'B' }, { label: 'C' }];

describe('add_frame_to_animation keeps every frame\'s image', () => {
  it('inserting at index 0 moves every image one index up', async () => {
    await setupFrames(ABC);
    const data = await ok('add_frame_to_animation', { index: 0 });

    expect(await snapshot()).toEqual(images({ '000.png': 'NEW', '001.png': 'A', '002.png': 'B', '003.png': 'C' }));
    expect((await frameIds()).slice(1)).toEqual([1000, 1001, 1002]);
    expect(data.warnings).toEqual([
      'Renamed 3 frame image file(s) in images/ one index up, with their frames ("sprite-animation 1-002.png" → "sprite-animation 1-003.png", …).',
    ]);
  });

  it('inserting in the middle moves only the images from that index on', async () => {
    await setupFrames(ABC);
    await ok('add_frame_to_animation', { index: 1 });

    expect(await snapshot()).toEqual(images({ '000.png': 'A', '001.png': 'NEW', '002.png': 'B', '003.png': 'C' }));
    const ids = await frameIds();
    expect([ids[0], ids[2], ids[3]]).toEqual([1000, 1001, 1002]);
  });

  it('inserting at the frame count appends and moves nothing', async () => {
    await setupFrames(ABC);
    const data = await ok('add_frame_to_animation', { index: 3 });

    expect(await snapshot()).toEqual(images({ '000.png': 'A', '001.png': 'B', '002.png': 'C', '003.png': 'NEW' }));
    expect((await frameIds()).slice(0, 3)).toEqual([1000, 1001, 1002]);
    expect(data.warnings).toBeUndefined();
  });

  it('moves JPEG and GIF frame images with their own extension', async () => {
    await setupFrames([
      { label: 'A' }, { label: 'J', fileType: 'image/jpeg' }, { label: 'G', fileType: 'image/gif' }, { label: 'P', fileType: 'image/png' },
    ]);
    await ok('add_frame_to_animation', { index: 1 });

    expect(await snapshot()).toEqual(images({
      '000.png': 'A', '001.png': 'NEW', '002.jpg': 'J', '003.gif': 'G', '004.png': 'P',
    }));
  });

  it('finds an image file whose name differs in case and gives it the lowercase name', async () => {
    await setupFrames([{ label: 'A' }, { label: 'B', file: 'Sprite-Animation 1-001.PNG' }]);
    await ok('add_frame_to_animation', { index: 0 });

    expect(await snapshot()).toEqual(images({ '000.png': 'NEW', '001.png': 'A', '002.png': 'B' }));
  });

  it('keeps a file no frame uses at the new last index as .bak instead of writing over it', async () => {
    // What delete_frame_from_animation of older versions left behind
    await setupFrames([{ label: 'A' }, { label: 'B' }], images({ '002.png': 'orphan' }));
    const data = await ok('add_frame_to_animation', { index: 0 });

    expect(await snapshot()).toEqual(images({ '000.png': 'NEW', '001.png': 'A', '002.png': 'B', '002.png.bak': 'orphan' }));
    expect(data.warnings).toContain('1 file(s) in images/ had the name a frame image needed, but no frame used them (e.g. images a deleted '
      + 'frame left behind); they were renamed instead of being replaced: "images/sprite-animation 1-002.png" → "images/sprite-animation 1-002.png.bak".');
  });

  it('appending keeps a file no frame uses as .bak too, next to an older .bak', async () => {
    await setupFrames([{ label: 'A' }, { label: 'B' }], images({ '002.png': 'orphan', '002.png.bak': 'older backup' }));
    const data = await ok('add_frame_to_animation', {});

    expect(await snapshot()).toEqual(images({
      '000.png': 'A', '001.png': 'B', '002.png': 'NEW', '002.png.bak': 'older backup', '002.png.1.bak': 'orphan',
    }));
    expect(data.warnings.join('\n')).toContain('"images/sprite-animation 1-002.png" → "images/sprite-animation 1-002.png.1.bak"');
  });

  it('keeps a PNG left next to a JPEG frame\'s image when the new frame\'s image needs its name', async () => {
    // Frame 1 is JPEG, and an unused 001.png sits next to its 001.jpg: 001.jpg moves up, the new frame's image is 001.png
    await setupFrames([{ label: 'A' }, { label: 'J', fileType: 'image/jpeg' }], images({ '001.png': 'stale png' }));
    await ok('add_frame_to_animation', { index: 1 });

    expect(await snapshot()).toEqual(images({
      '000.png': 'A', '001.png': 'NEW', '001.png.bak': 'stale png', '002.jpg': 'J',
    }));
  });

  it('refuses an index past the frame count before writing anything', async () => {
    await setupFrames(ABC);
    const before = await snapshot();
    const objectBefore = await readFile(objectPath());

    const result = await server.callTool('add_frame_to_animation', { objectName: 'Sprite', animationName: ANIMATION, index: 10 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Frame index 10 is out of range. Animation "Animation 1" has 3 frame(s): '
      + 'insert at an index from 0 to 3, or leave index out to append. Nothing was changed.');
    expect(await snapshot()).toEqual(before);
    expect(Buffer.compare(await readFile(objectPath()), objectBefore)).toBe(0);
    expect(await readdir(join(tmpDir, 'objectTypes'))).not.toContain('Sprite.json.bak');
  });

  it('warns about frames after the index that have no image file', async () => {
    await setupFrames([{ label: 'A' }, { label: 'B', file: null }, { label: 'C' }]);
    const data = await ok('add_frame_to_animation', { index: 0 });

    expect(await snapshot()).toEqual(images({ '000.png': 'NEW', '001.png': 'A', '003.png': 'C' }));
    expect(data.warnings).toContain('No image file in images/ for 1 frame(s) of "Animation 1" after the changed index '
      + '(expected "sprite-animation 1-001.png"); nothing was renamed for them.');
  });
});

describe('delete_frame_from_animation keeps every frame\'s image', () => {
  it('deleting the first frame keeps its image as .bak and moves the others one index down', async () => {
    await setupFrames(ABC);
    const data = await ok('delete_frame_from_animation', { frameIndex: 0 });

    expect(await snapshot()).toEqual(images({ '000.png': 'B', '000.png.bak': 'A', '001.png': 'C' }));
    expect(await frameIds()).toEqual([1001, 1002]);
    expect(data.warnings).toEqual([
      'Renamed 2 frame image file(s) in images/ one index down, with their frames ("sprite-animation 1-001.png" → "sprite-animation 1-000.png", …).',
      'The deleted frame\'s image was kept as a backup: "images/sprite-animation 1-000.png" → "images/sprite-animation 1-000.png.bak". '
        + 'No frame uses it; delete it when it is no longer needed.',
    ]);
  });

  it('deleting a middle frame moves only the images after it', async () => {
    await setupFrames(ABC);
    await ok('delete_frame_from_animation', { frameIndex: 1 });

    expect(await snapshot()).toEqual(images({ '000.png': 'A', '001.png': 'C', '001.png.bak': 'B' }));
    expect(await frameIds()).toEqual([1000, 1002]);
  });

  it('deleting the last frame only keeps its image as .bak', async () => {
    await setupFrames(ABC);
    const data = await ok('delete_frame_from_animation', { frameIndex: 2 });

    expect(await snapshot()).toEqual(images({ '000.png': 'A', '001.png': 'B', '002.png.bak': 'C' }));
    expect(data.warnings).toHaveLength(1);
    expect(data.warnings[0]).toContain('The deleted frame\'s image was kept as a backup');
  });

  it('moves JPEG and GIF frame images with their own extension', async () => {
    await setupFrames([
      { label: 'A' }, { label: 'J', fileType: 'image/jpeg' }, { label: 'G', fileType: 'image/gif' }, { label: 'P' },
    ]);
    await ok('delete_frame_from_animation', { frameIndex: 0 });

    expect(await snapshot()).toEqual(images({ '000.jpg': 'J', '000.png.bak': 'A', '001.gif': 'G', '002.png': 'P' }));
  });

  it('a later append no longer writes over the image of a frame that moved', async () => {
    await setupFrames(ABC);
    await ok('delete_frame_from_animation', { frameIndex: 0 });
    await ok('add_frame_to_animation', {});

    expect(await snapshot()).toEqual(images({ '000.png': 'B', '000.png.bak': 'A', '001.png': 'C', '002.png': 'NEW' }));
  });
});

describe('frame image names follow the object\'s stored name', () => {
  // "./Sprite" reaches objectTypes/Sprite.json too; the editor names the images after the name in that file
  it('delete_frame_from_animation with another path to the object file still moves the images', async () => {
    await setupFrames(ABC);
    await ok('delete_frame_from_animation', { objectName: './Sprite', frameIndex: 0 });

    expect(await snapshot()).toEqual(images({ '000.png': 'B', '000.png.bak': 'A', '001.png': 'C' }));
    expect(await frameIds()).toEqual([1001, 1002]);
  });

  it('add_frame_to_animation with another path to the object file moves the images and names the placeholder like the editor', async () => {
    await setupFrames(ABC);
    await ok('add_frame_to_animation', { objectName: './Sprite', index: 1 });

    expect(await snapshot()).toEqual(images({ '000.png': 'A', '001.png': 'NEW', '002.png': 'B', '003.png': 'C' }));
  });

  it('replace_sprite_image with another path to the object file writes the frame\'s own image file', async () => {
    await setupFrames(ABC);
    const png = generatePlaceholderPng(2, 2);
    labels.set(sha(png), 'REPLACED');
    await ok('replace_sprite_image', { objectName: './Sprite', frameIndex: 1, pngBase64: png.toString('base64') });

    expect(await snapshot()).toEqual(images({ '000.png': 'A', '001.png': 'REPLACED', '002.png': 'C' }));
  });
});

describe('frame image changes are undone when a step fails', () => {
  let objectBefore: Buffer;
  let imagesBefore: Record<string, string>;

  beforeEach(async () => {
    await setupFrames([{ label: 'A' }, { label: 'J', fileType: 'image/jpeg' }, { label: 'G', fileType: 'image/gif' }], images({ '003.png': 'orphan' }));
    objectBefore = await readFile(objectPath());
    imagesBefore = await snapshot();
  });

  async function expectUnchanged(): Promise<void> {
    expect(await snapshot()).toEqual(imagesBefore);
    expect(Buffer.compare(await readFile(objectPath()), objectBefore)).toBe(0);
  }

  /** A server whose writer's renameImageFiles fails part way the first time (after renaming files for real). */
  function failingRenames(): MockServer {
    class FailingRenameWriter extends Construct3ProjectWriter {
      private failed = false;
      override async renameImageFiles(renames: ReadonlyArray<{ from: string; to: string }>): Promise<void> {
        if (this.failed || renames.length === 0) return super.renameImageFiles(renames);
        this.failed = true;
        return super.renameImageFiles([...renames, { from: 'not-there.png', to: 'nowhere.png' }]);
      }
    }
    const idGen = new IdGenerator();
    return register(new FailingRenameWriter(reader, idGen), idGen);
  }

  /** A server whose writer refuses to write the object file (before replacing it). */
  function failingObjectWrite(): MockServer {
    class FailingObjectWriter extends Construct3ProjectWriter {
      override async writeEntityFile(...args: Parameters<Construct3ProjectWriter['writeEntityFile']>): Promise<string> {
        if (args[0] === 'objectTypes') throw new Error('disk full');
        return super.writeEntityFile(...args);
      }
    }
    const idGen = new IdGenerator();
    return register(new FailingObjectWriter(reader, idGen), idGen);
  }

  /** A server whose writer replaces the object file, then fails its post-write check. */
  function failingObjectVerify(): MockServer {
    const idGen = new IdGenerator();
    const writer = new Construct3ProjectWriter(reader, idGen);
    const internals = writer as unknown as { verifyWrittenFile: (path: string, name: string, text: string) => Promise<void> };
    internals.verifyWrittenFile = async () => { throw new Error('Post-write verification failed for "Sprite"'); };
    return register(writer, idGen);
  }

  /** A server whose writer creates the placeholder file, then fails writing it (e.g. a full disk). */
  function failingPlaceholderWrite(): MockServer {
    class PartialPlaceholderWriter extends Construct3ProjectWriter {
      override async writeImageFile(objectName: string, animationName: string, frameIndex: number): Promise<string> {
        const name = `${objectName}-${animationName}-${String(frameIndex).padStart(3, '0')}.png`.toLowerCase();
        await writeFile(join(imagesDir(), name), Buffer.alloc(0));
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      }
    }
    const idGen = new IdGenerator();
    return register(new PartialPlaceholderWriter(reader, idGen), idGen);
  }

  const insert = { objectName: 'Sprite', animationName: ANIMATION, index: 0 };
  const remove = { objectName: 'Sprite', animationName: ANIMATION, frameIndex: 0 };

  it('add_frame_to_animation: a placeholder write that failed part way is removed before the files are renamed back', async () => {
    for (const index of [0, 1]) {
      const result = await failingPlaceholderWrite().callTool('add_frame_to_animation', { ...insert, index });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('Error adding frame: ENOSPC: no space left on device, write. Nothing was changed: '
        + 'the image files have their old names again and the placeholder image was removed.');
      await expectUnchanged();
    }
  });

  it('add_frame_to_animation: a failed image rename renames the files back and writes nothing', async () => {
    const result = await failingRenames().callTool('add_frame_to_animation', insert);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('The files renamed before were renamed back.');
    await expectUnchanged();
  });

  it('add_frame_to_animation: a failed object write removes the placeholder and renames the files back', async () => {
    const result = await failingObjectWrite().callTool('add_frame_to_animation', insert);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Error adding frame: disk full. Nothing was changed: the image files have their old names again '
      + 'and the placeholder image was removed.');
    await expectUnchanged();
  });

  it('add_frame_to_animation: an object write that failed after replacing the file restores it too', async () => {
    const result = await failingObjectVerify().callTool('add_frame_to_animation', insert);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Post-write verification failed for "Sprite". Nothing was changed: the image files have '
      + 'their old names again, the placeholder image was removed and the object file was restored from its backup.');
    await expectUnchanged();
  });

  it('delete_frame_from_animation: a failed image rename renames the files back and writes nothing', async () => {
    const result = await failingRenames().callTool('delete_frame_from_animation', remove);
    expect(result.isError).toBe(true);
    await expectUnchanged();
  });

  it('delete_frame_from_animation: a failed object write renames the files back, the deleted frame\'s image included', async () => {
    for (const mock of [failingObjectWrite(), failingObjectVerify()]) {
      const result = await mock.callTool('delete_frame_from_animation', remove);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Nothing was changed: the image files have their old names again');
      await expectUnchanged();
    }
  });
});

describe('frame tools called in parallel', () => {
  /**
   * Add animation "run" to the fixture Sprite, with a PNG frame per label
   * (imageSpriteId 2000 + index) and its image.
   */
  async function addRunAnimation(runLabels: string[]): Promise<void> {
    const obj = JSON.parse(await readFile(objectPath(), 'utf8'));
    obj.animations.items.push({
      name: 'run', sid: 300000000000010, speed: 5, isLooping: false, isPingPong: false, repeatCount: 1, repeatTo: 0,
      frames: runLabels.map((_, index) => ({ width: 64, height: 64, originX: 0.5, originY: 0.5, duration: 1, imageSpriteId: 2000 + index })),
    });
    await writeFile(objectPath(), JSON.stringify(obj, null, '\t'));
    for (const [index, label] of runLabels.entries()) {
      const content = Buffer.from(`image ${label}`);
      labels.set(sha(content), label);
      await writeFile(join(imagesDir(), `sprite-run-${String(index).padStart(3, '0')}.png`), content);
    }
  }

  /**
   * Every frame of the animation shows its own image: the file at its index
   * holds the label its imageSpriteId started with (`labelOf`; NEW for a
   * frame added since), and no frame image file is left past the last frame.
   */
  async function expectFramesShowTheirImages(animationIndex: number, prefix: string, labelOf: Map<number, string>): Promise<void> {
    const obj = JSON.parse(await readFile(objectPath(), 'utf8'));
    const frames: Array<{ imageSpriteId: number }> = obj.animations.items[animationIndex].frames;
    const files = await snapshot();
    const fileAt = (index: number) => files[`${prefix}${String(index).padStart(3, '0')}.png`];
    expect(frames.map((_, index) => fileAt(index))).toEqual(frames.map(frame => labelOf.get(frame.imageSpriteId) ?? 'NEW'));
    expect(fileAt(frames.length)).toBeUndefined();
  }

  const call = (tool: string, args: Record<string, unknown>) =>
    server.callTool(tool, { objectName: 'Sprite', animationName: ANIMATION, ...args });
  const ABCD: FrameSetup[] = [{ label: 'A' }, { label: 'B' }, { label: 'C' }, { label: 'D' }];
  const abcd = new Map([[1000, 'A'], [1001, 'B'], [1002, 'C'], [1003, 'D']]);

  it('two inserts at index 0 of the same animation both keep every image', async () => {
    await setupFrames(ABCD);
    const results = await Promise.all([call('add_frame_to_animation', { index: 0 }), call('add_frame_to_animation', { index: 0 })]);

    expect(results.map(result => result.isError ? result.content[0].text : 'ok')).toEqual(['ok', 'ok']);
    expect(await snapshot()).toEqual(images({
      '000.png': 'NEW', '001.png': 'NEW', '002.png': 'A', '003.png': 'B', '004.png': 'C', '005.png': 'D',
    }));
    await expectFramesShowTheirImages(0, PREFIX, abcd);
  });

  it('an insert and a delete in the same animation both apply, and no image is lost', async () => {
    await setupFrames(ABCD);
    const results = await Promise.all([call('add_frame_to_animation', { index: 0 }), call('delete_frame_from_animation', { frameIndex: 0 })]);

    expect(results.map(result => result.isError ? result.content[0].text : 'ok')).toEqual(['ok', 'ok']);
    expect(await frameIds()).toHaveLength(4);
    await expectFramesShowTheirImages(0, PREFIX, abcd);
    const kept = Object.values(await snapshot());
    for (const label of ['A', 'B', 'C', 'D', 'NEW']) expect(kept).toContain(label);
  });

  it('inserts into two animations of the same Sprite both end up in the object file with their images', async () => {
    await setupFrames(ABCD);
    await addRunAnimation(['R0', 'R1', 'R2']);
    const results = await Promise.all([
      call('add_frame_to_animation', { index: 0 }),
      call('add_frame_to_animation', { animationName: 'run', index: 0 }),
    ]);

    expect(results.map(result => result.isError ? result.content[0].text : 'ok')).toEqual(['ok', 'ok']);
    await expectFramesShowTheirImages(0, PREFIX, abcd);
    await expectFramesShowTheirImages(1, 'sprite-run-', new Map([[2000, 'R0'], [2001, 'R1'], [2002, 'R2']]));
  });

  it('an update_frame in parallel does not write the object back without the inserted frame', async () => {
    await setupFrames(ABCD);
    const results = await Promise.all([call('add_frame_to_animation', { index: 0 }), call('update_frame', { frameIndex: 3, duration: 7 })]);

    expect(results.map(result => result.isError ? result.content[0].text : 'ok')).toEqual(['ok', 'ok']);
    const obj = JSON.parse(await readFile(objectPath(), 'utf8'));
    expect(obj.animations.items[0].frames).toHaveLength(5);
    expect(obj.animations.items[0].frames.map((frame: { duration: number }) => frame.duration)).toContain(7);
    await expectFramesShowTheirImages(0, PREFIX, abcd);
  });
});

describe('another write to the object file during a frame change', () => {
  /**
   * A server whose writer lets another write land on the object file right
   * after it replaced it (as a tool call outside the animation tools running
   * in parallel would): the file then holds `other(written, before)`.
   */
  function withOtherWrite(other: (written: string, before: string) => string, before: string): MockServer {
    const idGen = new IdGenerator();
    const writer = new Construct3ProjectWriter(reader, idGen);
    const internals = writer as unknown as { atomicWrite: (path: string, content: string | Buffer) => Promise<void> };
    const atomicWrite = internals.atomicWrite.bind(writer);
    internals.atomicWrite = async (path, content) => {
      await atomicWrite(path, content);
      if (path.endsWith('Sprite.json')) await writeFile(path, other(String(content), before));
    };
    return register(writer, idGen);
  }

  /** The JSON `text` with the first animation's speed set to 42 (what the other write changed). */
  const withSpeed42 = (text: string) => {
    const obj = JSON.parse(text);
    obj.animations.items[0].speed = 42;
    return JSON.stringify(obj, null, '\t');
  };

  let objectBefore: string;
  let imagesBefore: Record<string, string>;

  beforeEach(async () => {
    await setupFrames(ABC);
    objectBefore = await readFile(objectPath(), 'utf8');
    imagesBefore = await snapshot();
  });

  const insert = { objectName: 'Sprite', animationName: ANIMATION, index: 0 };
  const remove = { objectName: 'Sprite', animationName: ANIMATION, frameIndex: 0 };

  it('add_frame_to_animation: a write made on the old content is kept, and the image files are renamed back to match it', async () => {
    const result = await withOtherWrite((_written, before) => withSpeed42(before), objectBefore).callTool('add_frame_to_animation', insert);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Another write replaced the object file during this one (a tool call running in parallel?) '
      + 'without this call\'s change; the object file was left as that write left it. Nothing was changed: the image files have their '
      + 'old names again and the placeholder image was removed.');
    expect(await snapshot()).toEqual(imagesBefore);
    expect(await readFile(objectPath(), 'utf8')).toBe(withSpeed42(objectBefore));
  });

  it('add_frame_to_animation: a write made on top of the new frame keeps it, with its images', async () => {
    const result = await withOtherWrite(written => withSpeed42(written), objectBefore).callTool('add_frame_to_animation', insert);

    expect(result.isError, result.content[0].text).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.warnings).toContain('Another write changed the object file right after this one (a tool call running in parallel?). '
      + 'The file still has the new frame, so the image files stay as renamed, but the other write may have been made on older content: '
      + 're-read the object to check it.');
    expect(await snapshot()).toEqual(images({ '000.png': 'NEW', '001.png': 'A', '002.png': 'B', '003.png': 'C' }));
    const obj = JSON.parse(await readFile(objectPath(), 'utf8'));
    expect(obj.animations.items[0].speed).toBe(42);
    expect(obj.animations.items[0].frames).toHaveLength(4);
  });

  it('delete_frame_from_animation: a write made on the old content is kept, and the image files are renamed back to match it', async () => {
    const result = await withOtherWrite((_written, before) => withSpeed42(before), objectBefore).callTool('delete_frame_from_animation', remove);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('the object file was left as that write left it. Nothing was changed: '
      + 'the image files have their old names again.');
    expect(await snapshot()).toEqual(imagesBefore);
    expect(await readFile(objectPath(), 'utf8')).toBe(withSpeed42(objectBefore));
  });

  it('delete_frame_from_animation: a write made on top of the deletion keeps it, with the images moved', async () => {
    const result = await withOtherWrite(written => withSpeed42(written), objectBefore).callTool('delete_frame_from_animation', remove);

    expect(result.isError, result.content[0].text).toBeUndefined();
    expect(JSON.parse(result.content[0].text).warnings.join('\n')).toContain('The file still has the frame deletion');
    expect(await snapshot()).toEqual(images({ '000.png': 'B', '000.png.bak': 'A', '001.png': 'C' }));
    expect(await frameIds()).toEqual([1001, 1002]);
  });
});

describe('validate_project frame-image', () => {
  const frameIssues = async () => {
    resetProjectIndex();
    reader.invalidateCaches();
    const result = await validateProjectIntegrity(reader);
    return {
      warnings: result.warnings.filter(w => w.check === 'frame-image'),
      info: result.info.filter(i => i.check === 'frame-image'),
      valid: result.valid,
    };
  };

  it('reports nothing when every frame has its image, found ignoring case and by fileType', async () => {
    await setupFrames([
      { label: 'A', file: 'Sprite-Animation 1-000.PNG' }, { label: 'J', fileType: 'image/jpeg' }, { label: 'G', fileType: 'image/gif' },
    ]);
    expect(await frameIssues()).toEqual({ warnings: [], info: [], valid: true });
  });

  it('warns about frames without their image file, with the name each one needs', async () => {
    // Frame 1 is JPEG but only a PNG of its name exists; frame 2 has no file; frame 3 has an unknown fileType
    await setupFrames(
      [{ label: 'A' }, { label: 'J', fileType: 'image/jpeg', file: null }, { label: 'C', file: null }, { label: 'W', fileType: 'image/webp', file: null }],
      images({ '001.png': 'stale png' }),
    );
    const { warnings, valid } = await frameIssues();
    expect(valid).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].entity).toBe('objectTypes/Sprite/animation:Animation 1');
    expect(warnings[0].message).toBe('3 of 4 frame(s) of animation "Animation 1" have no image file: images/sprite-animation 1-001.jpg, '
      + 'images/sprite-animation 1-002.png, images/sprite-animation 1-003.*');
    expect(warnings[0].suggestion).toContain('what it does when the file is missing is not verified');
    expect(warnings[0].suggestion).not.toMatch(/will not open|refuses? to open/);
  });

  it('reports the frames an insert of older versions left without images, and the file a delete left behind', async () => {
    // add_frame_to_animation at index 1 on 3 frames before #36: the last frame had no file
    await setupFrames([{ label: 'A' }, { label: 'NEW' }, { label: 'C' }, { label: 'x', file: null }]);
    expect((await frameIssues()).warnings.map(w => w.message)).toEqual([
      '1 of 4 frame(s) of animation "Animation 1" have no image file: images/sprite-animation 1-003.png',
    ]);

    // delete_frame_from_animation before #36: the last file stayed
    await setupFrames([{ label: 'A' }, { label: 'B' }], images({ '002.png': 'C', '010.gif': 'D', '002.png.bak': 'backup' }));
    const { warnings, info } = await frameIssues();
    expect(warnings).toEqual([]);
    expect(info.map(i => [i.entity, i.message])).toEqual([[
      'objectTypes/Sprite/animation:Animation 1',
      '2 file(s) in images/ are named like frames of animation "Animation 1" past its last frame (it has 2), and no frame uses them: '
        + 'images/sprite-animation 1-002.png, images/sprite-animation 1-010.gif',
    ]]);
  });

  it('does not report a file another animation uses as unused', async () => {
    // "ANIMATION 1" (which older versions could create next to "Animation 1") uses the same lowercase
    // file names; its second frame uses 001.png, past the last frame of "Animation 1"
    await setupFrames([{ label: 'A' }], images({ '001.png': 'B' }));
    const obj = JSON.parse(await readFile(objectPath(), 'utf8'));
    const frame = { width: 64, height: 64, originX: 0.5, originY: 0.5, duration: 1 };
    obj.animations.items.push({
      name: 'ANIMATION 1', sid: 300000000000009, speed: 5, isLooping: false, isPingPong: false, repeatCount: 1, repeatTo: 0,
      frames: [frame, frame],
    });
    await writeFile(objectPath(), JSON.stringify(obj, null, '\t'));
    const { warnings, info } = await frameIssues();
    expect({ warnings, info }).toEqual({ warnings: [], info: [] });
  });

  it('is skipped when the project has no images/ folder', async () => {
    // The minimal fixture's Sprite has a frame, but there is no images/ folder
    expect(await frameIssues()).toEqual({ warnings: [], info: [], valid: true });
  });
});
