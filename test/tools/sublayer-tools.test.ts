/**
 * Layout and object tools on layouts with nested sub-layers (layers[].subLayers),
 * and delete_object's reference check (every kind of use, listed in the refusal).
 * Synthetic layouts shaped like editor-saved ones.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MockServer } from '../mocks/mock-server.js';
import { MockReader } from '../mocks/mock-reader.js';
import { MockWriter } from '../mocks/mock-writer.js';
import { MockIdGenerator } from '../mocks/mock-id-generator.js';
import { registerLayoutTools } from '../../src/tools/layout-tools.js';
import { registerObjectTools } from '../../src/tools/object-tools.js';
import { registerAnalysisTools } from '../../src/tools/analysis.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';

type Json = Record<string, any>;

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
 *       Buttons       [Sprite3 uid 9]
 *     Effects         []
 *   non-world         [Array1 uid 4]
 */
function nestedLayout(): Json {
  return {
    name: 'Layout1', sid: 300,
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

const sprite = (name: string, sid: number, extra: Json = {}) =>
  [name, { name, 'plugin-id': 'Sprite', sid, instanceVariables: [], behaviorTypes: [], ...extra }] as [string, Json];

function projectData(extra: Json = {}): Json {
  return {
    objects: new Map([
      sprite('Sprite1', 101), sprite('Sprite2', 102), sprite('Sprite3', 103), sprite('Sprite4', 104), sprite('Sprite5', 105),
      ['Array1', { name: 'Array1', 'plugin-id': 'Arr', sid: 110, isGlobal: true }],
    ]),
    eventSheets: new Map([['Sheet1', { name: 'Sheet1', sid: 200, events: [] }]]),
    layouts: new Map([['Layout1', nestedLayout()]]),
    ...extra,
  };
}

function setup(readerData: Json = projectData(), idGen: unknown = new MockIdGenerator()) {
  resetProjectIndex();
  const server = new MockServer();
  const reader = new MockReader(readerData);
  const writer = new MockWriter();
  registerLayoutTools({ server, reader, writer, idGen } as any);
  registerObjectTools({ server, reader, writer, idGen } as any);
  registerAnalysisTools(server as any, reader as any);
  return { server, reader, writer };
}

function parseResult(result: any) {
  return JSON.parse(result.content[0].text);
}

/** The layout data of the last layout write */
function writtenLayout(writer: MockWriter): Json {
  const writes = writer.callsFor('writeEntityFile').filter(c => c.args[0] === 'layouts');
  return writes[writes.length - 1].args[2] as Json;
}

function subLayer(layout: Json, ...path: string[]): Json {
  let layers: Json[] = layout.layers;
  let found: Json | undefined;
  for (const name of path) {
    found = layers.find(l => l.name === name);
    layers = found?.subLayers ?? [];
  }
  return found!;
}

function allUids(layout: Json): number[] {
  const uids: number[] = [];
  const walk = (ls: Json[]) => { for (const l of ls) { for (const i of l.instances ?? []) uids.push(i.uid); walk(l.subLayers ?? []); } };
  walk(layout.layers);
  for (const i of layout['nonworld-instances'] ?? []) uids.push(i.uid);
  return uids;
}

describe('layout tools on sub-layers', () => {
  it('add_instance_to_layout places an instance on a nested sub-layer by name', async () => {
    const { server, writer } = setup();
    const data = parseResult(await server.callTool('add_instance_to_layout', {
      layoutName: 'Layout1', layerName: 'Buttons', objectType: 'Sprite4', x: 5, y: 5,
    }));
    expect(data.success).toBe(true);
    const buttons = subLayer(writtenLayout(writer), 'Main', 'HUD', 'Buttons');
    expect(buttons.instances.map((i: Json) => i.type)).toEqual(['Sprite3', 'Sprite4']);
  });

  it('add_instance_to_layout gives a new instance a UID above the highest one on any sub-layer', async () => {
    const { server, writer } = setup(projectData(), new IdGenerator());
    const data = parseResult(await server.callTool('add_instance_to_layout', {
      layoutName: 'Layout1', layerName: 'Backdrop', objectType: 'Sprite4', x: 5, y: 5,
    }));
    expect(data.generatedUid).toBe(10);
    const uids = allUids(writtenLayout(writer));
    expect(new Set(uids).size).toBe(uids.length);
  });

  it('add_instance_to_layout lists sub-layers as paths when the layer does not exist', async () => {
    const { server } = setup();
    const result = await server.callTool('add_instance_to_layout', {
      layoutName: 'Layout1', layerName: 'Nope', objectType: 'Sprite4', x: 0, y: 0,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Available layers: Backdrop, Main, Main > HUD, Main > HUD > Buttons, Main > Effects');
  });

  it('refuses a layer name that several layers of the layout use', async () => {
    const layout = nestedLayout();
    subLayer(layout, 'Main', 'Effects').name = 'Backdrop';
    const { server, writer } = setup(projectData({ layouts: new Map([['Layout1', layout]]) }));
    const result = await server.callTool('add_instance_to_layout', {
      layoutName: 'Layout1', layerName: 'Backdrop', objectType: 'Sprite4', x: 0, y: 0,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('is used by 2 layers');
    expect(result.content[0].text).toContain('Main > Backdrop');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('add_layer refuses a name that a nested sub-layer already uses', async () => {
    const { server, writer } = setup();
    const result = await server.callTool('add_layer', { layoutName: 'Layout1', layerName: 'Buttons' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already exists');
    expect(result.content[0].text).toContain('sub-layer "Main > HUD > Buttons"');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('add_layer refuses a name that differs from a sub-layer\'s name only in case', async () => {
    const { server, writer } = setup();
    const result = await server.callTool('add_layer', { layoutName: 'Layout1', layerName: 'bUTTONS' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('differs only in case from the existing layer "Buttons" (sub-layer "Main > HUD > Buttons")');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('update_layer refuses a case variant of another layer\'s name and accepts one of its own', async () => {
    const { server, writer } = setup();
    const clash = await server.callTool('update_layer', { layoutName: 'Layout1', layerName: 'Backdrop', newName: 'effects' });
    expect(clash.isError).toBe(true);
    expect(clash.content[0].text).toContain('differs only in case from the existing layer "Effects" (sub-layer "Main > Effects")');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);

    const recased = parseResult(await server.callTool('update_layer', { layoutName: 'Layout1', layerName: 'Effects', newName: 'EFFECTS' }));
    expect(recased.success).toBe(true);
    expect(subLayer(writtenLayout(writer), 'Main', 'EFFECTS').name).toBe('EFFECTS');
  });

  it('picks one of two layers with the same name by its sub-layer path, so it can be renamed', async () => {
    const layout = nestedLayout();
    subLayer(layout, 'Main', 'Effects').name = 'Backdrop';
    const { server, writer } = setup(projectData({ layouts: new Map([['Layout1', layout]]) }));
    const ambiguous = await server.callTool('update_layer', { layoutName: 'Layout1', layerName: 'Backdrop', newName: 'Glow' });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.content[0].text).toContain('Give a sub-layer by its path to pick it (e.g. "Main > Backdrop")');

    const renamed = parseResult(await server.callTool('update_layer', { layoutName: 'Layout1', layerName: 'Main > Backdrop', newName: 'Glow' }));
    expect(renamed.success).toBe(true);
    const written = writtenLayout(writer);
    expect(subLayer(written, 'Main').subLayers.map((l: Json) => l.name)).toEqual(['HUD', 'Glow']);
    expect(written.layers.map((l: Json) => l.name)).toEqual(['Backdrop', 'Main']);
  });

  it('says two top-level layers with the same name need a fix in the layout file', async () => {
    const layout = nestedLayout();
    layout.layers.push(layer('Backdrop', 306));
    const { server } = setup(projectData({ layouts: new Map([['Layout1', layout]]) }));
    const result = await server.callTool('delete_layer', { layoutName: 'Layout1', layerName: 'Backdrop' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('rename all but one of them in the layout file');
  });

  it('update_layer changes a sub-layer and refuses renaming a layer to a name used anywhere in the tree', async () => {
    const { server, writer } = setup();
    const renamed = await server.callTool('update_layer', { layoutName: 'Layout1', layerName: 'Backdrop', newName: 'HUD' });
    expect(renamed.isError).toBe(true);
    expect(renamed.content[0].text).toContain('sub-layer "Main > HUD"');

    const updated = parseResult(await server.callTool('update_layer', {
      layoutName: 'Layout1', layerName: 'Buttons', newName: 'Controls', isInitiallyVisible: false,
    }));
    expect(updated.success).toBe(true);
    const controls = subLayer(writtenLayout(writer), 'Main', 'HUD', 'Controls');
    expect(controls.isInitiallyVisible).toBe(false);
    expect(controls.instances).toHaveLength(1);
  });

  it('delete_layer counts the instances of sub-layers and deletes a layer with its sub-layers only with force', async () => {
    const { server, writer } = setup();
    const blocked = parseResult(await server.callTool('delete_layer', { layoutName: 'Layout1', layerName: 'Main' }));
    expect(blocked.action).toBe('delete_blocked');
    expect(blocked.instanceCount).toBe(3);
    expect(blocked.subLayerCount).toBe(3);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);

    const forced = parseResult(await server.callTool('delete_layer', { layoutName: 'Layout1', layerName: 'Main', force: true }));
    expect(forced.success).toBe(true);
    expect(forced.warnings.join(' ')).toContain('3 sub-layer(s)');
    expect(writtenLayout(writer).layers.map((l: Json) => l.name)).toEqual(['Backdrop']);
  });

  it('delete_layer deletes an empty sub-layer and keeps the last top-level layer', async () => {
    const { server, writer } = setup();
    const data = parseResult(await server.callTool('delete_layer', { layoutName: 'Layout1', layerName: 'Effects' }));
    expect(data.success).toBe(true);
    expect(subLayer(writtenLayout(writer), 'Main').subLayers.map((l: Json) => l.name)).toEqual(['HUD']);

    const single = { name: 'Layout2', sid: 400, layers: [layer('Only', 401, [], [layer('Child', 402)])] };
    const { server: server2 } = setup(projectData({ layouts: new Map([['Layout2', single]]) }));
    const last = await server2.callTool('delete_layer', { layoutName: 'Layout2', layerName: 'Only' });
    expect(last.isError).toBe(true);
    expect(last.content[0].text).toContain('last layer');
    // Its only sub-layer can go: the layout keeps its top-level layer
    const child = parseResult(await server2.callTool('delete_layer', { layoutName: 'Layout2', layerName: 'Child' }));
    expect(child.success).toBe(true);
  });

  it('delete_instance_from_layout and update_instance find instances on nested sub-layers', async () => {
    const { server, writer } = setup();
    const updated = parseResult(await server.callTool('update_instance', { layoutName: 'Layout1', uid: 9, x: 42, locked: true }));
    expect(updated.success).toBe(true);
    const button = subLayer(writtenLayout(writer), 'Main', 'HUD', 'Buttons').instances[0];
    expect(button.world.x).toBe(42);
    expect(button.locked).toBe(true);

    const deleted = parseResult(await server.callTool('delete_instance_from_layout', { layoutName: 'Layout1', uid: 3 }));
    expect(deleted.success).toBe(true);
    expect(deleted.warnings[0]).toContain('from sub-layer "Main > HUD"');
    expect(subLayer(writtenLayout(writer), 'Main', 'HUD').instances).toEqual([]);
  });
});

describe('update_object_properties on sub-layer instances', () => {
  it('adds the behaviors and instanceVariables dicts to instances on nested sub-layers', async () => {
    const layout = nestedLayout();
    const button = subLayer(layout, 'Main', 'HUD', 'Buttons').instances[0];
    delete button.behaviors;
    delete button.instanceVariables;
    const { server, writer } = setup(projectData({ layouts: new Map([['Layout1', layout]]) }));
    const data = parseResult(await server.callTool('update_object_properties', {
      name: 'Sprite3', addVariables: [{ name: 'hp', type: 'number' }],
    }));
    expect(data.warnings).toContain('Updated instances in layout(s): Layout1');
    const synced = subLayer(writtenLayout(writer), 'Main', 'HUD', 'Buttons').instances[0];
    expect(synced.behaviors).toEqual({});
    expect(synced.instanceVariables).toEqual({});
  });
});

describe('delete_object reference check', () => {
  beforeEach(() => resetProjectIndex());

  /** Sprite1..Sprite5 used in events in every way the index knows */
  function eventUses(): Json {
    return {
      eventSheets: new Map([['Sheet1', {
        name: 'Sheet1', sid: 200,
        events: [
          {
            eventType: 'block', sid: 201,
            conditions: [{ id: 'is-visible', objectClass: 'Sprite1', sid: 202 }],
            actions: [
              { id: 'spawn-another-object', objectClass: 'Sprite1', sid: 203, parameters: { object: 'Sprite5', layer: '0', 'image-point': '0' } },
              { id: 'set-x', objectClass: 'Sprite1', sid: 204, parameters: { x: 'Sprite5.X + 1' } },
              { type: 'script', language: 'javascript', script: ['runtime.objects.Sprite5.getFirstInstance();'] },
            ],
          },
          { eventType: 'script', language: 'javascript', script: ['runtime.objects["Sprite5"];'] },
        ],
      }]]),
    };
  }

  it('refuses an object whose only instance is on a nested sub-layer and says where it is', async () => {
    const { server, writer } = setup();
    const data = parseResult(await server.callTool('delete_object', { name: 'Sprite3' }));
    expect(data.action).toBe('delete_blocked');
    expect(data.references.layouts).toEqual(['Layout1']);
    expect(data.references.instances).toEqual([{ layout: 'Layout1', layer: 'Main > HUD > Buttons', instances: 1 }]);
    expect(data.message).toContain('1 instance(s) in layout "Layout1" (layer "Main > HUD > Buttons")');
    expect(writer.callsFor('deleteEntityFile')).toHaveLength(0);
  });

  it('lists every event use with its kind: object parameter, expression and script', async () => {
    const { server } = setup(projectData(eventUses()));
    const data = parseResult(await server.callTool('delete_object', { name: 'Sprite5' }));
    expect(data.action).toBe('delete_blocked');
    expect(data.references.eventSheets).toEqual(['Sheet1']);
    expect(data.references.events.map((e: Json) => e.context)).toEqual(['parameter', 'expression', 'script', 'script']);
    expect(data.references.events[0]).toEqual({ eventSheet: 'Sheet1', path: 'block > action:0', context: 'parameter' });
    expect(data.message).toContain('used 4 time(s) in events of "Sheet1" (1 object parameter, 1 expression, 2 script)');
  });

  it('refuses an object that has a custom action block or is used only inside one', async () => {
    const { server } = setup(projectData({
      eventSheets: new Map([['Sheet1', {
        name: 'Sheet1', sid: 200,
        events: [{
          eventType: 'custom-ace-block', aceType: 'action', aceName: 'Jump', objectClass: 'Sprite4', sid: 201,
          functionParameters: [], conditions: [],
          actions: [{ id: 'destroy', objectClass: 'Sprite5', sid: 202 }],
          children: [{ eventType: 'block', sid: 203, conditions: [], actions: [{ id: 'set-x', objectClass: 'Sprite1', sid: 204, parameters: { x: 'Sprite6.X' } }] }],
        }],
      }]]),
    }));
    const orphans = parseResult(await server.callTool('find_orphaned_objects', {})).orphanedObjects.map((o: Json) => o.name);
    expect(orphans).not.toContain('Sprite4');
    expect(orphans).not.toContain('Sprite5');
    expect(orphans).not.toContain('Sprite6'); // expression in a sub-event of the custom action
    const owner = parseResult(await server.callTool('delete_object', { name: 'Sprite4' }));
    expect(owner.action).toBe('delete_blocked');
    expect(owner.references.events).toEqual([{ eventSheet: 'Sheet1', path: 'custom-action:Sprite4.Jump', context: 'custom-action' }]);
    expect(owner.message).toContain('1 custom action definition');
    const inside = parseResult(await server.callTool('delete_object', { name: 'Sprite5' }));
    expect(inside.references.events[0].path).toBe('custom-action:Sprite4.Jump > action:0');
  });

  it('bounds the listed event uses and says how many are left out', async () => {
    const actions = Array.from({ length: 60 }, (_, i) => ({ id: 'set-x', objectClass: 'Sprite4', sid: 1000 + i, parameters: { x: '1' } }));
    const { server } = setup(projectData({
      eventSheets: new Map([['Sheet1', { name: 'Sheet1', sid: 200, events: [{ eventType: 'block', sid: 201, conditions: [], actions }] }]]),
    }));
    const data = parseResult(await server.callTool('delete_object', { name: 'Sprite4' }));
    expect(data.references.events).toHaveLength(50);
    expect(data.references.eventsNotListed).toBe(10);
  });

  it('refuses an object whose SID another instance holds in an object property', async () => {
    const layout = nestedLayout();
    subLayer(layout, 'Backdrop').instances[0].properties = { object: 104 };
    const { server } = setup(projectData({ layouts: new Map([['Layout1', layout]]) }));
    const data = parseResult(await server.callTool('delete_object', { name: 'Sprite4' }));
    expect(data.action).toBe('delete_blocked');
    expect(data.references.instanceProperties).toEqual([
      { layout: 'Layout1', layer: 'Backdrop', objectType: 'Sprite1', uid: 1, property: 'object' },
    ]);
    expect(data.message).toContain('named by the object property "object" of "Sprite1" UID 1 in layout "Layout1"');
    expect(data.message).not.toMatch(/property property/);
  });

  it('names every instance whose object property holds the SID, in the plural', async () => {
    const layout = nestedLayout();
    subLayer(layout, 'Backdrop').instances[0].properties = { object: 104 };
    subLayer(layout, 'Backdrop').instances.push(inst('Sprite1', 5, 316, { properties: { object: 104 } }));
    const { server } = setup(projectData({ layouts: new Map([['Layout1', layout]]) }));
    const data = parseResult(await server.callTool('delete_object', { name: 'Sprite4' }));
    expect(data.action).toBe('delete_blocked');
    expect(data.references.instanceProperties).toHaveLength(2);
    expect(data.message).toContain('named by the object properties "object" of "Sprite1" UID 1 in layout "Layout1", ' +
      '"object" of "Sprite1" UID 5 in layout "Layout1"');
    expect(data.message).not.toMatch(/property property|properties property/);
  });

  it('refuses a member of a family, even one no event uses', async () => {
    const { server } = setup(projectData({
      families: new Map([['Family1', { name: 'Family1', 'plugin-id': 'Sprite', sid: 120, members: ['Sprite4'] }]]),
    }));
    const data = parseResult(await server.callTool('delete_object', { name: 'Sprite4' }));
    expect(data.action).toBe('delete_blocked');
    expect(data.references.families).toEqual(['Family1']);
    expect(data.message).toContain('member of family "Family1"');
  });

  it('with force deletes the object and names what still refers to it', async () => {
    const { server, writer } = setup();
    const data = parseResult(await server.callTool('delete_object', { name: 'Sprite3', force: true }));
    expect(data.action).toBe('deleted');
    expect(data.warnings[0]).toContain('still referenced: 1 instance(s) in layout "Layout1" (layer "Main > HUD > Buttons")');
    expect(data.warnings).toHaveLength(1);
    expect(writer.callsFor('deleteEntityFile')).toHaveLength(1);
  });

  it('with force warns that validate_project will not report the uses in expressions and scripts', async () => {
    const { server } = setup(projectData(eventUses()));
    const data = parseResult(await server.callTool('delete_object', { name: 'Sprite5', force: true }));
    expect(data.action).toBe('deleted');
    expect(data.warnings[1]).toContain('validate_project will not report its 3 use(s) in expressions and scripts');
    expect(data.warnings[1]).toContain('"Sheet1" block > action:1');
  });

  it('refuses an object named only inside an expression in an object parameter', async () => {
    const { server, writer } = setup(projectData({
      eventSheets: new Map([['Sheet1', {
        name: 'Sheet1', sid: 200,
        events: [{ eventType: 'block', sid: 201, conditions: [], actions: [
          { id: 'spawn-another-object', objectClass: 'Sprite1', sid: 202, parameters: { object: 'Sprite4.X', layer: '0' } },
        ] }],
      }]]),
    }));
    const data = parseResult(await server.callTool('delete_object', { name: 'Sprite4' }));
    expect(data.action).toBe('delete_blocked');
    expect(data.references.events).toEqual([{ eventSheet: 'Sheet1', path: 'block > action:0', context: 'expression' }]);
    expect(writer.callsFor('deleteEntityFile')).toHaveLength(0);
  });

  it('get_object_dependencies lists orphans that are family members with their families', async () => {
    const { server } = setup(projectData({
      families: new Map([['Family1', { name: 'Family1', 'plugin-id': 'Sprite', sid: 120, members: ['Sprite4'] }]]),
    }));
    const deps = parseResult(await server.callTool('get_object_dependencies', {}));
    expect(deps.projectWide.orphanedObjects).toEqual(['Sprite4', 'Sprite5']);
    expect(deps.projectWide.orphanedFamilyMembers).toEqual([{ name: 'Sprite4', families: ['Family1'] }]);
  });

  it('agrees with find_orphaned_objects: orphans are deleted, used objects are refused', async () => {
    const layout = nestedLayout();
    subLayer(layout, 'Backdrop').instances.push(inst('Sprite1', 5, 316, { properties: { object: 104 } }));
    const data = projectData({ ...eventUses(), layouts: new Map([['Layout1', layout]]) });
    data.objects.set('Sprite6', { name: 'Sprite6', 'plugin-id': 'Sprite', sid: 106 });
    data.objects.set('Sprite7', { name: 'Sprite7', 'plugin-id': 'Sprite', sid: 107 });
    const { server } = setup(data);
    const orphans = parseResult(await server.callTool('find_orphaned_objects', {})).orphanedObjects.map((o: Json) => o.name);
    expect(orphans).toEqual(['Sprite6', 'Sprite7']);
    for (const name of data.objects.keys() as Iterable<string>) {
      resetProjectIndex();
      const result = parseResult(await server.callTool('delete_object', { name }));
      expect(result.action, name).toBe(orphans.includes(name) ? 'deleted' : 'delete_blocked');
    }
  });
});
