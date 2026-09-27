/**
 * Layer trees (layers[].subLayers, nested to any depth): the shared walker and
 * every reader that relies on it (ID allocation, duplicate ID checks, the
 * project index, orphan/dependency analysis, performance counts). Synthetic
 * layouts shaped like editor-saved ones: every layer has a subLayers array.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockReader } from '../mocks/mock-reader.js';
import {
  allLayers,
  countInstancesInLayerTree,
  findInstanceByUid,
  findLayerNameClash,
  findLayersByName,
  forEachLayoutInstance,
  layerEntries,
  layerPath,
  layerPathLabel,
  repeatedLayerNames,
} from '../../src/construct3/layers.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { validateProjectIntegrity } from '../../src/construct3/analyzers/integrity.js';
import { getProjectIndex, resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { findOrphanedObjects, getObjectDependencies } from '../../src/construct3/analyzers/object-deps.js';
import { analyzePerformance } from '../../src/construct3/analyzers/performance.js';
import type { Layout } from '../../src/construct3/types.js';

type Json = Record<string, unknown>;

function layer(name: string, sid: number, instances: Json[] = [], subLayers: Json[] = []): Json {
  return { name, sid, instances, subLayers, effectTypes: [] };
}

function inst(type: string, uid: number, sid: number, extra: Json = {}): Json {
  return { type, uid, sid, properties: {}, instanceVariables: {}, behaviors: {}, world: { x: 0, y: 0, width: 10, height: 10 }, ...extra };
}

/**
 * Layout1:
 *   Backdrop        [Sprite1 uid 1]
 *   Main              [Sprite1 uid 2]
 *     HUD             [Sprite2 uid 3]
 *       Buttons       [Sprite3 uid 9]   (highest UID, two levels down)
 *     Effects         []
 *   non-world         [Array1 uid 4]
 */
function nestedLayout(): Json {
  return {
    name: 'Layout1', sid: 300, eventSheet: 'Sheet1',
    layers: [
      layer('Backdrop', 301, [inst('Sprite1', 1, 311)]),
      layer('Main', 302, [inst('Sprite1', 2, 312)], [
        layer('HUD', 303, [inst('Sprite2', 3, 313)], [
          layer('Buttons', 304, [inst('Sprite3', 9, 314)]),
        ]),
        layer('Effects', 305),
      ]),
    ],
    'nonworld-instances': [{ type: 'Array1', uid: 4, sid: 315, properties: {} }],
  };
}

function nestedProject(layout: Json = nestedLayout(), extra: Partial<ConstructorParameters<typeof MockReader>[0]> = {}) {
  const sprite = (name: string, sid: number) => [name, { name, 'plugin-id': 'Sprite', sid }] as [string, Json];
  return new MockReader({
    objects: new Map([
      sprite('Sprite1', 101), sprite('Sprite2', 102), sprite('Sprite3', 103), sprite('Sprite4', 104),
      ['Array1', { name: 'Array1', 'plugin-id': 'Arr', sid: 110 }],
    ]),
    eventSheets: new Map([['Sheet1', { name: 'Sheet1', sid: 200, events: [] }]]),
    layouts: new Map([['Layout1', layout]]),
    usedAddons: [
      { type: 'plugin', id: 'Sprite', name: 'Sprite', author: 'Scirra', bundled: false },
      { type: 'plugin', id: 'Arr', name: 'Array', author: 'Scirra', bundled: false },
    ],
    ...extra,
  }) as any;
}

describe('layer walker', () => {
  it('lists every layer in file order, parents before their sub-layers, with paths and depths', () => {
    const layout = nestedLayout() as unknown as Layout;
    const entries = layerEntries(layout.layers);
    expect(entries.map(layerPathLabel)).toEqual([
      'Backdrop', 'Main', 'Main > HUD', 'Main > HUD > Buttons', 'Main > Effects',
    ]);
    expect(entries.map(e => e.depth)).toEqual([0, 0, 1, 2, 1]);
    // siblings/index point at the array that holds the layer, parent at the enclosing layer
    const buttons = entries[3];
    expect(buttons.siblings[buttons.index]).toBe(buttons.layer);
    expect(buttons.parent?.layer.name).toBe('HUD');
    expect(entries[0].parent).toBeUndefined();
    expect(layerPath(buttons)).toEqual(['Main', 'HUD', 'Buttons']);
    expect(allLayers(layout.layers)).toHaveLength(5);
  });

  it('skips entries that are not objects and layers without subLayers or instances', () => {
    const layers = [null, 'x', { name: 'A', sid: 1 }, { name: 'B', sid: 2, subLayers: [7, { name: 'C', sid: 3, instances: [null, { type: 'T', uid: 1 }] }] }];
    expect(layerEntries(layers).map(layerPathLabel)).toEqual(['A', 'B', 'B > C']);
    const seen: string[] = [];
    forEachLayoutInstance({ name: 'L', sid: 0, layers } as unknown as Layout, (i, e) => seen.push(`${i.type}@${e ? layerPathLabel(e) : 'nonworld'}`));
    expect(seen).toEqual(['T@B > C']);
    expect(layerEntries(undefined)).toEqual([]);
  });

  it('visits instances on every layer and sub-layer, then the non-world instances', () => {
    const seen: string[] = [];
    forEachLayoutInstance(nestedLayout() as unknown as Layout, (i, e) => seen.push(`${i.uid}@${e ? layerPathLabel(e) : 'nonworld'}`));
    expect(seen).toEqual(['1@Backdrop', '2@Main', '3@Main > HUD', '9@Main > HUD > Buttons', '4@nonworld']);
  });

  it('finds layers by name and instances by UID at any depth', () => {
    const layout = nestedLayout() as unknown as Layout;
    expect(findLayersByName(layout.layers, 'Buttons').map(layerPathLabel)).toEqual(['Main > HUD > Buttons']);
    expect(findLayersByName(layout.layers, 'Nope')).toEqual([]);
    const deep = findInstanceByUid(layout, 9)!;
    expect(deep.instance.type).toBe('Sprite3');
    expect(layerPathLabel(deep.entry!)).toBe('Main > HUD > Buttons');
    expect(deep.list[deep.index]).toBe(deep.instance);
    const nonworld = findInstanceByUid(layout, 4)!;
    expect(nonworld.entry).toBeUndefined();
    expect(nonworld.instance.type).toBe('Array1');
    expect(findInstanceByUid(layout, 99)).toBeUndefined();
  });

  it('finds a layer name clash anywhere in the tree, exactly or ignoring case, leaving out one layer', () => {
    const layout = nestedLayout() as unknown as Layout;
    expect(findLayerNameClash(layout.layers, 'Buttons')?.layer.name).toBe('Buttons');
    expect(layerPathLabel(findLayerNameClash(layout.layers, 'bUTTONS')!)).toBe('Main > HUD > Buttons');
    expect(findLayerNameClash(layout.layers, 'Nope')).toBeUndefined();
    // Changing the case of a layer's own name clashes with nothing
    const buttons = findLayersByName(layout.layers, 'Buttons')[0].layer;
    expect(findLayerNameClash(layout.layers, 'BUTTONS', buttons)).toBeUndefined();
    // An exact match wins over a case variant found earlier in file order
    const layers = [layer('hud', 1), layer('Main', 2, [], [layer('HUD', 3)])];
    expect(layerPathLabel(findLayerNameClash(layers, 'HUD')!)).toBe('Main > HUD');
    // Names are compared Unicode-normalized: "e" + combining acute equals the precomposed letter
    expect(findLayerNameClash([layer('Café', 4)], 'CAFÉ')?.layer.name).toBe('Café');
  });

  it('groups layer names repeated in the tree, ignoring case', () => {
    expect(repeatedLayerNames((nestedLayout() as unknown as Layout).layers)).toEqual([]);
    const layers = [layer('HUD', 1), layer('Main', 2, [], [layer('hud', 3), layer('Other', 4, [], [layer('Hud', 5)])]), layer('Main', 6)];
    expect(repeatedLayerNames(layers).map(group => group.map(layerPathLabel))).toEqual([
      ['HUD', 'Main > hud', 'Main > Other > Hud'],
      ['Main', 'Main'],
    ]);
  });

  it('counts the instances of a layer together with its sub-layers', () => {
    const layout = nestedLayout() as unknown as Layout;
    const main = findLayersByName(layout.layers, 'Main')[0].layer;
    expect(countInstancesInLayerTree(main)).toBe(3);
  });

  it('walks very deep trees without overflowing the stack', () => {
    let top: Json = layer('L19999', 1, [inst('Sprite1', 1, 2)]);
    for (let i = 19_998; i >= 0; i--) top = layer(`L${i}`, i + 10, [], [top]);
    const entries = layerEntries([top]);
    expect(entries).toHaveLength(20_000);
    const deepest = entries[entries.length - 1];
    expect(deepest.depth).toBe(19_999);
    expect(layerPath(deepest)).toHaveLength(20_000);
    const found = findInstanceByUid({ name: 'L', sid: 0, layers: [top] } as unknown as Layout, 1);
    expect(found?.entry?.layer.name).toBe('L19999');
  });
});

describe('IdGenerator with sub-layers', () => {
  afterEach(() => vi.restoreAllMocks());

  it('allocates UIDs above the highest UID on any sub-layer', async () => {
    const idGen = new IdGenerator();
    expect(await idGen.generateUid(nestedProject())).toBe(10);
  });

  it('never hands out a SID used by a sub-layer or one of its instances', async () => {
    const SID_MIN = 100_000_000_000_000;
    const layout = nestedLayout();
    // The deepest sub-layer and its instance hold the SIDs a random value of 0 and 1e-15 would produce
    const buttons = ((layout.layers as Json[])[1].subLayers as Json[])[0].subLayers as Json[];
    buttons[0].sid = SID_MIN;
    ((buttons[0].instances as Json[])[0]).sid = SID_MIN + 1;
    const random = vi.spyOn(Math, 'random');
    random.mockReturnValueOnce(0).mockReturnValueOnce(1.5e-15).mockReturnValueOnce(0.5);
    const idGen = new IdGenerator();
    const sid = await idGen.generateSid(nestedProject(layout));
    expect(sid).not.toBe(SID_MIN);
    expect(sid).not.toBe(SID_MIN + 1);
    expect(random).toHaveBeenCalledTimes(3);
  });
});

describe('duplicate IDs on sub-layers (validate_project)', () => {
  beforeEach(() => resetProjectIndex());

  it('reports a sub-layer instance that shares a UID with a top-level instance, with its layer path', async () => {
    const layout = nestedLayout();
    const buttons = ((layout.layers as Json[])[1].subLayers as Json[])[0].subLayers as Json[];
    ((buttons[0].instances as Json[])[0]).uid = 1; // same as Backdrop's Sprite1
    const result = await validateProjectIntegrity(nestedProject(layout));
    const dupes = result.warnings.filter(w => w.check === 'duplicate-uid');
    expect(dupes).toHaveLength(1);
    expect(dupes[0].message).toContain('UID 1 is used 2 times');
    expect(dupes[0].message).toContain('layouts/Layout1/layer:Backdrop/inst:Sprite1');
    expect(dupes[0].message).toContain('layouts/Layout1/layer:Main/layer:HUD/layer:Buttons/inst:Sprite3');
  });

  it('reports duplicate SIDs of sub-layers, their instances and non-world instances', async () => {
    const layout = nestedLayout();
    const hud = ((layout.layers as Json[])[1].subLayers as Json[])[0];
    hud.sid = 301; // same as the Backdrop layer
    ((hud.instances as Json[])[0]).sid = 315; // same as the non-world Array1 instance
    const result = await validateProjectIntegrity(nestedProject(layout));
    const dupes = result.warnings.filter(w => w.check === 'duplicate-sid').map(w => w.message);
    expect(dupes).toHaveLength(2);
    expect(dupes.find(m => m.includes('SID 301 '))).toContain('layouts/Layout1/layer:Main/layer:HUD');
    const instanceDupe = dupes.find(m => m.includes('SID 315 '))!;
    expect(instanceDupe).toContain('layouts/Layout1/layer:Main/layer:HUD/inst:Sprite2:3');
    expect(instanceDupe).toContain('layouts/Layout1/nonworld:Array1:4');
  });

  it('stays quiet when all IDs in the tree are unique', async () => {
    const result = await validateProjectIntegrity(nestedProject());
    expect(result.warnings.filter(w => w.check === 'duplicate-uid' || w.check === 'duplicate-sid')).toEqual([]);
  });
});

describe('object uses on sub-layers and in object properties (project index)', () => {
  beforeEach(() => resetProjectIndex());

  it('records instances per layout and layer path, sub-layers and non-world instances included', async () => {
    const index = await getProjectIndex(nestedProject());
    expect(index.objectPlacements.get('Sprite1')).toEqual([
      { layout: 'Layout1', layer: 'Backdrop', instances: 1 },
      { layout: 'Layout1', layer: 'Main', instances: 1 },
    ]);
    expect(index.objectPlacements.get('Sprite3')).toEqual([{ layout: 'Layout1', layer: 'Main > HUD > Buttons', instances: 1 }]);
    expect(index.objectPlacements.get('Array1')).toEqual([{ layout: 'Layout1', instances: 1 }]);
    expect(index.objectToLayouts.get('Sprite3')).toEqual(['Layout1']);
  });

  it('counts an object only placed on a nested sub-layer as used in every analysis', async () => {
    const reader = nestedProject();
    const orphans = await findOrphanedObjects(reader);
    expect(orphans.orphanedObjects.map(o => o.name)).toEqual(['Sprite4']);
    const deps = await getObjectDependencies(reader, { object: 'Sprite3' });
    expect(deps.object!.referencedIn.layouts).toEqual(['Layout1']);
    expect(deps.object!.referenceCount).toBe(1);
    const all = await getObjectDependencies(reader);
    expect(all.projectWide!.orphanedObjects).toEqual(['Sprite4']);
    const result = await validateProjectIntegrity(reader);
    expect(result.info.filter(i => i.check === 'orphaned-object').map(i => i.entity)).toEqual(['objectTypes/Sprite4']);
  });

  it('counts an instance property that holds an object type\'s SID as a use of that object', async () => {
    const layout = nestedLayout();
    // A particles-like instance whose "object" property stores Sprite4's SID
    (layout.layers as Json[])[0].instances = [inst('Sprite1', 1, 311, { properties: { object: 104, rate: 50 } })];
    const reader = nestedProject(layout);
    const index = await getProjectIndex(reader);
    expect(index.getObjectUsage('Sprite4').instanceProperties).toEqual([
      { layout: 'Layout1', layer: 'Backdrop', objectType: 'Sprite1', uid: 1, property: 'object' },
    ]);
    expect(index.isObjectUsed('Sprite4')).toBe(true);
    expect((await findOrphanedObjects(reader)).orphanedObjects).toEqual([]);
    expect((await getObjectDependencies(reader, { object: 'Sprite4' })).object!.referencedIn.layouts).toEqual(['Layout1']);
  });

  it('lists the families of orphans that are family members, which delete_object refuses', async () => {
    const reader = nestedProject(nestedLayout(), {
      families: new Map([['Family1', { name: 'Family1', 'plugin-id': 'Sprite', sid: 120, members: ['Sprite4'] }]]),
    });
    const index = await getProjectIndex(reader);
    expect(index.isObjectUsed('Sprite4')).toBe(false);
    expect(index.isObjectReferenced('Sprite4')).toBe(true);
    const orphans = await findOrphanedObjects(reader);
    expect(orphans.orphanedObjects).toEqual([{ name: 'Sprite4', pluginId: 'Sprite', isGlobal: false, families: ['Family1'] }]);
    const result = await validateProjectIntegrity(reader);
    const info = result.info.find(i => i.entity === 'objectTypes/Sprite4')!;
    expect(info.suggestion).toContain('member of "Family1"');
  });

  it('counts sub-layer instances in the layout instance total of analyze_performance', async () => {
    const buttons = Array.from({ length: 501 }, (_, i) => inst('Sprite3', 100 + i, 1000 + i));
    const layout = { name: 'Layout1', sid: 300, layers: [layer('Main', 301, [], [layer('Sub', 302, buttons)])] };
    const perf = await analyzePerformance(nestedProject(layout));
    const issue = perf.issues.find(i => i.category === 'layout-complexity');
    expect(issue?.message).toBe('Layout has 501 instances');
  });
});

describe('broken object references left by a forced delete (validate_project)', () => {
  beforeEach(() => resetProjectIndex());

  it('reports instances of a missing object type on sub-layers and among the non-world instances', async () => {
    const layout = nestedLayout();
    (layout['nonworld-instances'] as Json[]).push({ type: 'Gone', uid: 20, sid: 320, properties: {} });
    const effects = ((layout.layers as Json[])[1].subLayers as Json[])[1];
    effects.instances = [inst('Gone', 21, 321), inst('Gone', 22, 322)];
    const result = await validateProjectIntegrity(nestedProject(layout));
    const broken = result.warnings.filter(w => w.check === 'broken-object-reference');
    expect(broken).toHaveLength(1);
    expect(broken[0].entity).toBe('layouts/Layout1');
    expect(broken[0].message).toContain('3 instance(s) of "Gone"');
    expect(broken[0].message).toContain('UID 21 on layer "Main > Effects"');
    expect(broken[0].message).toContain('UID 20 among the non-world instances');
    expect(broken[0].suggestion).toContain('delete_instance_from_layout');
  });

  it('reports object parameters that name no object type or family', async () => {
    const reader = nestedProject(nestedLayout(), {
      eventSheets: new Map([['Sheet1', {
        name: 'Sheet1', sid: 200,
        events: [{
          eventType: 'block', sid: 201, conditions: [],
          actions: [
            { id: 'spawn-another-object', objectClass: 'Sprite1', sid: 202, parameters: { object: 'Gone', layer: '0', 'image-point': '0' } },
            // Not an object parameter key: never recorded
            { id: 'set-text', objectClass: 'Sprite1', sid: 203, parameters: { text: 'Gone' } },
          ],
        }],
      }]]),
    });
    const result = await validateProjectIntegrity(reader);
    const broken = result.warnings.filter(w => w.check === 'broken-object-reference');
    expect(broken.map(w => w.entity)).toEqual(['objectReference/Gone']);
    expect(broken[0].suggestion).toContain('Sheet1');
    const index = await getProjectIndex(reader);
    expect(index.objectToEventSheets.get('Gone')!.map(r => r.context)).toEqual(['parameter']);
  });

  it('scans an object parameter holding an expression for object names instead of reporting it', async () => {
    const reader = nestedProject(nestedLayout(), {
      eventSheets: new Map([['Sheet1', {
        name: 'Sheet1', sid: 200,
        events: [{
          eventType: 'block', sid: 201, conditions: [],
          actions: [{ id: 'spawn-another-object', objectClass: 'Sprite1', sid: 202, parameters: { object: 'Sprite4.X', layer: '0' } }],
        }],
      }]]),
    });
    const index = await getProjectIndex(reader);
    expect(index.isObjectUsed('Sprite4')).toBe(true);
    expect(index.objectToEventSheets.get('Sprite4')!.map(r => r.context)).toEqual(['expression']);
    expect(index.objectToEventSheets.has('Sprite4.X')).toBe(false);
    const result = await validateProjectIntegrity(reader);
    expect(result.warnings.filter(w => w.check === 'broken-object-reference')).toEqual([]);
    expect((await findOrphanedObjects(reader)).orphanedObjects).toEqual([]);
  });

  it('reports family members that are no object type', async () => {
    const reader = nestedProject(nestedLayout(), {
      families: new Map([
        ['Family1', { name: 'Family1', 'plugin-id': 'Sprite', sid: 120, members: ['Sprite1', 'Gone', 'Gone2'] }],
        ['Family2', { name: 'Family2', 'plugin-id': 'Sprite', sid: 121, members: ['Sprite2'] }],
      ]),
    });
    const result = await validateProjectIntegrity(reader);
    const broken = result.warnings.filter(w => w.check === 'broken-object-reference');
    expect(broken.map(w => w.entity)).toEqual(['families/Family1']);
    expect(broken[0].message).toContain('2 member(s) that are not object types in the project: "Gone", "Gone2"');
    expect(broken[0].suggestion).toContain('removeMembers');
  });

  describe('object properties holding a SID (Particles "object")', () => {
    /** Layout1 with a Particles instance whose "object" property holds `object` */
    function particlesProject(object: unknown, pluginId = 'Particles') {
      const layout = nestedLayout();
      (layout.layers as Json[])[0].instances = [inst('Particles1', 1, 311, { properties: { object, rate: 50 } })];
      const objects = new Map<string, Json>([
        ['Particles1', { name: 'Particles1', 'plugin-id': pluginId, sid: 130 }],
        ['Sprite1', { name: 'Sprite1', 'plugin-id': 'Sprite', sid: 101 }],
        ['Sprite2', { name: 'Sprite2', 'plugin-id': 'Sprite', sid: 102 }],
        ['Sprite3', { name: 'Sprite3', 'plugin-id': 'Sprite', sid: 103 }],
        ['Sprite4', { name: 'Sprite4', 'plugin-id': 'Sprite', sid: 104 }],
        ['Array1', { name: 'Array1', 'plugin-id': 'Arr', sid: 110 }],
      ]);
      return nestedProject(layout, { objects });
    }

    const brokenOf = async (reader: unknown) =>
      (await validateProjectIntegrity(reader as never)).warnings.filter(w => w.check === 'broken-object-reference');

    it('reports a SID that is no object type or family', async () => {
      const broken = await brokenOf(particlesProject(999_999_999_999_991));
      expect(broken).toHaveLength(1);
      expect(broken[0].entity).toBe('layouts/Layout1');
      expect(broken[0].message).toContain('property "object" of "Particles1" UID 1 on layer "Backdrop" holds SID 999999999999991');
    });

    it('stays quiet for an existing object\'s SID and for -1 (no object set)', async () => {
      expect(await brokenOf(particlesProject(104))).toEqual([]);
      expect(await brokenOf(particlesProject(-1))).toEqual([]);
    });

    it('does not guess for plugins whose properties are not known to hold a SID', async () => {
      expect(await brokenOf(particlesProject(999_999_999_999_991, 'Sprite'))).toEqual([]);
    });
  });
});

describe('duplicate layer names (validate_project)', () => {
  beforeEach(() => resetProjectIndex());

  it('reports a sub-layer named like another layer of the layout, ignoring case', async () => {
    const layout = nestedLayout();
    ((layout.layers as Json[])[1].subLayers as Json[])[1].name = 'backdrop'; // Main > Effects
    const result = await validateProjectIntegrity(nestedProject(layout));
    const dupes = result.warnings.filter(w => w.check === 'duplicate-layer-name');
    expect(dupes).toHaveLength(1);
    expect(dupes[0].entity).toBe('layouts/Layout1');
    expect(dupes[0].message).toContain('2 layers named "Backdrop" (ignoring case): "Backdrop", "Main > backdrop"');
    expect(dupes[0].suggestion).toContain('"Main > backdrop"');
  });

  it('stays quiet when every layer name in the tree is different', async () => {
    const result = await validateProjectIntegrity(nestedProject());
    expect(result.warnings.filter(w => w.check === 'duplicate-layer-name')).toEqual([]);
  });
});
