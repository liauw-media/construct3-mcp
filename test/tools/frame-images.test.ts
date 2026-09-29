/**
 * Frame image files move with their frames (issue #36): the editor names a
 * frame's image lower("<object>-<animation>-NNN.<ext>") by frame index, so
 * add_frame_to_animation with an index and delete_frame_from_animation rename
 * the image files of the frames after it, keep the deleted frame's image and
 * any file in the way as .bak, and undo everything when a step fails.
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

  const insert = { objectName: 'Sprite', animationName: ANIMATION, index: 0 };
  const remove = { objectName: 'Sprite', animationName: ANIMATION, frameIndex: 0 };

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
