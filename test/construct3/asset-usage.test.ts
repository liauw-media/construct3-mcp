/**
 * Tests for get_asset_usage (issue #34), on synthetic data shaped like
 * editor-saved projects: `animations` as { items, subfolders } with the
 * frames inside, Audio "audio-file" parameters holding the sound name without
 * extension (a string, or { "path": name } in newer releases), by-name Audio
 * actions ("folder" + "audio-file-name"), AJAX "Request project file"
 * ("file": bare file name), and plugin instance properties that name project
 * files. The last group runs the project reader on folder projects on disk.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { MockReader, type MockReaderData } from '../mocks/mock-reader.js';
import { getAssetUsage } from '../../src/construct3/analyzers/asset-usage.js';
import { analyzePerformance } from '../../src/construct3/analyzers/performance.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { createTiledBgObject } from '../../src/construct3/templates.js';
import type { AssetUsageInfo } from '../../src/construct3/types.js';

let sid = 1000;
const frame = () => ({ width: 32, height: 32, originX: 0.5, originY: 0.5, duration: 1, sid: sid++ });
const anim = (name: string, frames: number) => ({
  name, sid: sid++, speed: 5, isLooping: false, isPingPong: false, repeatCount: 1, repeatTo: 0,
  frames: Array.from({ length: frames }, frame),
});
const sprite = (name: string, animations: unknown, extra: Record<string, unknown> = {}) =>
  ({ name, 'plugin-id': 'Sprite', sid: sid++, isGlobal: false, animations, ...extra });
const plainObject = (name: string, pluginId: string) => ({ name, 'plugin-id': pluginId, sid: sid++ });
/** An object type the editor saves with one `image` and no `animations` (Tiled Background, 9-patch, ...) */
const singleImage = (name: string, pluginId: string) => ({
  name, 'plugin-id': pluginId, sid: sid++, isGlobal: false,
  image: { width: 64, height: 64, originX: 0.5, originY: 0.5, exportFormat: 'lossless', imageSpriteId: sid++ },
});

const act = (objectClass: string, id: string, parameters?: unknown) =>
  ({ id, objectClass, sid: sid++, ...(parameters !== undefined ? { parameters } : {}) });
const block = (actions: unknown[], conditions: unknown[] = [], children?: unknown[]) =>
  ({ eventType: 'block', conditions, actions, sid: sid++, ...(children ? { children } : {}) });
const sheet = (name: string, events: unknown[]) => ({ name, events, sid: sid++ });
const instance = (type: string, properties: Record<string, unknown> = {}) =>
  ({ type, properties, uid: sid++, sid: sid++, world: { x: 0, y: 0, width: 10, height: 10 } });
const layer = (name: string, instances: unknown[], subLayers: unknown[] = []) =>
  ({ name, sid: sid++, instances, subLayers });
const layout = (name: string, layers: unknown[], extra: Record<string, unknown> = {}) =>
  ({ name, sid: sid++, layers, ...extra });
const scriptActionFor = (lines: string[]) => ({ type: 'script', language: 'javascript', script: lines });

function mapOf<T>(entries: Array<[string, T]>): Map<string, T> {
  return new Map(entries);
}

function reader(data: {
  objects?: Array<Record<string, unknown>>;
  sheets?: Array<Record<string, unknown>>;
  layouts?: Array<Record<string, unknown>>;
  families?: Array<Record<string, unknown>>;
  files?: MockReaderData['files'];
  scriptFiles?: MockReaderData['scriptFiles'];
  containers?: unknown[];
  dataFiles?: MockReaderData['dataFiles'];
}): MockReader {
  const byName = (list: Array<Record<string, unknown>> = []) => mapOf(list.map(x => [x.name as string, x]));
  return new MockReader({
    objects: byName(data.objects),
    eventSheets: byName(data.sheets),
    layouts: byName(data.layouts),
    families: byName(data.families),
    files: data.files,
    scriptFiles: data.scriptFiles,
    containers: data.containers,
    dataFiles: data.dataFiles,
  });
}

async function usage(r: MockReader, options: Parameters<typeof getAssetUsage>[1] = { detail: 'full' }) {
  return getAssetUsage(r as never, options);
}

function find(assets: AssetUsageInfo[] | undefined, name: string): AssetUsageInfo {
  const asset = assets?.find(a => a.name === name);
  if (!asset) throw new Error(`asset "${name}" not in result: ${assets?.map(a => a.name).join(', ')}`);
  return asset;
}

beforeEach(() => {
  resetProjectIndex();
});

describe('get_asset_usage: images (sprite animations)', () => {
  it('finds one image per object type with animations and counts frames in subfolders', async () => {
    const r = reader({
      objects: [
        sprite('Player', { items: [anim('Idle', 2)], subfolders: [{ name: 'Moves', items: [anim('Walk', 3)], subfolders: [] }] }),
        plainObject('Keyboard', 'Keyboard'),
      ],
      layouts: [layout('Level', [layer('Main', [instance('Player')])])],
    });
    const result = await usage(r);
    expect(result.summary.byType).toEqual({ image: 1 });
    const player = find(result.assets, 'Player');
    expect(player).toMatchObject({ type: 'image', status: 'used', animations: 2, frames: 5, via: ['object'] });
    expect(player.referencedIn.layouts).toEqual(['Level']);
  });

  it('lists object types with a single image (Tiled Background, 9-patch, Particles, Sprite font) as one-frame images', async () => {
    const r = reader({
      objects: [
        sprite('Hero', { items: [anim('Idle', 1)], subfolders: [] }),
        singleImage('Floor', 'TiledBg'),
        singleImage('Sparks', 'Particles'),
        singleImage('Panel', 'NinePatch'),
        singleImage('Digits', 'Spritefont2'),
        plainObject('Label', 'Text'),
        // Not an image: a malformed `image` value
        { ...plainObject('Broken', 'TiledBg'), image: [] },
      ],
      layouts: [layout('Level', [layer('Main', [instance('Hero'), instance('Floor'), instance('Label')])])],
      sheets: [sheet('Game', [block([act('Sparks', 'destroy')])])],
    });
    const result = await usage(r);
    expect(result.summary.byType).toEqual({ image: 5 });
    const floor = find(result.assets, 'Floor');
    expect(floor).toMatchObject({ type: 'image', status: 'used', frames: 1, via: ['object'], referencedIn: { eventSheets: [], layouts: ['Level'] } });
    expect('animations' in floor).toBe(false);
    expect(find(result.assets, 'Sparks')).toMatchObject({ type: 'image', status: 'used', frames: 1, referencedIn: { eventSheets: ['Game'], layouts: [] } });
    expect(find(result.assets, 'Panel')).toMatchObject({ type: 'image', status: 'unused', frames: 1 });
    expect(find(result.assets, 'Digits')).toMatchObject({ type: 'image', status: 'unused', frames: 1 });
    expect(find(result.assets, 'Hero')).toMatchObject({ status: 'used', animations: 1, frames: 1 });
    expect(result.assets!.map(a => a.name)).not.toContain('Label');
    expect(result.assets!.map(a => a.name)).not.toContain('Broken');
    expect(result.notes.join(' ')).toContain('or a single image');

    resetProjectIndex();
    const images = await usage(r, { type: 'image', detail: 'summary' });
    expect(images.summary).toMatchObject({ totalAssets: 5, usedCount: 3, unusedCount: 2, notAnalysedCount: 0 });
  });

  it('applies the by-name rules to single-image object types', async () => {
    const r = reader({
      objects: [singleImage('Floor', 'TiledBg'), singleImage('Wall', 'TiledBg'), singleImage('Panel', 'NinePatch')],
      families: [{ name: 'Tiles', 'plugin-id': 'TiledBg', sid: sid++, members: ['Wall'] }],
      sheets: [sheet('Game', [
        // runtime.objects["Floor"] would be an object reference the index counts; a bare identifier is not
        block([scriptActionFor(['spawnAll(Floor);'])]),
        block([act('Tiles', 'destroy')]),
      ])],
    });
    const result = await usage(r);
    expect(find(result.assets, 'Floor')).toMatchObject({ type: 'image', status: 'not-analysed', frames: 1 });
    expect(find(result.assets, 'Floor').reason).toContain('object name appears in event parameters or scripts');
    expect(find(result.assets, 'Wall')).toMatchObject({ status: 'used', referencedIn: { eventSheets: ['Game'] } });
    expect(find(result.assets, 'Panel').status).toBe('unused');
  });

  it('counts placements on sub-layers and non-world instances, and use through a family', async () => {
    const r = reader({
      objects: [
        sprite('Gem', { items: [anim('A', 1)], subfolders: [] }),
        sprite('Door', { items: [anim('A', 1)], subfolders: [] }),
        sprite('Enemy', { items: [anim('A', 1)], subfolders: [] }),
        sprite('Ghost', { items: [anim('A', 1)], subfolders: [] }),
      ],
      families: [{ name: 'Foes', 'plugin-id': 'Sprite', sid: 9, members: ['Enemy'] }],
      layouts: [layout('Level', [layer('Back', [], [layer('Deep', [instance('Gem')])])], { 'nonworld-instances': [instance('Door')] })],
      sheets: [sheet('Game', [block([act('Foes', 'destroy')])])],
    });
    const result = await usage(r);
    expect(find(result.assets, 'Gem')).toMatchObject({ status: 'used', referencedIn: { layouts: ['Level'] } });
    expect(find(result.assets, 'Door')).toMatchObject({ status: 'used', referencedIn: { layouts: ['Level'] } });
    expect(find(result.assets, 'Enemy')).toMatchObject({ status: 'used', referencedIn: { eventSheets: ['Game'] } });
    expect(find(result.assets, 'Ghost').status).toBe('unused');
  });

  it('counts an image as used by the rule of find_orphaned_objects (object property, script reference)', async () => {
    const spark = sprite('Spark', { items: [anim('A', 1)], subfolders: [] });
    const r = reader({
      objects: [
        spark,
        sprite('Bolt', { items: [anim('A', 1)], subfolders: [] }),
        plainObject('Emitter', 'Particles'),
        sprite('Ghost', { items: [anim('A', 1)], subfolders: [] }),
      ],
      // A Particles instance saves the object it spawns as that object type's SID
      layouts: [layout('Level', [layer('Main', [instance('Emitter', { object: spark.sid })])])],
      sheets: [sheet('Game', [block([scriptActionFor(['runtime.objects.Bolt.createInstance("Main", 0, 0);'])])])],
    });
    const result = await usage(r);
    expect(find(result.assets, 'Spark')).toMatchObject({ status: 'used', via: ['object'] });
    expect(find(result.assets, 'Bolt')).toMatchObject({ status: 'used', referencedIn: { eventSheets: ['Game'] } });
    expect(find(result.assets, 'Ghost').status).toBe('unused');
  });

  it('reports objects named only in parameters or scripts, in containers or created by name as not unused', async () => {
    const r = reader({
      objects: [
        sprite('Gem', { items: [anim('A', 1)], subfolders: [] }),
        sprite('Ruby', { items: [anim('A', 1)], subfolders: [] }),
        sprite('Shield', { items: [anim('A', 1)], subfolders: [] }),
        sprite('Coin', { items: [anim('A', 1)], subfolders: [] }),
        sprite('Ghost', { items: [anim('A', 1)], subfolders: [] }),
      ],
      // The editor saves containers as { members: [...] }
      containers: [{ members: ['Shield', 'Knight'] }],
      sheets: [sheet('Game', [
        block([act('System', 'set-eventvar-value', { variable: 'x', value: 'Gem.X + 1' })]),
        block([{ type: 'script', script: ['spawnAll(Ruby);'] }]),
        block([act('System', 'create-object-by-name', { 'object-name': '"Coin"', layer: '0', x: '0', y: '0' })]),
      ])],
    });
    const result = await usage(r);
    // An expression like Gem.X is an object reference; whether the index counts it or not, Gem is not unused
    expect(find(result.assets, 'Gem').status).not.toBe('unused');
    expect(find(result.assets, 'Ruby')).toMatchObject({ status: 'not-analysed' });
    expect(find(result.assets, 'Ruby').reason).toContain('object name appears in event parameters or scripts');
    expect(find(result.assets, 'Shield')).toMatchObject({ status: 'not-analysed' });
    expect(find(result.assets, 'Shield').reason).toContain('container');
    expect(find(result.assets, 'Coin')).toMatchObject({ status: 'used', referencedIn: { eventSheets: ['Game'] } });
    expect(find(result.assets, 'Ghost').status).toBe('unused');
  });

  it('does not call an object unused when objects are created by a computed name', async () => {
    const r = reader({
      objects: [sprite('Ghost', { items: [anim('A', 1)], subfolders: [] })],
      sheets: [sheet('Game', [block([act('System', 'create-object-by-name', { 'object-name': 'kind & "Ghost"' })])])],
    });
    const ghost = find((await usage(r)).assets, 'Ghost');
    expect(ghost.status).toBe('not-analysed');
    expect(ghost.reason).toContain('create-object-by-name');
  });

  const spriteAndBat = () => [
    sprite('Ghost', { items: [anim('A', 1)], subfolders: [] }),
    sprite('Bat', { items: [anim('A', 1)], subfolders: [] }),
  ];

  it('does not call an object unused when a script looks up object types by a computed name', async () => {
    const cases: Array<{ label: string; sheets?: Array<Record<string, unknown>>; scriptFiles?: MockReaderData['scriptFiles']; reason: string }> = [
      {
        label: 'names from a string array',
        sheets: [sheet('Game', [block([scriptActionFor([
          'const names = ["Ghost"];',
          'for (const n of names) runtime.objects[n].createInstance("Main", 0, 0);',
        ])])])],
        reason: 'a script in event sheet "Game" looks up object types by a computed name (objects[...])',
      },
      {
        label: 'a computed name',
        sheets: [sheet('Game', [block([scriptActionFor(['const kind = pickKind();', 'runtime.objects?.[kind].createInstance("Main", 0, 0);'])])])],
        reason: 'looks up object types by a computed name',
      },
      {
        label: 'a map in a script file',
        scriptFiles: [{
          path: 'spawn.js',
          source: 'const map = { g: "Ghost" };\nexport function spawn(runtime, k) { return runtime.objects[map[k]].createInstance("Main", 0, 0); }',
        }],
        reason: 'scripts/spawn.js looks up object types by a computed name',
      },
      {
        label: 'an alias of runtime.objects',
        sheets: [sheet('Game', [block([scriptActionFor(['const all = runtime.objects;', 'all[pickKind()].createInstance("Main", 0, 0);'])])])],
        reason: 'passes runtime.objects on as a whole',
      },
    ];
    for (const c of cases) {
      resetProjectIndex();
      const result = await usage(reader({ objects: spriteAndBat(), sheets: c.sheets, scriptFiles: c.scriptFiles }));
      // Bat is never named: only the computed lookup keeps it from being unused
      const bat = find(result.assets, 'Bat');
      expect(bat.status, c.label).toBe('not-analysed');
      expect(bat.reason, c.label).toContain(c.reason);
      expect(find(result.assets, 'Ghost').status, c.label).toBe('not-analysed');
    }
  });

  it('reports objects named by a string in scripts or parameters as not analysed, others as unused', async () => {
    const cases: Array<{ label: string; sheets?: Array<Record<string, unknown>>; scriptFiles?: MockReaderData['scriptFiles'] }> = [
      { label: 'a literal lookup', sheets: [sheet('Game', [block([scriptActionFor(['runtime.objects["Ghost"].createInstance("Main", 0, 0);'])])])] },
      { label: 'a member lookup', sheets: [sheet('Game', [block([scriptActionFor(['runtime.objects.Ghost.getFirstInstance();'])])])] },
      { label: 'a string in a script file', scriptFiles: [{ path: 'kinds.js', source: 'export const KINDS = ["ghost"];' }] },
      { label: 'a function argument', sheets: [sheet('Game', [block([{ callFunction: 'Spawn', sid: sid++, parameters: ['"Ghost"'] }])])] },
      { label: 'a string variable', sheets: [sheet('Game', [{ eventType: 'variable', name: 'nextKind', type: 'string', initialValue: 'Ghost', sid: sid++ }])] },
    ];
    for (const c of cases) {
      resetProjectIndex();
      const result = await usage(reader({ objects: spriteAndBat(), sheets: c.sheets, scriptFiles: c.scriptFiles }));
      const ghost = find(result.assets, 'Ghost');
      expect(ghost.status, c.label).not.toBe('unused');
      if (ghost.status === 'not-analysed') expect(ghost.reason, c.label).toContain('object name appears in event parameters or scripts');
      expect(find(result.assets, 'Bat').status, c.label).toBe('unused');
    }
  });
});

describe('get_asset_usage: sounds and music', () => {
  const audioFiles: MockReaderData['files'] = [
    { folder: 'sound', path: 'jump.webm' },
    { folder: 'sound', path: 'sfx/hit.webm' },
    { folder: 'sound', path: 'coin.webm' },
    { folder: 'sound', path: 'step1.webm' },
    { folder: 'sound', path: 'step2.webm' },
    { folder: 'sound', path: 'alarm.webm' },
    { folder: 'music', path: 'Theme.webm' },
    { folder: 'music', path: 'boss.webm' },
  ];
  const play = (audioFile: unknown) =>
    act('Audio', 'play', { 'audio-file': audioFile, loop: 'not-looping', volume: '0', 'stereo-pan': '0', 'tag-optional': '"sfx"' });
  const playByName = (folder: string, name: string) =>
    act('Audio', 'play-by-name', { folder, 'audio-file-name': name, loop: 'not-looping', volume: '0', 'stereo-pan': '0', 'tag-optional': '""' });

  it('matches Audio file parameters (name without extension, string or { path }) in any folder', async () => {
    const r = reader({
      objects: [plainObject('Audio', 'Audio')],
      files: audioFiles,
      sheets: [sheet('Sound', [block([play('jump'), play('hit'), play({ path: 'theme' })])])],
    });
    const result = await usage(r);
    expect(find(result.assets, 'jump.webm')).toMatchObject({ type: 'sound', status: 'used', via: ['audio-file'], referencedIn: { eventSheets: ['Sound'] } });
    expect(find(result.assets, 'sfx/hit.webm').status).toBe('used');
    expect(find(result.assets, 'Theme.webm')).toMatchObject({ type: 'music', status: 'used' });
    expect(find(result.assets, 'boss.webm').status).toBe('unused');
  });

  it('does not count tag parameters as uses of a sound with the same name', async () => {
    const r = reader({
      objects: [plainObject('Audio', 'Audio')],
      files: audioFiles,
      sheets: [sheet('Sound', [block([act('Audio', 'stop', { tag: '"alarm"' }), act('Audio', 'set-muted', { tag: '"alarm"', state: 'muted' })])])],
    });
    expect(find((await usage(r)).assets, 'alarm.webm').status).toBe('unused');
  });

  it('counts a sound name in a string parameter, e.g. a function argument', async () => {
    const r = reader({
      objects: [plainObject('Audio', 'Audio')],
      files: audioFiles,
      sheets: [sheet('Sound', [block([{ callFunction: 'EmitNoise', sid: sid++, parameters: ['"coin"'] }])])],
    });
    expect(find((await usage(r)).assets, 'coin.webm')).toMatchObject({ status: 'used', via: ['string'] });
  });

  it('matches by-name Audio actions with a literal name in the chosen folder', async () => {
    const r = reader({
      objects: [plainObject('Audio', 'Audio')],
      files: audioFiles,
      sheets: [sheet('Sound', [block([playByName('sounds', '"coin"'), playByName('sounds', '"boss"')])])],
    });
    const result = await usage(r);
    expect(find(result.assets, 'coin.webm')).toMatchObject({ status: 'used', via: ['play-by-name'] });
    // "boss" is a music file; the action looks in the sounds folder
    expect(find(result.assets, 'boss.webm').status).toBe('unused');
    expect(find(result.assets, 'jump.webm').status).toBe('unused');
  });

  it('reports sounds a by-name action may play from an expression as not analysed', async () => {
    const r = reader({
      objects: [plainObject('Audio', 'Audio')],
      files: audioFiles,
      sheets: [sheet('Sound', [block([playByName('sounds', '"step" & choose(1, 2)')])])],
    });
    const result = await usage(r);
    for (const name of ['step1.webm', 'step2.webm']) {
      expect(find(result.assets, name).status).toBe('not-analysed');
      expect(find(result.assets, name).reason).toContain('play-by-name');
    }
    expect(find(result.assets, 'jump.webm').status).toBe('unused');
    expect(find(result.assets, 'boss.webm').status).toBe('unused');

    resetProjectIndex();
    const dynamic = reader({
      objects: [plainObject('Audio', 'Audio')],
      files: audioFiles,
      sheets: [sheet('Sound', [block([playByName('music', 'trackName')])])],
    });
    const all = await usage(dynamic);
    expect(find(all.assets, 'boss.webm').status).toBe('not-analysed');
    expect(find(all.assets, 'Theme.webm').status).toBe('not-analysed');
    expect(find(all.assets, 'jump.webm').status).toBe('unused');
  });

  it('does not take variable definitions, animation names or display text for sound or music names', async () => {
    const r = reader({
      objects: [
        plainObject('Audio', 'Audio'),
        sprite('Hero', { items: [anim('jump', 1)], subfolders: [] }, {
          // Object types save instance variable definitions (no values) as an array
          instanceVariables: [{ name: 'jump', type: 'number', desc: 'alarm', show: true, sid: sid++ }],
        }),
        plainObject('Label', 'Text'),
      ],
      families: [{ name: 'Actors', 'plugin-id': 'Sprite', sid: sid++, members: ['Hero'], instanceVariables: [{ name: 'coin', type: 'string', desc: '', show: true, sid: sid++ }] }],
      layouts: [layout('Level', [layer('Main', [
        instance('Hero', { 'initial-animation': 'step1' }),
        instance('Label', { text: 'Theme', font: 'Arial' }),
        // Layout instances save instance variable values as { name: value }
        { ...instance('Hero'), instanceVariables: { hitSound: 'boss' } },
      ])])],
      sheets: [sheet('Game', [block([
        act('Hero', 'set-animation', { animation: '"step2"', from: 'beginning' }),
        act('Label', 'set-text', { text: '"alarm"' }),
      ])])],
      files: audioFiles,
    });
    const result = await usage(r);
    for (const name of ['jump.webm', 'coin.webm', 'step1.webm', 'step2.webm', 'alarm.webm', 'Theme.webm']) {
      expect(find(result.assets, name).status, name).toBe('unused');
    }
    // An instance variable value can hold a sound name
    expect(find(result.assets, 'boss.webm')).toMatchObject({ status: 'used', via: ['property'], referencedIn: { layouts: ['Level'] } });
  });

  it('treats choose() over literal names as complete', async () => {
    const r = reader({
      objects: [plainObject('Audio', 'Audio')],
      files: audioFiles,
      sheets: [sheet('Sound', [block([playByName('sounds', 'choose("step1", "step2")')])])],
    });
    const result = await usage(r);
    expect(find(result.assets, 'step1.webm').status).toBe('used');
    expect(find(result.assets, 'step2.webm').status).toBe('used');
    expect(find(result.assets, 'jump.webm').status).toBe('unused');
  });
});

describe('get_asset_usage: project files, fonts, videos and icons', () => {
  it('matches project file parameters, plugin properties and project files that name other files', async () => {
    const r = reader({
      objects: [plainObject('AJAX', 'AJAX'), plainObject('Skel', 'SkeletonAnim')],
      layouts: [layout('Level', [layer('Main', [instance('Skel', { 'data-file': 'knight.json', 'atlas-file': 'knight.atlas' })])])],
      sheets: [sheet('Load', [block([act('AJAX', 'request-project-file', { tag: '"cfg"', file: 'data.json' })])])],
      files: [
        { folder: 'general', path: 'data.json', text: '{"a": 1}' },
        { folder: 'general', path: 'skel/knight.json', text: '{}' },
        { folder: 'general', path: 'skel/knight.atlas', text: 'knight.png\nsize: 64,64\n' },
        { folder: 'general', path: 'skel/knight.png' },
        { folder: 'general', path: 'skel/old.atlas', text: 'old.png\nsize: 64,64\n' },
        { folder: 'general', path: 'skel/old.png' },
      ],
    });
    const result = await usage(r);
    expect(find(result.assets, 'data.json')).toMatchObject({ type: 'general', status: 'used', via: ['parameter'] });
    expect(find(result.assets, 'skel/knight.json')).toMatchObject({ status: 'used', via: ['property'], referencedIn: { layouts: ['Level'] } });
    expect(find(result.assets, 'skel/knight.png')).toMatchObject({ status: 'used', via: ['project-file'], referencedIn: { projectFiles: ['skel/knight.atlas'] } });
    expect(find(result.assets, 'skel/old.atlas').status).toBe('unused');
    const oldPng = find(result.assets, 'skel/old.png');
    expect(oldPng.status).toBe('unused');
    expect(oldPng.reason).toContain('named only by unused project files (skel/old.atlas)');
  });

  it('finds file names inside string literals and scripts, and a Text font property', async () => {
    const r = reader({
      objects: [plainObject('Label', 'Text'), plainObject('Page', 'HTMLElement')],
      layouts: [layout('Menu', [layer('UI', [instance('Label', { text: 'Hi', font: 'Pixel Sans' })])])],
      sheets: [sheet('Menu', [
        { eventType: 'variable', name: 'saveFile', type: 'string', initialValue: 'save.json', sid: sid++ },
        block([
          act('Page', 'set-content', { content: '"<img src=""badge.png"">"' }),
          { type: 'script', language: 'javascript', script: ['const cfg = await runtime.assets.fetchJson("config.json");'] },
        ]),
      ])],
      scriptFiles: [{ path: 'style.js', source: 'const css = `body { background: url(bg.png); }`;' }],
      files: [
        { folder: 'general', path: 'save.json', text: '{}' },
        { folder: 'general', path: 'badge.png' },
        { folder: 'general', path: 'config.json', text: '{}' },
        { folder: 'general', path: 'bg.png' },
        { folder: 'font', path: 'Pixel Sans.ttf' },
      ],
    });
    const result = await usage(r);
    expect(find(result.assets, 'save.json')).toMatchObject({ status: 'used', via: ['string'] });
    expect(find(result.assets, 'badge.png')).toMatchObject({ status: 'used', via: ['string'] });
    expect(find(result.assets, 'config.json')).toMatchObject({ status: 'used', via: ['script'], referencedIn: { eventSheets: ['Menu'] } });
    expect(find(result.assets, 'bg.png')).toMatchObject({ status: 'used', referencedIn: { scripts: ['scripts/style.js'] } });
    expect(find(result.assets, 'Pixel Sans.ttf')).toMatchObject({ type: 'font', status: 'used', via: ['property'] });
  });

  it('reports names built at runtime as not analysed, and only the files they can produce', async () => {
    const r = reader({
      objects: [plainObject('AJAX', 'AJAX'), plainObject('Title', 'Text')],
      sheets: [sheet('Load', [block([
        act('AJAX', 'request-url', { tag: '"lvl"', url: '"levels/lvl_" & levelNumber & ".json"' }),
        // Text and tags built from pieces are not file names
        act('Title', 'set-text', { text: '"notes" & n' }),
        act('AJAX', 'request-url', { tag: '"notes" & n', url: 'serverUrl' }),
      ])])],
      files: [
        { folder: 'general', path: 'levels/lvl_1.json', text: '{}' },
        { folder: 'general', path: 'levels/lvl_2.json', text: '{}' },
        { folder: 'general', path: 'notes.json', text: '{}' },
      ],
    });
    const result = await usage(r);
    expect(find(result.assets, 'levels/lvl_1.json').status).toBe('not-analysed');
    expect(find(result.assets, 'levels/lvl_1.json').reason).toContain('the name may be built at runtime');
    expect(find(result.assets, 'levels/lvl_2.json').status).toBe('not-analysed');
    expect(find(result.assets, 'notes.json').status).toBe('unused');
  });

  it('reports every project file as not analysed after ProjectFileNameAt or a computed asset-manager call', async () => {
    for (const events of [
      [block([act('System', 'set-eventvar-value', { variable: 'f', value: 'ProjectFileNameAt(0)' })])],
      [block([{ type: 'script', script: ['const d = await runtime.assets.fetchText(name);'] }])],
    ]) {
      resetProjectIndex();
      const r = reader({
        sheets: [sheet('Load', events)],
        files: [{ folder: 'general', path: 'a.txt', text: 'x' }, { folder: 'sound', path: 'beep.webm' }],
      });
      const result = await usage(r);
      expect(find(result.assets, 'a.txt').status).toBe('not-analysed');
      expect(find(result.assets, 'beep.webm').status).toBe('unused');
    }
  });

  it('reports icons and files with a purpose as not analysed, and follows a used page to its stylesheet', async () => {
    const r = reader({
      objects: [plainObject('AJAX', 'AJAX')],
      sheets: [sheet('Load', [block([act('AJAX', 'request-project-file', { tag: '"page"', file: 'page.html' })])])],
      files: [
        { folder: 'icon', path: 'icon-16.png', purpose: 'app-icon' },
        { folder: 'icon', path: 'loading-logo.png', purpose: 'loading-logo' },
        { folder: 'general', path: 'page.html', text: '<link rel="stylesheet" href="page.css">' },
        { folder: 'general', path: 'page.css', purpose: 'stylesheet', text: 'body { font-family: "Pixel Sans"; }' },
        { folder: 'general', path: 'extra.css', purpose: 'stylesheet', text: '.x { background: url(tile.png); }' },
        { folder: 'general', path: 'tile.png' },
        { folder: 'font', path: 'Pixel Sans.woff2' },
      ],
    });
    const result = await usage(r);
    expect(find(result.assets, 'icon-16.png')).toMatchObject({ type: 'icon', status: 'not-analysed' });
    expect(find(result.assets, 'icon-16.png').reason).toContain('icon (app-icon)');
    expect(find(result.assets, 'loading-logo.png').reason).toContain('loading-logo');
    expect(find(result.assets, 'page.css')).toMatchObject({ status: 'used', via: ['project-file'] });
    expect(find(result.assets, 'Pixel Sans.woff2')).toMatchObject({ status: 'used', referencedIn: { projectFiles: ['page.css'] } });
    expect(find(result.assets, 'extra.css').status).toBe('not-analysed');
    expect(find(result.assets, 'extra.css').reason).toContain('purpose "stylesheet"');
    // Named only by a file that is not analysed
    expect(find(result.assets, 'tile.png').status).toBe('not-analysed');
    expect(find(result.assets, 'tile.png').reason).toContain('named by project file "extra.css"');
  });

  it('matches video sources in properties and string parameters', async () => {
    const r = reader({
      objects: [plainObject('Clip', 'Video')],
      layouts: [layout('Intro', [layer('Main', [instance('Clip', { 'primary-source': 'intro.webm' })])])],
      sheets: [sheet('Intro', [block([act('Clip', 'set-source-2', { 'primary-source': '"outro.webm"', 'secondary-source': '""' })])])],
      files: [{ folder: 'video', path: 'intro.webm' }, { folder: 'video', path: 'outro.webm' }, { folder: 'video', path: 'spare.webm' }],
    });
    const result = await usage(r);
    expect(find(result.assets, 'intro.webm')).toMatchObject({ type: 'video', status: 'used', via: ['property'] });
    expect(find(result.assets, 'outro.webm')).toMatchObject({ type: 'video', status: 'used', via: ['string'] });
    expect(find(result.assets, 'spare.webm').status).toBe('unused');
  });

  it('matches fonts named in CSS font declarations in properties, parameters and scripts', async () => {
    const r = reader({
      objects: [plainObject('Page', 'HTMLElement'), plainObject('Panel', 'HTMLElement')],
      layouts: [layout('Menu', [layer('UI', [
        instance('Page', { content: '<p style="font-family: \'Pixel Sans\', serif">Hi</p>' }),
        instance('Panel', { 'style-attribute': 'font: bold 12px RoundFace' }),
      ])])],
      sheets: [sheet('Menu', [block([
        act('Page', 'set-content', { content: '"<div style=""font-family: &quot;Tall Mono&quot;"">x</div>"' }),
        scriptActionFor(['const css = `.title { font-family: SlabFace; }`;']),
      ])])],
      files: [
        { folder: 'font', path: 'Pixel Sans.woff2' },
        { folder: 'font', path: 'RoundFace.ttf' },
        { folder: 'font', path: 'Tall Mono.woff' },
        { folder: 'font', path: 'SlabFace.otf' },
        { folder: 'font', path: 'SpareFace.ttf' },
        { folder: 'font', path: 'Sans.ttf' },
      ],
    });
    const result = await usage(r);
    expect(find(result.assets, 'Pixel Sans.woff2')).toMatchObject({ status: 'used', via: ['property'], referencedIn: { layouts: ['Menu'] } });
    expect(find(result.assets, 'RoundFace.ttf')).toMatchObject({ status: 'used', via: ['property'] });
    expect(find(result.assets, 'Tall Mono.woff')).toMatchObject({ status: 'used', via: ['string'] });
    expect(find(result.assets, 'SlabFace.otf')).toMatchObject({ status: 'used', via: ['script'] });
    expect(find(result.assets, 'SpareFace.ttf').status).toBe('unused');
    // Part of a family name is not the family
    expect(find(result.assets, 'Sans.ttf').status).toBe('unused');
  });

  it('matches strings in flowcharts and timelines, but not their own names or settings', async () => {
    const r = reader({
      objects: [plainObject('AJAX', 'AJAX'), plainObject('Audio', 'Audio')],
      sheets: [sheet('Load', [block([act('AJAX', 'request-url', { tag: '"lvl"', url: 'Chart.OutputValue("file")' })])])],
      dataFiles: [
        { folder: 'flowcharts', path: 'Flow 1.json', text: JSON.stringify({ name: 'intro', sid: 1, nodes: [{ sid: 2, outputs: [{ name: 'file', value: 'level1.json' }] }] }) },
        { folder: 'timelines', path: 'Scenes/Wipe.json', text: JSON.stringify({ name: 'Wipe', ease: 'outro', tracksRoot: { tracks: [{ value: 'chime' }] } }) },
      ],
      files: [
        { folder: 'general', path: 'level1.json', text: '{}' },
        { folder: 'general', path: 'level2.json', text: '{}' },
        { folder: 'sound', path: 'chime.webm' },
        { folder: 'sound', path: 'intro.webm' },
        { folder: 'sound', path: 'outro.webm' },
      ],
    });
    const result = await usage(r);
    expect(find(result.assets, 'level1.json')).toMatchObject({ status: 'used', via: ['flowchart'], referencedIn: { flowcharts: ['Flow 1'] } });
    expect(find(result.assets, 'chime.webm')).toMatchObject({ status: 'used', via: ['timeline'], referencedIn: { timelines: ['Scenes/Wipe'] } });
    expect(find(result.assets, 'level2.json').status).toBe('unused');
    expect(find(result.assets, 'intro.webm').status).toBe('unused');
    expect(find(result.assets, 'outro.webm').status).toBe('unused');
  });

  it('reports file assets, not images, as not analysed when a flowchart cannot be read', async () => {
    const r = reader({
      objects: [sprite('Ghost', { items: [anim('A', 1)], subfolders: [] })],
      dataFiles: [{ folder: 'flowcharts', path: 'Broken.json' }],
      files: [{ folder: 'general', path: 'data.json', text: '{}' }],
    });
    const result = await usage(r);
    expect(find(result.assets, 'data.json').status).toBe('not-analysed');
    expect(find(result.assets, 'data.json').reason).toContain('flowchart "Broken.json"');
    expect(find(result.assets, 'Ghost').status).toBe('unused');
  });

  it('lets an unreadable project file affect other file assets only once it is used', async () => {
    const files: MockReaderData['files'] = [
      { folder: 'sound', path: 'beep.webm' },
      { folder: 'general', path: 'notes.txt', text: 'plain' },
      // No text: reading fails, like a missing file or one over the size limit
      { folder: 'general', path: 'huge.dat' },
    ];
    const objects = [plainObject('AJAX', 'AJAX'), sprite('Ghost', { items: [anim('A', 1)], subfolders: [] })];
    const unusedFile = await usage(reader({ objects, files }));
    for (const name of ['huge.dat', 'beep.webm', 'notes.txt', 'Ghost']) expect(find(unusedFile.assets, name).status, name).toBe('unused');
    expect(unusedFile.notes.join(' ')).toContain('1 file(s) could not be read (project file "huge.dat")');

    resetProjectIndex();
    const usedFile = await usage(reader({
      objects,
      files,
      sheets: [sheet('Load', [block([act('AJAX', 'request-project-file', { tag: '"big"', file: 'huge.dat' })])])],
    }));
    expect(find(usedFile.assets, 'huge.dat').status).toBe('used');
    for (const name of ['beep.webm', 'notes.txt']) {
      expect(find(usedFile.assets, name).status, name).toBe('not-analysed');
      expect(find(usedFile.assets, name).reason, name).toContain('project file "huge.dat" could not be read');
    }
    // Project files cannot place or create objects
    expect(find(usedFile.assets, 'Ghost').status).toBe('unused');
  });

  it('does not take a server URL prefix for a project file name', async () => {
    const r = reader({
      objects: [plainObject('AJAX', 'AJAX')],
      sheets: [sheet('Net', [block([
        act('AJAX', 'request-url', { tag: '"api"', url: '"https://api.example.com/v1/" & endpoint' }),
        act('AJAX', 'request-url', { tag: '"cdn"', url: '"//cdn.example.com/" & asset & ".json"' }),
      ])])],
      files: [{ folder: 'general', path: 'notes.json', text: '{}' }, { folder: 'general', path: 'readme.txt', text: 'x' }],
    });
    const result = await usage(r);
    expect(find(result.assets, 'notes.json').status).toBe('unused');
    expect(find(result.assets, 'readme.txt').status).toBe('unused');
  });

  it('reports files a script fetches by a name with a literal prefix as not analysed', async () => {
    for (const line of [
      'const r = await fetch("lvl_" + n);',
      'xhr.open("GET", "lvl_" + n);',
      'const m = await import(`lvl_${n}`);',
    ]) {
      resetProjectIndex();
      const result = await usage(reader({
        sheets: [sheet('Load', [block([scriptActionFor([line])])])],
        files: [{ folder: 'general', path: 'lvl_1.json', text: '{}' }, { folder: 'general', path: 'notes.json', text: '{}' }],
      }));
      expect(find(result.assets, 'lvl_1.json').status, line).toBe('not-analysed');
      expect(find(result.assets, 'lvl_1.json').reason, line).toContain('as a URL in a script in event sheet "Load"');
      expect(find(result.assets, 'notes.json').status, line).toBe('unused');
    }
    resetProjectIndex();
    const remote = await usage(reader({
      sheets: [sheet('Load', [block([scriptActionFor(['const r = await fetch("https://api.example.com/" + path);'])])])],
      files: [{ folder: 'general', path: 'lvl_1.json', text: '{}' }],
    }));
    expect(find(remote.assets, 'lvl_1.json').status).toBe('unused');
  });

  it('never reports unused when a project file cannot be read', async () => {
    class PartialReader extends MockReader {
      async listEventSheets(): Promise<string[]> {
        return [...(await super.listEventSheets()), 'Broken'];
      }
    }
    const r = new PartialReader({
      objects: mapOf([['Ghost', sprite('Ghost', { items: [anim('A', 1)], subfolders: [] })]]),
      files: [{ folder: 'sound', path: 'beep.webm' }, { folder: 'general', path: 'doc.txt' }],
    });
    const result = await getAssetUsage(r as never, { detail: 'full' });
    expect(result.summary.unusedCount).toBe(0);
    expect(find(result.assets, 'beep.webm').reason).toContain('event sheet "Broken"');
    expect(find(result.assets, 'doc.txt').reason).toContain('event sheet "Broken"');
    expect(find(result.assets, 'Ghost').status).toBe('not-analysed');
    // doc.txt itself could not be read either (no text in the mock)
    expect(result.notes.join(' ')).toContain('2 file(s) could not be read (event sheet "Broken", project file "doc.txt")');
  });
});

describe('get_asset_usage: summary and detail', () => {
  const data = () => reader({
    objects: [plainObject('Audio', 'Audio'), sprite('Player', { items: [anim('A', 1)], subfolders: [] })],
    layouts: [layout('Level', [layer('Main', [instance('Player')])])],
    sheets: [sheet('Sound', [block([act('Audio', 'play', { 'audio-file': 'jump' })])])],
    files: [
      { folder: 'sound', path: 'jump.webm' },
      { folder: 'sound', path: 'unused.webm' },
      { folder: 'icon', path: 'icon-16.png' },
    ],
  });

  it('counts used, unused and not-analysed assets', async () => {
    const result = await usage(data(), { detail: 'summary' });
    expect(result.assets).toBeUndefined();
    expect(result.summary).toMatchObject({
      totalAssets: 4,
      byType: { image: 1, sound: 2, icon: 1 },
      usedCount: 2,
      unusedCount: 1,
      notAnalysedCount: 1,
    });
    expect(result.summary.mostReferenced.map(m => m.name).sort()).toEqual(['Player', 'jump.webm']);
  });

  it('lists unused and not-analysed assets first and filters by type', async () => {
    const all = await usage(data(), { detail: 'standard' });
    expect(all.assets!.map(a => a.status)).toEqual(['unused', 'not-analysed', 'used', 'used']);
    resetProjectIndex();
    const sounds = await usage(data(), { type: 'sound', detail: 'full' });
    expect(sounds.summary.byType).toEqual({ sound: 2 });
    expect(sounds.assets!.map(a => a.name)).toEqual(['unused.webm', 'jump.webm']);
  });
});

describe('get_asset_usage and analyze_performance with the project reader', () => {
  const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'c3-assets-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const write = async (relPath: string, content: string | object) => {
    const file = join(dir, ...relPath.split('/'));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content, null, '\t'));
  };
  const folder = (items: unknown[] = [], subfolders: unknown[] = []) => ({ items, subfolders });
  const fileItem = (name: string) => ({ name, type: 'application/octet-stream', sid: sid++, 'file-info': { purpose: 'none' } });

  /** A folder project: project files in a subfolder, one registered file missing on disk, a flowchart */
  async function folderProject(extraObjects: Array<{ name: string }> = []): Promise<Construct3ProjectReader> {
    await write('project.c3proj', {
      projectFormatVersion: 1, savedWithRelease: 44900, name: 'Assets', runtime: 'c3', useWorker: 'dom', bundleAddons: false,
      usedAddons: [], uniqueId: 'assets-test',
      objectTypes: folder(['Hero', 'AJAX', ...extraObjects.map(o => o.name)]), families: folder(), layouts: folder(['Stage']), eventSheets: folder(['Main']),
      rootFileFolders: {
        script: folder(), music: folder(), video: folder(), font: folder(), icon: folder(),
        sound: folder([fileItem('beep.webm'), fileItem('chime.webm')]),
        general: folder([fileItem('page.html'), fileItem('extra.json')], [
          { name: 'data', items: [fileItem('level.json'), fileItem('gone.json')], subfolders: [] },
        ]),
      },
      timelines: folder(), flowcharts: folder(['Flow 1']), containers: [], properties: {},
    });
    await write('objectTypes/Hero.json', sprite('Hero', { items: [anim('Idle', 10)], subfolders: [{ name: 'Moves', items: [anim('Run', 45)], subfolders: [] }] }));
    await write('objectTypes/AJAX.json', plainObject('AJAX', 'AJAX'));
    for (const o of extraObjects) await write(`objectTypes/${o.name}.json`, o);
    await write('layouts/Stage.json', layout('Stage', [layer('Main', [instance('Hero')])]));
    await write('eventSheets/Main.json', sheet('Main', [block([act('AJAX', 'request-project-file', { tag: '"page"', file: 'page.html' })])]));
    await write('files/page.html', '\uFEFF<a href="data/level.json">next</a>');
    await write('files/data/level.json', '{"sound": "beep"}');
    await write('files/extra.json', '{}');
    await write('flowcharts/Flow 1.json', { name: 'Flow 1', sid: sid++, nodes: [{ sid: sid++, outputs: [{ name: 'file', value: 'extra.json' }] }] });
    await write('flowcharts/Flow 1.uistate.json', { note: 'chime.webm' });
    const reader = new Construct3ProjectReader(join(dir, 'project.c3proj'));
    await reader.loadProject();
    return reader;
  }

  it('reads project files from files/ and its subfolders, and data files below flowcharts/', async () => {
    const reader = await folderProject();
    expect(await reader.readProjectFileText('page.html')).toBe('<a href="data/level.json">next</a>');
    expect(await reader.readProjectFileText('data/level.json')).toBe('{"sound": "beep"}');
    await expect(reader.readProjectFileText('data/gone.json')).rejects.toThrow('Failed to read project file "data/gone.json"');
    await expect(reader.readProjectFileText('../project.c3proj')).rejects.toThrow('Path traversal');
    await write('files/big.txt', 'x'.repeat(10 * 1024 * 1024 + 1));
    await expect(reader.readProjectFileText('big.txt')).rejects.toThrow('exceeds 10MB limit');

    expect(await reader.listDataFiles('flowcharts')).toEqual(['Flow 1.json']);
    expect(await reader.listDataFiles('timelines')).toEqual([]);
    expect(await reader.readDataFileText('flowcharts', 'Flow 1.json')).toContain('extra.json');
    await expect(reader.readDataFileText('flowcharts', '../project.c3proj')).rejects.toThrow('Path traversal');
  });

  it('follows project files and flowcharts on disk, and counts frames in animation subfolders', async () => {
    const reader = await folderProject();
    const result = await getAssetUsage(reader, { detail: 'full' });
    expect(find(result.assets, 'Hero')).toMatchObject({ type: 'image', status: 'used', animations: 2, frames: 55 });
    expect(find(result.assets, 'page.html')).toMatchObject({ status: 'used', via: ['parameter'] });
    expect(find(result.assets, 'data/level.json')).toMatchObject({ status: 'used', via: ['project-file'], referencedIn: { projectFiles: ['page.html'] } });
    expect(find(result.assets, 'beep.webm')).toMatchObject({ status: 'used', via: ['project-file'], referencedIn: { projectFiles: ['data/level.json'] } });
    expect(find(result.assets, 'extra.json')).toMatchObject({ status: 'used', via: ['flowchart'], referencedIn: { flowcharts: ['Flow 1'] } });
    // The missing file is named by nothing, so it cannot name anything either; the UI state file is not read
    expect(find(result.assets, 'data/gone.json').status).toBe('unused');
    expect(find(result.assets, 'chime.webm').status).toBe('unused');
    expect(result.notes.join(' ')).toContain('project file "data/gone.json"');

    resetProjectIndex();
    const perf = await analyzePerformance(reader, { detail: 'full' });
    expect(perf.issues).toContainEqual(expect.objectContaining({ category: 'memory', location: 'Hero', message: 'Object has 55 animation frames total' }));
  });

  it('lists a Tiled Background created by create_object as a one-frame image', async () => {
    const reader = await folderProject([createTiledBgObject('Ground', sid++)]);
    const result = await getAssetUsage(reader, { type: 'image', detail: 'full' });
    expect(result.summary.byType).toEqual({ image: 2 });
    const ground = find(result.assets, 'Ground');
    expect(ground).toMatchObject({ type: 'image', status: 'unused', frames: 1, referencedIn: { eventSheets: [], layouts: [] } });
    expect('animations' in ground).toBe(false);
  });

  it('analyses the minimal-project fixture', async () => {
    const reader = new Construct3ProjectReader(join(FIXTURE_DIR, 'project.c3proj'));
    await reader.loadProject();
    const result = await getAssetUsage(reader, { detail: 'full' });
    expect(find(result.assets, 'Sprite')).toMatchObject({ type: 'image', status: 'used', animations: 1, frames: 1, referencedIn: { layouts: ['Layout 1'] } });
    expect(find(result.assets, 'icon-16.png')).toMatchObject({ type: 'icon', status: 'not-analysed' });
    expect(result.summary).toMatchObject({ unusedCount: 0 });
    expect(result.notes.join(' ')).not.toContain('could not be read');

    resetProjectIndex();
    const perf = await analyzePerformance(reader, { detail: 'full' });
    expect(perf.issues.filter(i => i.message.includes('animation frames'))).toEqual([]);
  });
});
