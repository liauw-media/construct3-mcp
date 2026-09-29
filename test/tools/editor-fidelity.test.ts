/**
 * Files and instances written by the tools match what the editor writes
 * (issue #33), checked on a temp copy of the minimal fixture with the real
 * reader and writer:
 * - image file names are lowercased as a whole (object AND animation name);
 *   readdir is compared exactly, since stat/exists ignore case on Windows/macOS
 * - layout instances carry an entry for every behavior of their object type
 * - rename_animation renames the frame image files and the instances'
 *   "initial-animation" with the animation, or changes nothing
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, cp, readdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { generatePlaceholderPng } from '../../src/construct3/png-generator.js';
import { BEHAVIOR_INSTANCE_DEFAULTS } from '../../src/construct3/templates.js';
import { registerMutationTools } from '../../src/tools/mutations.js';
import { validateProjectIntegrity } from '../../src/construct3/analyzers/integrity.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

let tmpDir: string;
let server: MockServer;
let reader: Construct3ProjectReader;

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const result = await server.callTool(name, args);
  expect(result.isError, result.content[0].text).toBeUndefined();
  return JSON.parse(result.content[0].text);
}

async function imagesOf(prefix: string): Promise<string[]> {
  return (await readdir(join(tmpDir, 'images'))).filter(f => f.toLowerCase().startsWith(prefix)).sort();
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-fidelity-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
  reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  server = new MockServer();
  registerMutationTools(server as never, reader, new Construct3ProjectWriter(reader, idGen), idGen);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('image file names', () => {
  it('create_object, add_animation_to_sprite and add_frame_to_animation write all-lowercase names', async () => {
    await call('create_object', { name: 'Sprite2', pluginId: 'Sprite' });
    await call('add_animation_to_sprite', { objectName: 'Sprite2', animationName: 'WalkLeft' });
    await call('add_frame_to_animation', { objectName: 'Sprite2', animationName: 'WalkLeft' });

    expect(await imagesOf('sprite2-')).toEqual([
      'sprite2-animation 1-000.png',
      'sprite2-walkleft-000.png',
      'sprite2-walkleft-001.png',
    ]);
    expect((await readdir(join(tmpDir, 'images'))).filter(f => /[A-Z]/.test(f))).toEqual([]);
  });

  it('replace_sprite_image writes the lowercase file the editor expects', async () => {
    await call('create_object', { name: 'Sprite2', pluginId: 'Sprite' });
    const png = generatePlaceholderPng(2, 2);
    await call('replace_sprite_image', {
      objectName: 'Sprite2', animationName: 'Animation 1', frameIndex: 0, pngBase64: png.toString('base64'),
    });

    expect(await imagesOf('sprite2-')).toEqual(['sprite2-animation 1-000.png']);
    expect(Buffer.compare(await readFile(join(tmpDir, 'images', 'sprite2-animation 1-000.png')), png)).toBe(0);
  });

  it('an animation name that differs only in case is refused and leaves the existing images alone', async () => {
    await call('create_object', { name: 'Sprite2', pluginId: 'Sprite' });
    await call('add_animation_to_sprite', { objectName: 'Sprite2', animationName: 'Walk', frameCount: 2 });
    const art = generatePlaceholderPng(2, 2);
    await call('replace_sprite_image', {
      objectName: 'Sprite2', animationName: 'Walk', frameIndex: 0, pngBase64: art.toString('base64'),
    });
    const before = await imagesOf('sprite2-');

    for (const [tool, args] of [
      ['add_animation_to_sprite', { objectName: 'Sprite2', animationName: 'walk' }],
      ['add_animation_to_sprite', { objectName: 'Sprite2', animationName: 'WALK', frameCount: 2 }],
      ['rename_animation', { objectName: 'Sprite2', animationName: 'Animation 1', newName: 'wALK' }],
    ] as const) {
      const result = await server.callTool(tool, args);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('only in case');
    }

    expect(await imagesOf('sprite2-')).toEqual(before);
    expect(Buffer.compare(await readFile(join(tmpDir, 'images', 'sprite2-walk-000.png')), art)).toBe(0);
    const obj = JSON.parse(await readFile(join(tmpDir, 'objectTypes', 'Sprite2.json'), 'utf8'));
    expect(obj.animations.items.map((a: { name: string }) => a.name)).toEqual(['Animation 1', 'Walk']);
  });

  it('replace_sprite_image switches a JPEG frame to PNG so the editor loads the new file', async () => {
    await call('create_object', { name: 'Sprite2', pluginId: 'Sprite' });
    // A frame the editor saved as JPEG: fileType image/jpeg, image in "<name>.jpg"
    const objPath = join(tmpDir, 'objectTypes', 'Sprite2.json');
    const obj = JSON.parse(await readFile(objPath, 'utf8'));
    obj.animations.items[0].frames[0].fileType = 'image/jpeg';
    await writeFile(objPath, JSON.stringify(obj, null, '\t'));
    await rm(join(tmpDir, 'images', 'sprite2-animation 1-000.png'));
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    await writeFile(join(tmpDir, 'images', 'sprite2-animation 1-000.jpg'), jpeg);

    const png = generatePlaceholderPng(2, 2);
    const data = await call('replace_sprite_image', {
      objectName: 'Sprite2', animationName: 'Animation 1', frameIndex: 0, pngBase64: png.toString('base64'),
    });

    const written = JSON.parse(await readFile(objPath, 'utf8'));
    expect(written.animations.items[0].frames[0].fileType).toBe('image/png');
    expect(await imagesOf('sprite2-')).toEqual(['sprite2-animation 1-000.jpg', 'sprite2-animation 1-000.png']);
    expect(Buffer.compare(await readFile(join(tmpDir, 'images', 'sprite2-animation 1-000.png')), png)).toBe(0);
    expect(Buffer.compare(await readFile(join(tmpDir, 'images', 'sprite2-animation 1-000.jpg')), jpeg)).toBe(0);
    expect(data.warnings.join('\n')).toContain('was stored as "image/jpeg" (images/sprite2-animation 1-000.jpg)');
  });

  it('replace_sprite_image leaves the fileType of a PNG frame alone and adds no warning', async () => {
    await call('create_object', { name: 'Sprite2', pluginId: 'Sprite' });
    const data = await call('replace_sprite_image', {
      objectName: 'Sprite2', animationName: 'Animation 1', frameIndex: 0,
      pngBase64: generatePlaceholderPng(2, 2).toString('base64'),
    });
    const written = JSON.parse(await readFile(join(tmpDir, 'objectTypes', 'Sprite2.json'), 'utf8'));
    expect(written.animations.items[0].frames[0].fileType).toBe('image/png');
    expect(data.warnings).toHaveLength(1);
    expect(data.warnings[0]).toContain('Image written to');
  });
});

describe('instance behavior entries', () => {
  async function instancesOf(type: string): Promise<Array<Record<string, any>>> {
    const layout = JSON.parse(await readFile(join(tmpDir, 'layouts', 'Layout 1.json'), 'utf8'));
    return layout.layers[0].instances.filter((i: { type: string }) => i.type === type);
  }

  it('instances placed before and after adding a behavior both carry its entry', async () => {
    await call('create_object', { name: 'Sprite2', pluginId: 'Sprite' });
    await call('add_instance_to_layout', { layoutName: 'Layout 1', layerName: 'Main', objectType: 'Sprite2', x: 1, y: 1 });
    await call('update_object_properties', { name: 'Sprite2', addBehaviors: [{ behaviorId: 'Tween', name: 'Tween' }] });
    await call('add_instance_to_layout', { layoutName: 'Layout 1', layerName: 'Main', objectType: 'Sprite2', x: 2, y: 2 });

    const instances = await instancesOf('Sprite2');
    expect(instances).toHaveLength(2);
    for (const instance of instances) {
      expect(instance.behaviors).toEqual({ Tween: { properties: { enabled: true } } });
    }

    await call('update_object_properties', { name: 'Sprite2', removeBehaviors: ['Tween'] });
    for (const instance of await instancesOf('Sprite2')) {
      expect(instance.behaviors).toEqual({});
    }
  });

  it('family behaviors are written first, then the object\'s own', async () => {
    await call('create_object', { name: 'Sprite2', pluginId: 'Sprite' });
    await call('update_object_properties', { name: 'Sprite2', addBehaviors: [{ behaviorId: 'Pin', name: 'Pin' }] });
    await call('create_family', { name: 'Family1', pluginId: 'Sprite', members: ['Sprite2'] });
    // The tools cannot add family behaviors; give the family one as the editor would
    const familyPath = join(tmpDir, 'families', 'Family1.json');
    const family = JSON.parse(await readFile(familyPath, 'utf8'));
    family.behaviorTypes.push({ behaviorId: 'Sin', name: 'Sine', sid: 123456789012345 });
    await writeFile(familyPath, JSON.stringify(family, null, '\t'));

    await call('add_instance_to_layout', { layoutName: 'Layout 1', layerName: 'Main', objectType: 'Sprite2', x: 1, y: 1 });
    const [instance] = await instancesOf('Sprite2');
    expect(Object.keys(instance.behaviors)).toEqual(['Sine', 'Pin']);
    expect(instance.behaviors.Sine).toEqual({ properties: { ...BEHAVIOR_INSTANCE_DEFAULTS.Sin } });
  });

  it('adding a behavior keeps the saved order of existing entries from several families', async () => {
    await call('create_object', { name: 'Sprite2', pluginId: 'Sprite' });
    await call('create_family', { name: 'Family2', pluginId: 'Sprite', members: ['Sprite2'] });
    await call('create_family', { name: 'Family1', pluginId: 'Sprite', members: ['Sprite2'] });
    for (const [name, behavior] of [
      ['Family2', { behaviorId: 'Fade', name: 'Fade', sid: 223456789012345 }],
      ['Family1', { behaviorId: 'Sin', name: 'Sine', sid: 323456789012345 }],
    ] as const) {
      const familyPath = join(tmpDir, 'families', `${name}.json`);
      const family = JSON.parse(await readFile(familyPath, 'utf8'));
      family.behaviorTypes.push(behavior);
      await writeFile(familyPath, JSON.stringify(family, null, '\t'));
    }
    await call('add_instance_to_layout', { layoutName: 'Layout 1', layerName: 'Main', objectType: 'Sprite2', x: 1, y: 1 });

    // An instance saved with the family entries in the other order
    const layoutPath = join(tmpDir, 'layouts', 'Layout 1.json');
    const layout = JSON.parse(await readFile(layoutPath, 'utf8'));
    const saved = layout.layers[0].instances.find((i: { type: string }) => i.type === 'Sprite2');
    saved.behaviors = { Sine: { properties: { ...saved.behaviors.Sine.properties, magnitude: 7 } }, Fade: saved.behaviors.Fade };
    await writeFile(layoutPath, JSON.stringify(layout, null, '\t'));
    reader.invalidateCaches();

    await call('update_object_properties', { name: 'Sprite2', addBehaviors: [{ behaviorId: 'Tween', name: 'Tween' }] });
    const [instance] = await instancesOf('Sprite2');
    expect(Object.keys(instance.behaviors)).toEqual(['Sine', 'Fade', 'Tween']);
    expect(instance.behaviors.Sine.properties.magnitude).toBe(7);
  });

  /** Replace the behaviors of the instances of `type` in Layout 1, in order, as an older version or a hand edit left them. */
  async function setSavedBehaviors(type: string, ...behaviors: Array<Record<string, unknown>>): Promise<void> {
    const layoutPath = join(tmpDir, 'layouts', 'Layout 1.json');
    const layout = JSON.parse(await readFile(layoutPath, 'utf8'));
    const instances = layout.layers[0].instances.filter((i: { type: string }) => i.type === type);
    expect(instances).toHaveLength(behaviors.length);
    instances.forEach((instance: Record<string, unknown>, i: number) => { instance.behaviors = behaviors[i]; });
    await writeFile(layoutPath, JSON.stringify(layout, null, '\t'));
    reader.invalidateCaches();
  }

  /** Write a behavior into a family file, as the editor would (the tools cannot add family behaviors). */
  async function addFamilyBehavior(family: string, behavior: Record<string, unknown>): Promise<void> {
    const familyPath = join(tmpDir, 'families', `${family}.json`);
    const data = JSON.parse(await readFile(familyPath, 'utf8'));
    data.behaviorTypes.push(behavior);
    await writeFile(familyPath, JSON.stringify(data, null, '\t'));
    reader.invalidateCaches();
  }

  const missingEntryWarnings = async () =>
    (await validateProjectIntegrity(reader)).warnings.filter(w => w.check === 'missing-behavior-entry');

  it('a behavior change also adds the entries an instance lacks, and keeps existing values', async () => {
    await call('create_object', { name: 'Hero', pluginId: 'Sprite' });
    await call('update_object_properties', { name: 'Hero', addBehaviors: [{ behaviorId: 'Tween', name: 'Tween' }] });
    await call('add_instance_to_layout', { layoutName: 'Layout 1', layerName: 'Main', objectType: 'Hero', x: 1, y: 1 });
    await call('add_instance_to_layout', { layoutName: 'Layout 1', layerName: 'Main', objectType: 'Hero', x: 2, y: 2 });
    // The first as older versions wrote it (no entries), the second with its own Tween values
    await setSavedBehaviors('Hero', {}, { Tween: { properties: { enabled: false } } });
    const warningsBefore = await missingEntryWarnings();
    expect(warningsBefore.map(w => w.message)).toEqual([expect.stringMatching(/^1 instance\(s\) of "Hero" \(uid \d+\) have no entry for behavior\(s\) "Tween"$/)]);

    const data = await call('update_object_properties', { name: 'Hero', addBehaviors: [{ behaviorId: 'Bullet', name: 'Bullet' }] });

    const [first, second] = await instancesOf('Hero');
    expect(Object.keys(first.behaviors)).toEqual(['Tween', 'Bullet']);
    expect(first.behaviors.Tween).toEqual({ properties: { ...BEHAVIOR_INSTANCE_DEFAULTS.Tween } });
    expect(first.behaviors.Bullet).toEqual({ properties: { ...BEHAVIOR_INSTANCE_DEFAULTS.Bullet } });
    expect(second.behaviors).toEqual({
      Tween: { properties: { enabled: false } },
      Bullet: { properties: { ...BEHAVIOR_INSTANCE_DEFAULTS.Bullet } },
    });
    expect(data.warnings).toContain('Also added default entries for behavior(s) "Tween" to 1 instance(s) of "Hero" that had none '
      + '(written by an older version of construct3-mcp or edited by hand). Construct 3 stores an entry for every behavior of the object and its families on each instance.');
    expect(await missingEntryWarnings()).toEqual([]);
  });

  it('an instance variable change adds the missing entries too, and reports nothing when none are missing', async () => {
    await call('create_object', { name: 'Hero', pluginId: 'Sprite' });
    await call('update_object_properties', { name: 'Hero', addBehaviors: [{ behaviorId: 'Tween', name: 'Tween' }] });
    await call('add_instance_to_layout', { layoutName: 'Layout 1', layerName: 'Main', objectType: 'Hero', x: 1, y: 1 });

    const complete = await call('update_object_properties', { name: 'Hero', addVariables: [{ name: 'hp', type: 'number' }] });
    // Only the new variable's default value was added to the instance
    expect(complete.warnings).toEqual(['Updated instances in layout(s): Layout 1']);
    expect((await instancesOf('Hero'))[0].instanceVariables).toEqual({ hp: 0 });

    await setSavedBehaviors('Hero', {});
    const data = await call('update_object_properties', { name: 'Hero', removeVariables: ['hp'] });
    const [instance] = await instancesOf('Hero');
    expect(instance.behaviors).toEqual({ Tween: { properties: { ...BEHAVIOR_INSTANCE_DEFAULTS.Tween } } });
    expect(data.warnings.join('\n')).toContain('Also added default entries for behavior(s) "Tween" to 1 instance(s) of "Hero"');
  });

  it('a family membership change adds the entries an instance lacks in editor order, and so does deleting a family', async () => {
    await call('create_object', { name: 'Hero', pluginId: 'Sprite' });
    await call('update_object_properties', { name: 'Hero', addBehaviors: [{ behaviorId: 'Tween', name: 'Tween' }] });
    await call('create_family', { name: 'Movers', pluginId: 'Sprite', members: ['Hero'] });
    await call('create_family', { name: 'Blinkers', pluginId: 'Sprite', members: [] });
    await addFamilyBehavior('Movers', { behaviorId: 'Sin', name: 'Sine', sid: 423456789012345 });
    await addFamilyBehavior('Blinkers', { behaviorId: 'Flash', name: 'Flash', sid: 523456789012345 });
    await call('add_instance_to_layout', { layoutName: 'Layout 1', layerName: 'Main', objectType: 'Hero', x: 1, y: 1 });
    // Saved without the entry for the family behavior, with its own Tween values
    await setSavedBehaviors('Hero', { Tween: { properties: { enabled: false } } });

    const joined = await call('update_family', { name: 'Blinkers', addMembers: ['Hero'] });
    let [instance] = await instancesOf('Hero');
    expect(Object.keys(instance.behaviors)).toEqual(['Sine', 'Flash', 'Tween']);
    expect(instance.behaviors.Sine).toEqual({ properties: { ...BEHAVIOR_INSTANCE_DEFAULTS.Sin } });
    expect(instance.behaviors.Flash).toEqual({ properties: { ...BEHAVIOR_INSTANCE_DEFAULTS.Flash } });
    expect(instance.behaviors.Tween).toEqual({ properties: { enabled: false } });
    expect(joined.warnings.join('\n')).toContain('Also added default entries for behavior(s) "Sine" to 1 instance(s) of "Hero"');
    expect(joined.warnings.join('\n')).not.toContain('"Flash" to');

    await setSavedBehaviors('Hero', { Flash: { properties: { enabled: false } }, Tween: { properties: { enabled: false } } });
    const deleted = await call('delete_family', { name: 'Blinkers' });
    [instance] = await instancesOf('Hero');
    expect(Object.keys(instance.behaviors)).toEqual(['Sine', 'Tween']);
    expect(instance.behaviors.Tween).toEqual({ properties: { enabled: false } });
    expect(deleted.warnings.join('\n')).toContain('Also added default entries for behavior(s) "Sine" to 1 instance(s) of "Hero"');
    expect(await missingEntryWarnings()).toEqual([]);
  });
});

describe('rename_animation', () => {
  const objectPath = () => join(tmpDir, 'objectTypes', 'Sprite2.json');
  const layoutPath = () => join(tmpDir, 'layouts', 'Layout 1.json');

  /** Sprite2 with animations "Animation 1" and "Walk" (3 frames, frame 1 with its own image), one instance starting with "Walk". */
  async function spriteWithWalk(): Promise<Buffer> {
    await call('create_object', { name: 'Sprite2', pluginId: 'Sprite' });
    await call('add_animation_to_sprite', { objectName: 'Sprite2', animationName: 'Walk', frameCount: 3 });
    const art = generatePlaceholderPng(3, 3);
    await call('replace_sprite_image', {
      objectName: 'Sprite2', animationName: 'Walk', frameIndex: 1, pngBase64: art.toString('base64'),
    });
    await call('add_instance_to_layout', {
      layoutName: 'Layout 1', layerName: 'Main', objectType: 'Sprite2', x: 1, y: 1,
      properties: { 'initially-visible': true, 'initial-animation': 'Walk', 'initial-frame': 0, 'enable-collisions': true, 'live-preview': false },
    });
    return art;
  }

  async function initialAnimations(): Promise<string[]> {
    const layout = JSON.parse(await readFile(layoutPath(), 'utf8'));
    return layout.layers[0].instances
      .filter((i: { type: string }) => i.type === 'Sprite2')
      .map((i: { properties: Record<string, string> }) => i.properties['initial-animation']);
  }

  const problems = async () => {
    const result = await validateProjectIntegrity(reader);
    return { errors: result.errors, warnings: result.warnings };
  };

  it('renames the frame image files with the animation and updates the instances that start with it', async () => {
    const art = await spriteWithWalk();
    const before = JSON.parse(await readFile(objectPath(), 'utf8'));
    const problemsBefore = await problems();

    const data = await call('rename_animation', { objectName: 'Sprite2', animationName: 'Walk', newName: 'Run Fast' });

    expect(await imagesOf('sprite2-')).toEqual([
      'sprite2-animation 1-000.png',
      'sprite2-run fast-000.png',
      'sprite2-run fast-001.png',
      'sprite2-run fast-002.png',
    ]);
    expect(Buffer.compare(await readFile(join(tmpDir, 'images', 'sprite2-run fast-001.png')), art)).toBe(0);
    // Only the name changes: sid, frames and imageSpriteIds are kept
    const expected = structuredClone(before);
    expected.animations.items[1].name = 'Run Fast';
    expect(JSON.parse(await readFile(objectPath(), 'utf8'))).toEqual(expected);
    expect(await initialAnimations()).toEqual(['Run Fast']);
    expect(data.warnings).toContain('Renamed 3 frame image file(s) in images/ ("sprite2-walk-000.png" → "sprite2-run fast-000.png", …).');
    expect(data.warnings).toContain('Set "initial-animation" to "Run Fast" on 1 instance(s) of "Sprite2" in layout(s): Layout 1.');
    expect(await problems()).toEqual(problemsBefore);
  });

  it('changing only the case of the name keeps the image files', async () => {
    await spriteWithWalk();
    const imagesBefore = await imagesOf('sprite2-');
    const data = await call('rename_animation', { objectName: 'Sprite2', animationName: 'Walk', newName: 'WALK' });
    expect(await imagesOf('sprite2-')).toEqual(imagesBefore);
    expect(await initialAnimations()).toEqual(['WALK']);
    expect(data.warnings.join('\n')).not.toContain('Renamed');
  });

  it('refuses when a renamed image file would replace an existing file, and changes nothing', async () => {
    await spriteWithWalk();
    const leftover = Buffer.from('leftover');
    await writeFile(join(tmpDir, 'images', 'sprite2-run-002.png'), leftover);
    const imagesBefore = await imagesOf('sprite2-');
    const objectBefore = await readFile(objectPath());
    const layoutBefore = await readFile(layoutPath());

    const result = await server.callTool('rename_animation', { objectName: 'Sprite2', animationName: 'Walk', newName: 'Run' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('"images/sprite2-run-002.png", which already exist(s). Nothing was changed.');
    expect(await imagesOf('sprite2-')).toEqual(imagesBefore);
    expect(Buffer.compare(await readFile(join(tmpDir, 'images', 'sprite2-run-002.png')), leftover)).toBe(0);
    expect(Buffer.compare(await readFile(objectPath()), objectBefore)).toBe(0);
    expect(Buffer.compare(await readFile(layoutPath()), layoutBefore)).toBe(0);
  });

  it('rolls back the image files and the object when a layout write fails', async () => {
    await spriteWithWalk();
    const imagesBefore = await imagesOf('sprite2-');
    const objectBefore = await readFile(objectPath());
    const layoutBefore = await readFile(layoutPath());

    class FailingLayoutWriter extends Construct3ProjectWriter {
      override async writeEntityFile(...args: Parameters<Construct3ProjectWriter['writeEntityFile']>): Promise<string> {
        if (args[0] === 'layouts') throw new Error('disk full');
        return super.writeEntityFile(...args);
      }
    }
    const idGen = new IdGenerator();
    const failing = new MockServer();
    registerMutationTools(failing as never, reader, new FailingLayoutWriter(reader, idGen), idGen);

    const result = await failing.callTool('rename_animation', { objectName: 'Sprite2', animationName: 'Walk', newName: 'Run' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('disk full. The rename was rolled back');
    expect(await imagesOf('sprite2-')).toEqual(imagesBefore);
    expect(Buffer.compare(await readFile(objectPath()), objectBefore)).toBe(0);
    expect(Buffer.compare(await readFile(layoutPath()), layoutBefore)).toBe(0);
  });

  it('rolls back the object file too when its write failed after replacing it', async () => {
    await spriteWithWalk();
    const imagesBefore = await imagesOf('sprite2-');
    const objectBefore = await readFile(objectPath());
    const layoutBefore = await readFile(layoutPath());

    // The object file is replaced, then the post-write check fails
    const idGen = new IdGenerator();
    const writer = new Construct3ProjectWriter(reader, idGen);
    const internals = writer as unknown as { verifyWrittenFile: (path: string, name: string, text: string) => Promise<void> };
    const verify = internals.verifyWrittenFile.bind(writer);
    internals.verifyWrittenFile = async (path, name, text) => {
      if (name === 'Sprite2') throw new Error('Post-write verification failed for "Sprite2"');
      return verify(path, name, text);
    };
    const failing = new MockServer();
    registerMutationTools(failing as never, reader, writer, idGen);

    const result = await failing.callTool('rename_animation', { objectName: 'Sprite2', animationName: 'Walk', newName: 'Run' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Post-write verification failed for "Sprite2". The rename was rolled back');
    expect(await imagesOf('sprite2-')).toEqual(imagesBefore);
    expect(Buffer.compare(await readFile(objectPath()), objectBefore)).toBe(0);
    expect(Buffer.compare(await readFile(layoutPath()), layoutBefore)).toBe(0);
  });

  it('changes nothing for an objectName that differs from the object\'s name in case', async () => {
    await spriteWithWalk();
    const imagesBefore = await imagesOf('sprite2-');
    const objectBefore = await readFile(objectPath());
    const layoutBefore = await readFile(layoutPath());

    const result = await server.callTool('rename_animation', { objectName: 'sprite2', animationName: 'Walk', newName: 'Run' });
    expect(result.isError).toBe(true);
    // Windows and macOS find the file under the other spelling; case-sensitive file systems do not
    expect(result.content[0].text).toMatch(/Object "sprite2" is named "Sprite2" in the project|Object "sprite2" not found/);
    expect(await imagesOf('sprite2-')).toEqual(imagesBefore);
    expect(await readdir(join(tmpDir, 'objectTypes'))).toContain('Sprite2.json');
    expect(Buffer.compare(await readFile(objectPath()), objectBefore)).toBe(0);
    expect(Buffer.compare(await readFile(layoutPath()), layoutBefore)).toBe(0);
    expect(await initialAnimations()).toEqual(['Walk']);
  });

  it('refuses a new name with a character Windows does not allow in file names before renaming anything', async () => {
    await spriteWithWalk();
    const imagesBefore = await imagesOf('sprite2-');
    const objectBefore = await readFile(objectPath());

    const result = await server.callTool('rename_animation', { objectName: 'Sprite2', animationName: 'Walk', newName: 'Run:Fast' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('The animation name "Run:Fast" contains ":".');
    expect(await imagesOf('sprite2-')).toEqual(imagesBefore);
    expect(Buffer.compare(await readFile(objectPath()), objectBefore)).toBe(0);
  });
});

describe('animations in animation folders', () => {
  const objectPath = () => join(tmpDir, 'objectTypes', 'Sprite.json');
  const layoutPath = () => join(tmpDir, 'layouts', 'Layout 1.json');
  const walkArt = Buffer.from('walk frame art');

  /** The fixture's Sprite with "Walk" in the animation folder "Moves", its image, and the instance starting with it. */
  async function spriteWithFolderAnimation(): Promise<void> {
    const obj = JSON.parse(await readFile(objectPath(), 'utf8'));
    obj.animations.subfolders = [{
      name: 'Moves',
      items: [{
        name: 'Walk', sid: 300000000000002, speed: 5, isLooping: true, isPingPong: false, repeatCount: 1, repeatTo: 0,
        frames: [{ width: 64, height: 64, originX: 0.5, originY: 0.5, duration: 1 }],
      }],
      subfolders: [],
    }];
    await writeFile(objectPath(), JSON.stringify(obj, null, '\t'));
    await mkdir(join(tmpDir, 'images'), { recursive: true });
    await writeFile(join(tmpDir, 'images', 'sprite-walk-000.png'), walkArt);
    const layout = JSON.parse(await readFile(layoutPath(), 'utf8'));
    layout.layers[0].instances[0].properties['initial-animation'] = 'Walk';
    await writeFile(layoutPath(), JSON.stringify(layout, null, '\t'));
    reader.invalidateCaches();
  }

  const readObject = async () => JSON.parse(await readFile(objectPath(), 'utf8'));
  const walkImage = () => readFile(join(tmpDir, 'images', 'sprite-walk-000.png'));

  it('rename_animation renames an animation in a folder, its image files and the instances starting with it', async () => {
    await spriteWithFolderAnimation();

    await call('rename_animation', { objectName: 'Sprite', animationName: 'Walk', newName: 'Run' });

    const obj = await readObject();
    expect(obj.animations.items.map((a: { name: string }) => a.name)).toEqual(['Animation 1']);
    expect(obj.animations.subfolders[0].name).toBe('Moves');
    expect(obj.animations.subfolders[0].items.map((a: { name: string; sid: number }) => [a.name, a.sid]))
      .toEqual([['Run', 300000000000002]]);
    const images = await readdir(join(tmpDir, 'images'));
    expect(images).toContain('sprite-run-000.png');
    expect(images).not.toContain('sprite-walk-000.png');
    expect(Buffer.compare(await readFile(join(tmpDir, 'images', 'sprite-run-000.png')), walkArt)).toBe(0);
    const layout = JSON.parse(await readFile(layoutPath(), 'utf8'));
    expect(layout.layers[0].instances[0].properties['initial-animation']).toBe('Run');
  });

  it('a missing animation name lists every animation with its folder path', async () => {
    await spriteWithFolderAnimation();
    const result = await server.callTool('rename_animation', { objectName: 'Sprite', animationName: 'Jump', newName: 'Leap' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Available: Animation 1, Moves/Walk (animations in animation folders are shown with their folder path');
  });

  it('refuses a new or renamed animation named like one in a folder, ignoring case, and keeps its image', async () => {
    await spriteWithFolderAnimation();
    const before = await readFile(objectPath());

    for (const [tool, args, message] of [
      ['add_animation_to_sprite', { objectName: 'Sprite', animationName: 'Walk' }, 'Animation "Walk" already exists on "Sprite"'],
      ['add_animation_to_sprite', { objectName: 'Sprite', animationName: 'WALK' }, 'only in case'],
      ['rename_animation', { objectName: 'Sprite', animationName: 'Animation 1', newName: 'Walk' }, 'Animation "Walk" already exists on "Sprite"'],
      ['rename_animation', { objectName: 'Sprite', animationName: 'Animation 1', newName: 'walk' }, 'only in case'],
    ] as const) {
      const result = await server.callTool(tool, args);
      expect(result.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
      expect(result.content[0].text).toContain(message);
    }

    expect(Buffer.compare(await walkImage(), walkArt)).toBe(0);
    expect(Buffer.compare(await readFile(objectPath()), before)).toBe(0);
  });

  it('the other animation tools find an animation in a folder too', async () => {
    await spriteWithFolderAnimation();
    const folderWalk = async () => (await readObject()).animations.subfolders[0].items[0];

    await call('update_animation_properties', { objectName: 'Sprite', animationName: 'Walk', speed: 9 });
    expect((await folderWalk()).speed).toBe(9);

    await call('add_frame_to_animation', { objectName: 'Sprite', animationName: 'Walk' });
    expect((await folderWalk()).frames).toHaveLength(2);
    expect(await readdir(join(tmpDir, 'images'))).toContain('sprite-walk-001.png');

    await call('update_frame', { objectName: 'Sprite', animationName: 'Walk', frameIndex: 1, duration: 2 });
    expect((await folderWalk()).frames[1].duration).toBe(2);

    const art = generatePlaceholderPng(2, 2);
    await call('replace_sprite_image', { objectName: 'Sprite', animationName: 'Walk', frameIndex: 1, pngBase64: art.toString('base64') });
    expect(Buffer.compare(await readFile(join(tmpDir, 'images', 'sprite-walk-001.png')), art)).toBe(0);

    await call('delete_frame_from_animation', { objectName: 'Sprite', animationName: 'Walk', frameIndex: 1 });
    expect((await folderWalk()).frames).toHaveLength(1);
    expect(Buffer.compare(await walkImage(), walkArt)).toBe(0);

    // Animations in folders count for "the last animation"
    await call('delete_animation', { objectName: 'Sprite', animationName: 'Animation 1' });
    const last = await server.callTool('delete_animation', { objectName: 'Sprite', animationName: 'Walk' });
    expect(last.isError).toBe(true);
    expect(last.content[0].text).toContain('Cannot delete the last animation');

    await call('add_animation_to_sprite', { objectName: 'Sprite', animationName: 'Idle' });
    await call('delete_animation', { objectName: 'Sprite', animationName: 'Walk' });
    const obj = await readObject();
    expect(obj.animations.items.map((a: { name: string }) => a.name)).toEqual(['Idle']);
    expect(obj.animations.subfolders).toEqual([{ name: 'Moves', items: [], subfolders: [] }]);
  });
});
