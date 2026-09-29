/**
 * Instance variable values on layout instances follow the object type's and
 * its families' instance variables (issue #38), as the editor saves them: a
 * value for every variable of the object and its families on each instance,
 * family variables first (checked against Scirra's example projects, see
 * instance-variables.ts). A family's effect entries go with the family.
 * Checked on a temp copy of the minimal fixture (a Sprite with one instance,
 * UID 0, in "Layout 1") with the real reader and writer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cp, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { registerObjectTools } from '../../src/tools/object-tools.js';
import { registerLayoutTools } from '../../src/tools/layout-tools.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

type Json = Record<string, any>;

let tmpDir: string;
let reader: Construct3ProjectReader;
let server: MockServer;

const layoutPath = () => join(tmpDir, 'layouts', 'Layout 1.json');
const familyPath = (name: string) => join(tmpDir, 'families', `${name}.json`);
const call = async (tool: string, args: Json): Promise<Json> => {
  const result = await server.callTool(tool, args);
  return result.isError ? { isError: true, text: result.content[0].text } : JSON.parse(result.content[0].text);
};

/** The instances of the layout, by UID. */
async function instances(): Promise<Map<number, Json>> {
  const layout = JSON.parse(await readFile(layoutPath(), 'utf8'));
  return new Map(layout.layers[0].instances.map((i: Json) => [i.uid, i]));
}
const valuesOf = async (uid = 0) => (await instances()).get(uid)!.instanceVariables;

/** Edit a family file directly (e.g. to give it effects, which no tool adds). */
async function editFamily(name: string, change: (family: Json) => void): Promise<void> {
  const family = JSON.parse(await readFile(familyPath(name), 'utf8'));
  change(family);
  await writeFile(familyPath(name), JSON.stringify(family, null, '\t'));
  await reader.loadProject();
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-instance-variables-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
  reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  const writer = new Construct3ProjectWriter(reader, idGen);
  server = new MockServer();
  registerObjectTools({ server, reader, writer, idGen } as never);
  registerLayoutTools({ server, reader, writer, idGen } as never);
  resetProjectIndex();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('update_object_properties', () => {
  it('gives every instance the default value of an added variable, and removes a removed one\'s value', async () => {
    const added = await call('update_object_properties', {
      name: 'Sprite',
      addVariables: [{ name: 'hp', type: 'number' }, { name: 'label', type: 'string' }, { name: 'alive', type: 'boolean' }],
    });
    expect(added.success).toBe(true);
    expect(await valuesOf()).toEqual({ hp: 0, label: '', alive: false });

    await call('update_instance', { layoutName: 'Layout 1', uid: 0, instanceVariables: { hp: 5 } });
    const removed = await call('update_object_properties', { name: 'Sprite', removeVariables: ['hp'], force: true });
    expect(removed.success).toBe(true);
    expect(await valuesOf()).toEqual({ label: '', alive: false });
  });
});

describe('add_instance_to_layout', () => {
  it('writes a value for every variable of the object and its families, family variables first, given values on top', async () => {
    await call('update_object_properties', { name: 'Sprite', addVariables: [{ name: 'hp', type: 'number' }, { name: 'tag', type: 'string' }] });
    await call('create_family', { name: 'Foes', pluginId: 'Sprite', members: ['Sprite'] });
    await call('update_family', { name: 'Foes', addVariables: [{ name: 'armor', type: 'number' }] });

    const data = await call('add_instance_to_layout', {
      layoutName: 'Layout 1', layerName: 'Main', objectType: 'Sprite', x: 0, y: 0, instanceVariables: { tag: 'boss', armor: 3 },
    });
    expect(data.success).toBe(true);
    const values = await valuesOf(data.generatedUid);
    expect(values).toEqual({ armor: 3, hp: 0, tag: 'boss' });
    expect(Object.keys(values)).toEqual(['armor', 'hp', 'tag']);
  });

  it('refuses a value for a variable the object and its families do not have', async () => {
    const data = await call('add_instance_to_layout', {
      layoutName: 'Layout 1', layerName: 'Main', objectType: 'Sprite', x: 0, y: 0, instanceVariables: { nosuchvar: 1 },
    });
    expect(data.isError).toBe(true);
    expect(data.text).toContain('"Sprite" and its families have no instance variable "nosuchvar"');
    expect((await instances()).size).toBe(1);
  });
});

describe('update_family and delete_family', () => {
  beforeEach(async () => {
    await call('update_object_properties', { name: 'Sprite', addVariables: [{ name: 'hp', type: 'number' }] });
    await call('create_family', { name: 'Foes', pluginId: 'Sprite', members: ['Sprite'] });
  });

  it('adds a family variable to the member instances before their own, and removes it again', async () => {
    await call('update_family', { name: 'Foes', addVariables: [{ name: 'armor', type: 'number' }] });
    expect(Object.entries(await valuesOf())).toEqual([['armor', 0], ['hp', 0]]);

    await call('update_family', { name: 'Foes', removeVariables: ['armor'], force: true });
    expect(await valuesOf()).toEqual({ hp: 0 });
  });

  it('gives a joining member the family\'s variables and takes them from a leaving one', async () => {
    await call('update_family', { name: 'Foes', addVariables: [{ name: 'armor', type: 'number' }] });
    await call('update_family', { name: 'Foes', removeMembers: ['Sprite'], force: true });
    expect(await valuesOf()).toEqual({ hp: 0 });

    await call('update_family', { name: 'Foes', addMembers: ['Sprite'] });
    expect(await valuesOf()).toEqual({ armor: 0, hp: 0 });
  });

  it('keeps a value the member still gets from another family', async () => {
    await call('update_family', { name: 'Foes', addVariables: [{ name: 'armor', type: 'number' }] });
    await call('create_family', { name: 'Tanks', pluginId: 'Sprite', members: ['Sprite'] });
    await call('update_family', { name: 'Tanks', addVariables: [{ name: 'armor', type: 'number' }] });
    await call('update_instance', { layoutName: 'Layout 1', uid: 0, instanceVariables: { armor: 7 } });

    await call('delete_family', { name: 'Foes', force: true });
    expect(await valuesOf()).toEqual({ armor: 7, hp: 0 });
  });

  it('delete_family removes the values of the family\'s variables and its effect entries, keeping the member\'s own', async () => {
    await call('update_family', { name: 'Foes', addVariables: [{ name: 'shield', type: 'number' }] });
    await editFamily('Foes', family => { family.effectTypes = [{ effectId: 'hsladjust', name: 'AdjustHSL' }]; });
    // As the editor saves a member instance: an entry for the family's effect and its own
    const layout = JSON.parse(await readFile(layoutPath(), 'utf8'));
    layout.layers[0].instances[0].effects = {
      AdjustHSL: { isEnabled: true, parameters: { hue: 0, saturation: 1, luminosity: 1 } },
      Own: { isEnabled: true, parameters: {} },
    };
    await writeFile(layoutPath(), JSON.stringify(layout, null, '\t'));
    const sprite = JSON.parse(await readFile(join(tmpDir, 'objectTypes', 'Sprite.json'), 'utf8'));
    sprite.effectTypes = [{ effectId: 'grayscale', name: 'Own' }];
    await writeFile(join(tmpDir, 'objectTypes', 'Sprite.json'), JSON.stringify(sprite, null, '\t'));
    await reader.loadProject();

    const data = await call('delete_family', { name: 'Foes', force: true });
    expect(data.success).toBe(true);
    const instance = (await instances()).get(0)!;
    expect(instance.instanceVariables).toEqual({ hp: 0 });
    expect(Object.keys(instance.effects)).toEqual(['Own']);
  });
});

describe('update_instance', () => {
  beforeEach(async () => {
    await call('update_object_properties', { name: 'Sprite', addVariables: [{ name: 'hp', type: 'number' }] });
    await call('create_family', { name: 'Foes', pluginId: 'Sprite', members: ['Sprite'] });
    await call('update_family', { name: 'Foes', addVariables: [{ name: 'armor', type: 'number' }] });
  });

  it('sets the object\'s and its families\' variables', async () => {
    const data = await call('update_instance', { layoutName: 'Layout 1', uid: 0, instanceVariables: { hp: 3, armor: 2 } });
    expect(data.success).toBe(true);
    expect(data.warnings).toBeUndefined();
    expect(await valuesOf()).toEqual({ armor: 2, hp: 3 });
  });

  it('refuses a name the object and its families have no variable of, with a hint for another case', async () => {
    const data = await call('update_instance', { layoutName: 'Layout 1', uid: 0, instanceVariables: { nosuchvar: 1, HP: 2 } });
    expect(data.isError).toBe(true);
    expect(data.text).toContain('no instance variable "nosuchvar", "HP" (names are matched with their letter case: "hp"?)');
    expect(data.text).toContain('Its instance variables: armor (number), hp (number)');
    expect(await valuesOf()).toEqual({ armor: 0, hp: 0 });
  });

  it('warns about a value of another type than the variable', async () => {
    const data = await call('update_instance', { layoutName: 'Layout 1', uid: 0, instanceVariables: { hp: 'lots' } });
    expect(data.success).toBe(true);
    expect(data.warnings[0]).toContain('"hp" is a number variable, got "lots"');
  });
});
