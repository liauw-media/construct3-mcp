/**
 * rename_animation writes the object file, then each layout whose instances
 * start with the animation. When a write fails, what the call wrote before is
 * put back by the writer (undoToolCall), which leaves a file saved in the
 * editor after the call wrote it as it is; after a write refused as stale the
 * writer has done so already. A backup is never restored over a save of the
 * editor. The frame image files, which the writer does not track, are renamed
 * back in every case. Checked on a temp copy of the minimal fixture with the
 * real reader, writer and ID generator.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { registerAnimationTools } from '../../src/tools/animation-tools.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');
const OLD_IMAGE = 'sprite-animation 1-000.png';

type Json = Record<string, any>;

let tmpDir: string;
let reader: Construct3ProjectReader;
let writer: Construct3ProjectWriter;
let server: MockServer;

const objectPath = () => join(tmpDir, 'objectTypes', 'Sprite.json');
const layoutPath = (name: string) => join(tmpDir, 'layouts', `${name}.json`);
const readJson = async (file: string): Promise<Json> => JSON.parse(await readFile(file, 'utf8'));
const images = async () => (await readdir(join(tmpDir, 'images'))).sort();

/** `file` as the editor saves it: its JSON with `key` set to `value`. */
async function savedInEditor(file: string, key: string, value: unknown): Promise<string> {
  const data = await readJson(file);
  data[key] = value;
  const text = JSON.stringify(data, null, '\t');
  await writeFile(file, text);
  return text;
}

async function rename(): Promise<{ isError?: boolean; text: string }> {
  const result = await server.callTool('rename_animation', { objectName: 'Sprite', animationName: 'Animation 1', newName: 'Run' });
  return { isError: result.isError, text: result.content[0].text };
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-animation-rename-rollback-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
  // Two layouts whose Sprite instance starts with "Animation 1", and the frame's image
  const layout = await readJson(layoutPath('Layout 1'));
  layout.layers[0].instances[0].properties = { 'initial-animation': 'Animation 1' };
  await writeFile(layoutPath('Layout 1'), JSON.stringify(layout, null, '\t'));
  layout.name = 'Layout 2';
  layout.sid = 500000000000013;
  layout.layers[0].sid = 500000000000011;
  layout.layers[0].instances[0].uid = 1;
  layout.layers[0].instances[0].sid = 500000000000012;
  await writeFile(layoutPath('Layout 2'), JSON.stringify(layout, null, '\t'));
  const project = await readJson(join(tmpDir, 'project.c3proj'));
  project.layouts.items.push('Layout 2');
  await writeFile(join(tmpDir, 'project.c3proj'), JSON.stringify(project, null, '\t'));
  await mkdir(join(tmpDir, 'images'), { recursive: true });
  await writeFile(join(tmpDir, 'images', OLD_IMAGE), 'frame 0');

  reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  writer = new Construct3ProjectWriter(reader, idGen);
  server = new MockServer();
  registerAnimationTools({ server, reader, writer, idGen } as never);
  resetProjectIndex();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

it('renames the animation, its frame image and the instances that start with it', async () => {
  const result = await rename();
  expect(result.isError, result.text).toBeUndefined();
  expect((await readJson(objectPath())).animations.items[0].name).toBe('Run');
  expect(await images()).toEqual(['sprite-run-000.png']);
  for (const name of ['Layout 1', 'Layout 2']) {
    expect((await readJson(layoutPath(name))).layers[0].instances[0].properties['initial-animation']).toBe('Run');
  }
});

describe('rename_animation refused because a layout changed on disk during the call', () => {
  it('leaves an object file the editor saved again after the call wrote it as it is', async () => {
    let editorObject = '';
    let editorLayout = '';
    const write = writer.writeEntityFile.bind(writer);
    writer.writeEntityFile = async (category, ...rest) => {
      const backup = await write(category, ...rest);
      if (category === 'objectTypes') {
        // The editor saves the object again, and the first layout, which the call read before
        editorObject = await savedInEditor(objectPath(), 'isGlobal', true);
        editorLayout = await savedInEditor(layoutPath('Layout 1'), 'width', 12345);
      }
      return backup;
    };

    const result = await rename();
    expect(result.isError).toBe(true);
    expect(result.text).toContain('layouts/Layout 1.json was changed on disk after this server read it');
    expect(result.text).toContain('left as they are (changed on disk again after this call wrote them, or their backup was replaced): ' +
      'objectTypes/Sprite.json (its state from before the call is in objectTypes/Sprite.json.bak)');
    expect(result.text).toContain('Its frame image files have their old names again.');
    expect(result.text).not.toContain('restored from its backup');
    expect(await readFile(objectPath(), 'utf8')).toBe(editorObject);
    expect(await readFile(layoutPath('Layout 1'), 'utf8')).toBe(editorLayout);
    expect(await images()).toEqual([OLD_IMAGE]);
  });
});

describe('rename_animation whose layout write fails otherwise', () => {
  it('puts back the object and the layouts written before, and the image files', async () => {
    const objectBefore = await readFile(objectPath(), 'utf8');
    const layoutBefore = await readFile(layoutPath('Layout 1'), 'utf8');
    const write = writer.writeEntityFile.bind(writer);
    writer.writeEntityFile = async (category, name, ...rest) => {
      if (name === 'Layout 2') throw new Error('disk full');
      return write(category, name, ...rest);
    };

    const result = await rename();
    expect(result.isError).toBe(true);
    expect(result.text).toContain('disk full. The rename was rolled back: its frame image files have their old names again; ' +
      'put back as they were before the call: layouts/Layout 1.json, objectTypes/Sprite.json.');
    expect(await readFile(objectPath(), 'utf8')).toBe(objectBefore);
    expect(await readFile(layoutPath('Layout 1'), 'utf8')).toBe(layoutBefore);
    expect(await images()).toEqual([OLD_IMAGE]);
  });

  it('leaves a layout the editor saved again after the call wrote it as it is and names it', async () => {
    const objectBefore = await readFile(objectPath(), 'utf8');
    let editorLayout = '';
    const write = writer.writeEntityFile.bind(writer);
    writer.writeEntityFile = async (category, name, ...rest) => {
      if (name === 'Layout 2') throw new Error('disk full');
      const backup = await write(category, name, ...rest);
      if (name === 'Layout 1') editorLayout = await savedInEditor(layoutPath('Layout 1'), 'width', 12345);
      return backup;
    };

    const result = await rename();
    expect(result.isError).toBe(true);
    expect(result.text).toContain('disk full. The rename was rolled back only in part: its frame image files have their old names again; ' +
      'put back as they were before the call: objectTypes/Sprite.json; left as they are (changed on disk again after this call wrote them, ' +
      'or their backup was replaced): layouts/Layout 1.json (its state from before the call is in layouts/Layout 1.json.bak). ' +
      'Check the project (validate_project, git diff) before you run the tool again.');
    expect(await readFile(layoutPath('Layout 1'), 'utf8')).toBe(editorLayout);
    expect(await readFile(objectPath(), 'utf8')).toBe(objectBefore);
    expect(await images()).toEqual([OLD_IMAGE]);
  });

  it('leaves a layout the editor saved during its write as it is, and puts the object back', async () => {
    const objectBefore = await readFile(objectPath(), 'utf8');
    const layout = await readJson(layoutPath('Layout 1'));
    layout.width = 12345;
    const editorLayout = JSON.stringify(layout, null, '\t');
    // The editor saves the layout right after the writer replaced it, before the write is checked
    const internals = writer as unknown as { atomicWrite: (path: string, content: string | Buffer) => Promise<void> };
    const atomicWrite = internals.atomicWrite.bind(writer);
    let saves = 0;
    internals.atomicWrite = async (path, content) => {
      await atomicWrite(path, content);
      if (path.endsWith('Layout 1.json') && saves++ === 0) await writeFile(layoutPath('Layout 1'), editorLayout);
    };

    const result = await rename();
    expect(result.isError).toBe(true);
    expect(result.text).toContain('the file was changed by another write during this one');
    expect(result.text).toContain('layouts/Layout 1.json was left as that write left it. The rename was rolled back: ' +
      'its frame image files have their old names again; put back as they were before the call: objectTypes/Sprite.json.');
    expect(await readFile(layoutPath('Layout 1'), 'utf8')).toBe(editorLayout);
    expect(await readFile(objectPath(), 'utf8')).toBe(objectBefore);
    expect(await images()).toEqual([OLD_IMAGE]);
  });
});
