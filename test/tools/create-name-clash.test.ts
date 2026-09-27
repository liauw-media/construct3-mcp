/**
 * Create and rename tools refuse names that differ from an existing one only
 * in case, and create tools never replace a file that is already on disk
 * (issue #29). Runs the real reader and writer on a copy of the minimal
 * fixture (event sheet MainSheet, layout "Layout 1", Sprite object "Sprite"
 * with "Animation 1"). A refused call must leave every file byte-identical.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, cp, readFile, readdir, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join, relative, sep } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { registerEventTools } from '../../src/tools/event-tools.js';
import { registerLayoutTools } from '../../src/tools/layout-tools.js';
import { registerObjectTools } from '../../src/tools/object-tools.js';
import { registerAnimationTools } from '../../src/tools/animation-tools.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

let dir: string;
let server: MockServer;
let reader: Construct3ProjectReader;
let writer: Construct3ProjectWriter;

/** Every file in the project folder, by project-relative path. */
async function snapshot(): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const walk = async (d: string) => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const path = join(d, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files.set(relative(dir, path).split(sep).join('/'), await readFile(path, 'utf-8'));
    }
  };
  await walk(dir);
  return files;
}

async function expectRefused(tool: string, args: Record<string, unknown>, message: RegExp | string): Promise<void> {
  const before = await snapshot();
  const result = await server.callTool(tool, args);
  expect(result.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
  if (typeof message === 'string') expect(result.content[0].text).toContain(message);
  else expect(result.content[0].text).toMatch(message);
  expect(await snapshot()).toEqual(before);
}

async function expectCreated(tool: string, args: Record<string, unknown>): Promise<void> {
  const result = await server.callTool(tool, args);
  expect(result.isError, `${tool} ${JSON.stringify(args)}: ${result.content[0].text}`).toBeUndefined();
}

async function c3proj(): Promise<Record<string, any>> {
  return JSON.parse(await readFile(join(dir, 'project.c3proj'), 'utf-8'));
}

/** Read a project JSON file, change it, and write it back. */
async function editJson(relPath: string, change: (data: Record<string, any>) => void): Promise<void> {
  const path = join(dir, ...relPath.split('/'));
  const data = JSON.parse(await readFile(path, 'utf-8'));
  change(data);
  await writeFile(path, JSON.stringify(data, null, '\t'), 'utf-8');
}

async function readJson(relPath: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(join(dir, ...relPath.split('/')), 'utf-8'));
}

function layerNamesOf(layers: Array<Record<string, any>>): string[] {
  return layers.flatMap(l => [l.name, ...layerNamesOf(l.subLayers ?? [])]);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'c3-name-clash-'));
  await cp(FIXTURE_DIR, dir, { recursive: true });
  reader = new Construct3ProjectReader(join(dir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  writer = new Construct3ProjectWriter(reader, idGen);
  server = new MockServer();
  const deps = { server, reader, writer, idGen } as never;
  registerEventTools(deps);
  registerLayoutTools(deps);
  registerObjectTools(deps);
  registerAnimationTools(deps);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('create tools refuse names that differ only in case', () => {
  it('create_event_sheet refuses a case variant of an existing sheet, in any folder', async () => {
    await expectRefused('create_event_sheet', { name: 'mainsheet' }, 'the existing event sheet "MainSheet"');
    await expectRefused('create_event_sheet', { name: 'MAINSHEET', subfolder: 'Sub' }, '"MainSheet"');
    expect((await c3proj()).eventSheets).toEqual({ items: ['MainSheet'], subfolders: [] });
  });

  it('create_layout refuses a case variant of an existing layout, also of one in a project-bar folder', async () => {
    await expectRefused('create_layout', { name: 'layout 1' }, 'the existing layout "Layout 1"');

    await writer.addToProject('layouts', 'Level2', 'Stages');
    await mkdir(join(dir, 'layouts', 'Stages'));
    await writeFile(join(dir, 'layouts', 'Stages', 'Level2.json'), JSON.stringify({ name: 'Level2', layers: [] }), 'utf-8');
    await expectRefused('create_layout', { name: 'LEVEL2' }, '"Level2"');
  });

  it('refuses a project-bar folder that differs from an existing one only in case', async () => {
    await expectCreated('create_event_sheet', { name: 'Hud', subfolder: 'Panels/Menus' });
    await expectRefused('create_event_sheet', { name: 'Pause', subfolder: 'panels/Menus' }, 'Use subfolder "Panels/Menus"');
    await expectRefused('create_event_sheet', { name: 'Pause', subfolder: 'Panels/menus/Extra' }, 'Use subfolder "Panels/Menus/Extra"');
    await expectCreated('create_event_sheet', { name: 'Pause', subfolder: 'Panels/Menus' });
    const sheets = (await c3proj()).eventSheets;
    expect(sheets.subfolders).toHaveLength(1);
    expect(sheets.subfolders[0].subfolders[0]).toEqual({ items: ['Hud', 'Pause'], subfolders: [], name: 'Menus' });

    await expectCreated('create_object', { name: 'Coin', pluginId: 'Sprite', subfolder: 'Pickups' });
    await expectRefused('create_object', { name: 'Gem', pluginId: 'Sprite', subfolder: 'PICKUPS' }, '"Pickups"');

    await expectCreated('create_family', { name: 'Foes', pluginId: 'Sprite', subfolder: 'Groups' });
    await expectRefused('create_family', { name: 'Allies', pluginId: 'Sprite', subfolder: 'groups' }, '"Groups"');
  });

  it('still creates new names', async () => {
    await expectCreated('create_event_sheet', { name: 'Sheet3' });
    await expectCreated('create_layout', { name: 'Layout 2' });
    expect((await readdir(join(dir, 'layouts'))).sort()).toEqual(['Layout 1.json', 'Layout 2.json']);
    expect((await c3proj()).eventSheets.items).toEqual(['MainSheet', 'Sheet3']);
  });
});

describe('create tools never replace a file already on disk', () => {
  beforeEach(async () => {
    // Files that are not registered in project.c3proj
    await writeFile(join(dir, 'eventSheets', 'Orphan.json'), '{"name":"Orphan","events":[],"marker":1}', 'utf-8');
    await writeFile(join(dir, 'layouts', 'Stray.json'), '{"name":"Stray","layers":[],"marker":2}', 'utf-8');
    await writeFile(join(dir, 'objectTypes', 'Loose.json'), '{"name":"Loose","plugin-id":"Sprite","marker":3}', 'utf-8');
    await mkdir(join(dir, 'families'));
    await writeFile(join(dir, 'families', 'Old.json'), '{"name":"Old","members":[],"marker":4}', 'utf-8');
  });

  it('refuses the same name and names that differ only in case, on any file system', async () => {
    await expectRefused('create_event_sheet', { name: 'Orphan' }, 'eventSheets/Orphan.json already exists');
    await expectRefused('create_event_sheet', { name: 'orphan' }, 'eventSheets/Orphan.json already exists');
    await expectRefused('create_layout', { name: 'STRAY' }, 'layouts/Stray.json already exists');
    await expectRefused('create_family', { name: 'old', pluginId: 'Sprite' }, 'families/Old.json already exists');
  });

  it('create_object refuses before registering addons or writing placeholder images', async () => {
    await expectRefused('create_object', { name: 'loose', pluginId: 'Sprite' }, 'objectTypes/Loose.json already exists');
    await expectRefused('create_object', { name: 'Loose', pluginId: 'TiledBg' }, 'objectTypes/Loose.json already exists');
  });

  it('says what to do next and returns the refusal as a plain tool error, without logging a failure', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const [tool, args] of [
        ['create_object', { name: 'LOOSE', pluginId: 'Text' }],
        ['create_family', { name: 'OLD', pluginId: 'Sprite' }],
        ['create_event_sheet', { name: 'ORPHAN' }],
        ['create_layout', { name: 'stray' }],
      ] as const) {
        const result = await server.callTool(tool, args);
        expect(result.isError, tool).toBe(true);
        const text = result.content[0].text;
        expect(text, tool).toMatch(/^Refusing to create /);
        expect(text, tool).toContain('Choose another name, or, if the file is a leftover of a deleted entity, check it and remove it first.');
      }
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });
});

describe('layer tools refuse names that differ only in case', () => {
  // "Layout 1" has one layer, "Main"; give it a second layer with a sub-layer
  beforeEach(async () => {
    await editJson('layouts/Layout 1.json', layout => {
      layout.layers.push({
        name: 'Back', sid: 500000000000001, instances: [],
        subLayers: [{ name: 'Shade', sid: 500000000000002, instances: [], subLayers: [] }],
      });
    });
  });

  it('add_layer refuses a name used by a layer or a sub-layer, exactly or ignoring case', async () => {
    await expectRefused('add_layer', { layoutName: 'Layout 1', layerName: 'MAIN' }, 'the existing layer "Main"');
    await expectRefused('add_layer', { layoutName: 'Layout 1', layerName: 'shade' }, 'the existing layer "Shade"');
    await expectRefused('add_layer', { layoutName: 'Layout 1', layerName: 'Shade' }, 'Layer "Shade" already exists in layout "Layout 1"');
    await expectCreated('add_layer', { layoutName: 'Layout 1', layerName: 'Front' });
    expect(layerNamesOf((await readJson('layouts/Layout 1.json')).layers)).toEqual(['Main', 'Back', 'Shade', 'Front']);
  });

  it('update_layer refuses another layer\'s name ignoring case, but can change the case of its own name', async () => {
    await expectRefused('update_layer', { layoutName: 'Layout 1', layerName: 'Back', newName: 'main' }, 'the existing layer "Main"');
    await expectRefused('update_layer', { layoutName: 'Layout 1', layerName: 'Main', newName: 'SHADE' }, 'the existing layer "Shade"');
    await expectCreated('update_layer', { layoutName: 'Layout 1', layerName: 'Back', newName: 'BACK' });
    expect(layerNamesOf((await readJson('layouts/Layout 1.json')).layers)).toEqual(['Main', 'BACK', 'Shade']);
  });

  it('create_layout refuses layers that differ from each other only in case', async () => {
    await expectRefused('create_layout', { name: 'Level', layers: ['Top', 'Middle', 'TOP'] }, '"TOP" differs only in case from the existing layer "Top"');
    await expectRefused('create_layout', { name: 'Level', layers: ['Top', 'Top'] }, 'Layer "Top" already exists in layout "Level"');
    await expectCreated('create_layout', { name: 'Level', layers: ['Top', 'Middle'] });
  });
});

describe('update_event_variable refuses names that differ only in case', () => {
  beforeEach(async () => {
    await editJson('eventSheets/MainSheet.json', sheet => {
      sheet.events.unshift(
        { eventType: 'variable', name: 'Score', type: 'number', initialValue: '0', comment: '', isStatic: false, isConstant: false, sid: 600000000000001 },
        {
          eventType: 'group', title: 'Rules', description: '', isActiveOnStart: true, sid: 600000000000002,
          children: [
            { eventType: 'variable', name: 'Lives', type: 'number', initialValue: '3', comment: '', isStatic: false, isConstant: false, sid: 600000000000003 },
          ],
        },
      );
    });
  });

  it('refuses another variable\'s name ignoring case (also one nested in a group), but can change the case of its own name', async () => {
    await expectRefused('update_event_variable', { sheetName: 'MainSheet', sid: 600000000000001, newName: 'LIVES' }, 'the existing event variable "Lives"');
    await expectRefused('update_event_variable', { sheetName: 'MainSheet', sid: 600000000000003, newName: 'score' }, 'the existing event variable "Score"');
    await expectRefused('update_event_variable', { sheetName: 'MainSheet', sid: 600000000000003, newName: 'Score' }, 'A variable named "Score" already exists');
    await expectCreated('update_event_variable', { sheetName: 'MainSheet', sid: 600000000000001, newName: 'SCORE' });
    expect((await readJson('eventSheets/MainSheet.json')).events[0].name).toBe('SCORE');
  });
});

describe('event variable names follow the editor\'s scope rules', () => {
  const variable = (name: string, sid: number) =>
    ({ eventType: 'variable', name, type: 'number', initialValue: '0', comment: '', isStatic: false, isConstant: false, sid });

  // MainSheet: global Score; group Combat with local Damage and a block with local Bonus;
  // group Lobby with local Choice; function AddPoints(Portion) with local Tally.
  // Rules (second sheet): global Stage, local Countdown in a block, function Restart(Delay).
  beforeEach(async () => {
    await editJson('eventSheets/MainSheet.json', sheet => {
      sheet.events.unshift(
        variable('Score', 700000000000001),
        {
          eventType: 'group', title: 'Combat', description: '', isActiveOnStart: true, sid: 700000000000002,
          children: [
            variable('Damage', 700000000000003),
            { eventType: 'block', conditions: [], actions: [], sid: 700000000000004, children: [variable('Bonus', 700000000000005)] },
          ],
        },
        {
          eventType: 'group', title: 'Lobby', description: '', isActiveOnStart: true, sid: 700000000000006,
          children: [variable('Choice', 700000000000007)],
        },
        {
          eventType: 'function-block', functionName: 'AddPoints', functionDescription: '', functionCategory: '',
          functionReturnType: 'none', functionCopyPicked: false, functionIsAsync: false,
          functionParameters: [{ name: 'Portion', type: 'number', initialValue: '0', comment: '', sid: 700000000000009 }],
          conditions: [], actions: [], sid: 700000000000008,
          children: [variable('Tally', 700000000000010)],
        },
      );
    });
    await writer.addToProject('eventSheets', 'Rules');
    await writeFile(join(dir, 'eventSheets', 'Rules.json'), JSON.stringify({
      name: 'Rules',
      events: [
        variable('Stage', 700000000000011),
        { eventType: 'block', conditions: [], actions: [], sid: 700000000000012, children: [variable('Countdown', 700000000000013)] },
        {
          eventType: 'function-block', functionName: 'Restart', functionDescription: '', functionCategory: '',
          functionReturnType: 'none', functionCopyPicked: false, functionIsAsync: false,
          functionParameters: [{ name: 'Delay', type: 'number', initialValue: '0', comment: '', sid: 700000000000015 }],
          conditions: [], actions: [], sid: 700000000000014, children: [],
        },
      ],
      sid: 700000000000016,
    }, null, '\t'), 'utf-8');
  });

  const addVariable = (variableName: string) =>
    ({ sheetName: 'MainSheet', eventType: 'variable', variableName, variableType: 'number' });

  it('add_event_to_sheet refuses a global variable name used by any variable or function parameter in the project', async () => {
    await expectRefused('add_event_to_sheet', addVariable('Stage'), 'A variable named "Stage" already exists in sheet "Rules"');
    await expectRefused('add_event_to_sheet', addVariable('STAGE'), 'Sheet "Rules": "STAGE" differs only in case from the existing event variable "Stage"');
    await expectRefused('add_event_to_sheet', addVariable('countdown'), 'the existing event variable "Countdown"');
    await expectRefused('add_event_to_sheet', addVariable('delay'), 'the existing function parameter "Delay"');
    await expectRefused('add_event_to_sheet', addVariable('Delay'), 'A function parameter named "Delay" already exists in sheet "Rules"');
    await expectRefused('add_event_to_sheet', addVariable('bonus'), 'Sheet "MainSheet": "bonus" differs only in case');
    await expectRefused('add_event_to_sheet', addVariable('Score'), 'every event variable and function parameter in the project');
  });

  it('add_event_to_sheet refuses System expression names and names the editor cleans up', async () => {
    await expectRefused('add_event_to_sheet', addVariable('Time'), 'System expression "time" (ignoring case)');
    await expectRefused('add_event_to_sheet', addVariable('random'), 'System expression "random". ');
    for (const name of ['my score', 'hp-max', 'a.b', 'x:y', '_hidden', '42']) {
      await expectRefused('add_event_to_sheet', addVariable(name), `"${name}" is not a valid event variable name`);
    }
    await expectRefused('add_event_to_sheet', addVariable('a\u3002b'),
      'it contains "\u3002" (U+3002). Construct 3 does not accept whitespace, the characters');
    // Full-width forms other than those the editor removes are accepted, as in the editor
    await expectCreated('add_event_to_sheet', addVariable('a\uFF0Fb'));
  });

  it('add_event_to_sheet still adds a free name, also one used by an object', async () => {
    await expectCreated('add_event_to_sheet', addVariable('Coins'));
    await expectCreated('add_event_to_sheet', addVariable('Sprite'));
    const events = (await readJson('eventSheets/MainSheet.json')).events;
    expect(events.slice(-2).map((e: { name: string }) => e.name)).toEqual(['Coins', 'Sprite']);
    await expectRefused('add_event_to_sheet', addVariable('coins'), 'the existing event variable "Coins"');
  });

  it('update_event_variable checks a local variable against its own scope only', async () => {
    // Sibling group and other sheets' locals are out of scope
    await expectCreated('update_event_variable', { sheetName: 'MainSheet', sid: 700000000000007, newName: 'Damage' });
    await expectCreated('update_event_variable', { sheetName: 'MainSheet', sid: 700000000000007, newName: 'Countdown' });
    // Globals of any sheet, enclosing events and everything below the parent event are in scope
    await expectRefused('update_event_variable', { sheetName: 'MainSheet', sid: 700000000000007, newName: 'stage' }, 'the existing event variable "Stage"');
    await expectRefused('update_event_variable', { sheetName: 'MainSheet', sid: 700000000000010, newName: 'portion' }, 'the existing function parameter "Portion"');
    await expectRefused('update_event_variable', { sheetName: 'MainSheet', sid: 700000000000003, newName: 'BONUS' }, 'the existing event variable "Bonus"');
    await expectRefused('update_event_variable', { sheetName: 'MainSheet', sid: 700000000000005, newName: 'damage' }, 'the variables and function parameters of the events enclosing it');
    await expectRefused('update_event_variable', { sheetName: 'MainSheet', sid: 700000000000005, newName: 'LayoutWidth' }, 'System expression "LayoutWidth"');
    await expectRefused('update_event_variable', { sheetName: 'MainSheet', sid: 700000000000005, newName: 'max hp' }, 'it contains whitespace');
  });

  it('update_event_variable checks a global variable against the whole project', async () => {
    await expectRefused('update_event_variable', { sheetName: 'MainSheet', sid: 700000000000001, newName: 'choice' }, 'the existing event variable "Choice"');
    await expectRefused('update_event_variable', { sheetName: 'Rules', sid: 700000000000011, newName: 'Tally' }, 'A variable named "Tally" already exists in sheet "MainSheet"');
    await expectCreated('update_event_variable', { sheetName: 'MainSheet', sid: 700000000000001, newName: 'SCORE' });
    await expectCreated('update_event_variable', { sheetName: 'Rules', sid: 700000000000011, newName: 'Wave' });
    expect((await readJson('eventSheets/Rules.json')).events[0].name).toBe('Wave');
  });

  const addFunction = (functionName: string, ...paramNames: string[]) => ({
    sheetName: 'MainSheet', eventType: 'function', functionName,
    functionParams: paramNames.map(name => ({ name, type: 'number' })),
  });

  it('add_event_to_sheet refuses a function parameter named like a global variable of any sheet', async () => {
    await expectRefused('add_event_to_sheet', addFunction('Fn', 'Stage'), 'A variable named "Stage" already exists in sheet "Rules"');
    await expectRefused('add_event_to_sheet', addFunction('Fn', 'Quantity', 'stage'),
      'Sheet "Rules": "stage" differs only in case from the existing event variable "Stage"');
    await expectRefused('add_event_to_sheet', addFunction('Fn', 'SCORE'), 'a function parameter name to differ, ignoring case, from every global variable');
  });

  it('add_event_to_sheet refuses parameters of one function whose names match ignoring case', async () => {
    await expectRefused('add_event_to_sheet', addFunction('Fn', 'pq', 'Quantity', 'PQ'),
      'functionParams lists "pq" and "PQ", which differ only in case');
    await expectRefused('add_event_to_sheet', addFunction('Fn', 'Quantity', 'Quantity'), 'functionParams lists "Quantity" more than once');
  });

  it('add_event_to_sheet refuses parameter names that are System expressions or that the editor cleans up', async () => {
    await expectRefused('add_event_to_sheet', addFunction('Fn', 'time'), '"time" is the name of the System expression "time". Construct 3 does not accept a function parameter');
    await expectRefused('add_event_to_sheet', addFunction('Fn', 'Quantity', 'Random'), 'System expression "random" (ignoring case)');
    await expectRefused('add_event_to_sheet', addFunction('Fn', 'a b'), '"a b" is not a valid function parameter name: it contains whitespace');
    await expectRefused('add_event_to_sheet', addFunction('Fn', 'a-b'), 'it contains "-"');
    await expectRefused('add_event_to_sheet', addFunction('Fn', 'hexcolor'),
      'Newer Construct 3 releases such as r495.2 have this System expression (r449 does not have it)');
  });

  it('add_event_to_sheet adds parameters named like parameters of other functions or locals elsewhere', async () => {
    // Delay and Portion are parameters of other functions; Damage, Countdown and Tally are locals in other scopes
    await expectCreated('add_event_to_sheet', addFunction('Fn', 'Delay', 'Portion', 'Damage', 'Countdown', 'Tally'));
    await expectCreated('add_event_to_sheet', addFunction('Other', 'Delay', 'Quantity'));
    const functions = (await readJson('eventSheets/MainSheet.json')).events
      .filter((e: { functionName?: string }) => e.functionName === 'Fn' || e.functionName === 'Other');
    expect(functions.map((f: { functionParameters: Array<{ name: string }> }) => f.functionParameters.map(p => p.name)))
      .toEqual([['Delay', 'Portion', 'Damage', 'Countdown', 'Tally'], ['Delay', 'Quantity']]);
    // The parameters now count for a new global variable
    await expectRefused('add_event_to_sheet', addVariable('quantity'), 'the existing function parameter "Quantity"');
  });

  it('checks names against sheets saved since the last read, not a cached copy', async () => {
    await reader.readAllEventSheets(); // fills the reader's cache
    await editJson('eventSheets/Rules.json', sheet => { sheet.events.push(variable('Beta', 700000000000017)); });
    await expectRefused('add_event_to_sheet', addVariable('Beta'), 'A variable named "Beta" already exists in sheet "Rules"');
    await expectRefused('add_event_to_sheet', addFunction('Fn', 'beta'), 'the existing event variable "Beta"');
    await expectRefused('update_event_variable', { sheetName: 'MainSheet', sid: 700000000000001, newName: 'BETA' }, 'the existing event variable "Beta"');
  });

  it('move_events_between_sheets refuses a copy of a global variable and still moves it', async () => {
    const copyScore = { sourceSheet: 'MainSheet', targetSheet: 'Rules', sids: [700000000000001] };
    await expectRefused('move_events_between_sheets', copyScore,
      'the global variable "Score" has the same name as the event variable "Score" in sheet "MainSheet"');
    await expectRefused('move_events_between_sheets', copyScore, 'move a global variable to the other sheet (deleteSource: true) instead of copying it');
    await expectCreated('move_events_between_sheets', { ...copyScore, deleteSource: true });
    expect((await readJson('eventSheets/Rules.json')).events.at(-1).name).toBe('Score');
    expect((await readJson('eventSheets/MainSheet.json')).events.some((e: { name?: string }) => e.name === 'Score')).toBe(false);
  });

  it('move_events_between_sheets copies a function or a group with locals to another sheet', async () => {
    await expectCreated('move_events_between_sheets', { sourceSheet: 'MainSheet', targetSheet: 'Rules', sids: [700000000000008, 700000000000002] });
    const titles = (await readJson('eventSheets/Rules.json')).events.map((e: { functionName?: string; title?: string }) => e.functionName ?? e.title);
    expect(titles.slice(-2)).toEqual(['AddPoints', 'Combat']);
  });

  it('move_events_between_sheets refuses moving a local into a group whose variables clash with it', async () => {
    await editJson('eventSheets/Rules.json', sheet => {
      sheet.events.push({
        eventType: 'group', title: 'Setup', description: '', isActiveOnStart: true, sid: 700000000000018,
        children: [variable('choice', 700000000000019)],
      });
    });
    await expectRefused('move_events_between_sheets',
      { sourceSheet: 'MainSheet', targetSheet: 'Rules', sids: [700000000000006], deleteSource: true, targetGroupPath: 'Setup' },
      'Moving these events to "Rules" would put names that Construct 3 treats as the same (ignoring case) into one event variable scope:\n' +
      '- the local variable "Choice" differs only in case from the event variable "choice" in sheet "Rules"');
    // Into the top level of the sheet the local keeps its own scope
    await expectCreated('move_events_between_sheets',
      { sourceSheet: 'MainSheet', targetSheet: 'Rules', sids: [700000000000006], deleteSource: true });
  });
});

describe('animation tools refuse names that differ only in case', () => {
  it('add_animation_to_sprite refuses a case variant (its frame images would share files)', async () => {
    await expectRefused('add_animation_to_sprite', { objectName: 'Sprite', animationName: 'animation 1' }, 'the existing animation "Animation 1"');
  });

  it('also compares with animations in animation folders, and never touches their frame images', async () => {
    await editJson('objectTypes/Sprite.json', sprite => {
      sprite.animations.subfolders.push({
        items: [{ name: 'Walk', sid: 300000000000002, speed: 5, isLooping: true, isPingPong: false, repeatCount: 1, repeatTo: 0, frames: [{ width: 64, height: 64, originX: 0.5, originY: 0.5, duration: 1 }] }],
        subfolders: [{ items: [{ name: 'Jump', sid: 300000000000003, speed: 5, isLooping: false, isPingPong: false, repeatCount: 1, repeatTo: 0, frames: [] }], subfolders: [], name: 'Leaps' }],
        name: 'Moves',
      });
    });
    await mkdir(join(dir, 'images'));
    await writeFile(join(dir, 'images', 'sprite-walk-000.png'), 'REAL-PIXELS', 'utf-8');

    await expectRefused('add_animation_to_sprite', { objectName: 'Sprite', animationName: 'WALK' }, 'the existing animation "Walk"');
    await expectRefused('add_animation_to_sprite', { objectName: 'Sprite', animationName: 'Walk' }, 'Animation "Walk" already exists on "Sprite"');
    await expectRefused('add_animation_to_sprite', { objectName: 'Sprite', animationName: 'jump' }, 'the existing animation "Jump"');
    await expectRefused('rename_animation', { objectName: 'Sprite', animationName: 'Animation 1', newName: 'walk' }, 'the existing animation "Walk"');
    await expectRefused('rename_animation', { objectName: 'Sprite', animationName: 'Animation 1', newName: 'Jump' }, 'Animation "Jump" already exists');
    expect(await readFile(join(dir, 'images', 'sprite-walk-000.png'), 'utf-8')).toBe('REAL-PIXELS');
  });

  it('rename_animation refuses another animation\'s case variant but can change the case of its own name', async () => {
    await expectCreated('add_animation_to_sprite', { objectName: 'Sprite', animationName: 'Walk' });
    await expectRefused('rename_animation', { objectName: 'Sprite', animationName: 'Walk', newName: 'ANIMATION 1' }, '"Animation 1"');
    await expectCreated('rename_animation', { objectName: 'Sprite', animationName: 'Walk', newName: 'walk' });
    const sprite = JSON.parse(await readFile(join(dir, 'objectTypes', 'Sprite.json'), 'utf-8'));
    expect(sprite.animations.items.map((a: { name: string }) => a.name)).toEqual(['Animation 1', 'walk']);
  });
});
