/**
 * The server and the files on disk (#51, #38 item 13). Runs the real reader,
 * writer and ID generator on a copy of the minimal fixture (event sheet
 * MainSheet, layout "Layout 1" with one Sprite instance, UID 0).
 *
 * - One backup per tool call: a call that writes project.c3proj twice keeps
 *   the state from before the call in project.c3proj.bak.
 * - Changes made outside the server between two calls (git restore, a save
 *   in the Construct 3 editor) are seen by the next call.
 * - A write never replaces a change made on disk after the call read the file;
 *   a call refused that way after it changed other files puts those back.
 * - The writer's own updates of project.c3proj merge a change made on disk.
 * - The ID generator keeps its scan across the server's own writes and scans
 *   again after an external change, without handing out an ID twice.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, cp, readFile, readdir, rm, writeFile } from 'fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { runInToolCall } from '../../src/construct3/disk-state.js';
import { registerQueryTools } from '../../src/tools/query.js';
import { registerAnalysisTools } from '../../src/tools/analysis.js';
import { registerMutationTools } from '../../src/tools/mutations.js';
import { registerRuntimeTools } from '../../src/tools/runtime-tools.js';
import { registerProjectResources } from '../../src/resources/project.js';
import { registerWorkflowPrompts } from '../../src/prompts/workflows.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

let dir: string;
let snapshotDir: string;
let server: MockServer;
let reader: Construct3ProjectReader;
let writer: Construct3ProjectWriter;
let idGen: IdGenerator;

async function readJson(relPath: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(join(dir, ...relPath.split('/')), 'utf-8'));
}

async function editJson(relPath: string, change: (data: Record<string, any>) => void): Promise<void> {
  const path = join(dir, ...relPath.split('/'));
  const data = JSON.parse(await readFile(path, 'utf-8'));
  change(data);
  await writeFile(path, JSON.stringify(data, null, '\t'), 'utf-8');
}

async function call(tool: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string; data: any }> {
  const result = await server.callTool(tool, args);
  const text = result.content[0].text;
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = undefined; }
  return { isError: result.isError === true, text, data };
}

async function expectSuccess(tool: string, args: Record<string, unknown> = {}) {
  const result = await call(tool, args);
  expect(result.isError, `${tool}: ${result.text}`).toBe(false);
  return result;
}

/** "git restore . && git clean -fd": put the snapshot back, remove everything else. */
async function resetToSnapshot(): Promise<void> {
  for (const entry of await readdir(dir)) await rm(join(dir, entry), { recursive: true, force: true });
  await cp(snapshotDir, dir, { recursive: true });
}

function instanceUids(layout: Record<string, any>): number[] {
  return layout.layers[0].instances.map((i: Record<string, any>) => i.uid);
}

/** Saving project.c3proj in the editor: a new author (synchronous, so a sync reader method can do it). */
function saveProjectInEditor(): void {
  const path = join(dir, 'project.c3proj');
  const project = JSON.parse(readFileSync(path, 'utf-8'));
  project.properties.author = 'Editor';
  writeFileSync(path, JSON.stringify(project, null, '\t'), 'utf-8');
}

/** A comment event the editor added to an event sheet (synchronous). */
function saveSheetInEditor(sheet: string, text = 'saved in the editor'): void {
  const path = join(dir, 'eventSheets', `${sheet}.json`);
  const data = JSON.parse(readFileSync(path, 'utf-8'));
  data.events.push({ eventType: 'comment', text });
  writeFileSync(path, JSON.stringify(data, null, '\t'), 'utf-8');
}

/**
 * The first time the tool calls `method`, the editor saves project.c3proj
 * first: a change made during the tool call, after its start.
 */
function editorSavesProjectBeforeFirstCallOf<T extends object>(target: T, method: keyof T & string): void {
  const original = (target[method] as (...args: unknown[]) => unknown).bind(target);
  let saved = false;
  vi.spyOn(target as Record<string, (...args: unknown[]) => unknown>, method).mockImplementation((...args: unknown[]) => {
    if (!saved) {
      saved = true;
      saveProjectInEditor();
    }
    return original(...args);
  });
}

function projectText(): string {
  return readFileSync(join(dir, 'project.c3proj'), 'utf-8');
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'c3-disk-changes-'));
  await cp(FIXTURE_DIR, dir, { recursive: true });
  snapshotDir = await mkdtemp(join(tmpdir(), 'c3-disk-changes-snapshot-'));
  await cp(FIXTURE_DIR, snapshotDir, { recursive: true });
  reader = new Construct3ProjectReader(join(dir, 'project.c3proj'));
  await reader.loadProject();
  idGen = new IdGenerator();
  writer = new Construct3ProjectWriter(reader, idGen);
  server = new MockServer();
  registerProjectResources(server as never, reader);
  registerWorkflowPrompts(server as never, reader);
  registerQueryTools(server as never, reader);
  registerAnalysisTools(server as never, reader);
  registerMutationTools(server as never, reader, writer, idGen);
  registerRuntimeTools({ server: server as never, reader, writer });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
  await rm(snapshotDir, { recursive: true, force: true });
});

// ─── One backup per tool call ───────────────────────────────

describe('project.c3proj.bak holds the state from before the tool call (#51)', () => {
  it('create_object with a plugin it registers first', async () => {
    const original = await readFile(join(dir, 'project.c3proj'), 'utf-8');

    await expectSuccess('create_object', { name: 'Keyboard', pluginId: 'Keyboard' });

    expect(await readFile(join(dir, 'project.c3proj.bak'), 'utf-8')).toBe(original);
    const now = await readJson('project.c3proj');
    expect(now.usedAddons.map((a: { id: string }) => a.id)).toContain('Keyboard');
    expect(now.objectTypes.items).toContain('Keyboard');
  });

  it('update_object_properties adding two behaviors it registers first', async () => {
    const original = await readFile(join(dir, 'project.c3proj'), 'utf-8');

    await expectSuccess('update_object_properties', {
      name: 'Sprite',
      addBehaviors: [{ behaviorId: 'Platform', name: 'Platform' }, { behaviorId: 'Solid', name: 'Solid' }],
    });

    expect(await readFile(join(dir, 'project.c3proj.bak'), 'utf-8')).toBe(original);
    const ids = (await readJson('project.c3proj')).usedAddons.map((a: { id: string }) => a.id);
    expect(ids).toEqual(expect.arrayContaining(['Platform', 'Solid']));
  });

  it('the next call backs up the state the previous call left', async () => {
    await expectSuccess('create_object', { name: 'Keyboard', pluginId: 'Keyboard' });
    const afterFirst = await readFile(join(dir, 'project.c3proj'), 'utf-8');

    await expectSuccess('create_object', { name: 'Mouse', pluginId: 'Mouse' });

    expect(await readFile(join(dir, 'project.c3proj.bak'), 'utf-8')).toBe(afterFirst);
  });

  it('update_object_properties with a known and an unknown behavior registers neither', async () => {
    const original = await readFile(join(dir, 'project.c3proj'), 'utf-8');

    const result = await call('update_object_properties', {
      name: 'Sprite',
      addBehaviors: [{ behaviorId: 'Platform', name: 'Platform' }, { behaviorId: 'NoSuchBehavior', name: 'X' }],
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('"NoSuchBehavior" is not registered');
    expect(await readFile(join(dir, 'project.c3proj'), 'utf-8')).toBe(original);
  });
});

// ─── Changes made outside the server ────────────────────────

describe('changes made on disk between tool calls are seen (#51)', () => {
  it('after git restore the removed objects are gone and can be created again', async () => {
    await expectSuccess('create_object', { name: 'Keyboard', pluginId: 'Keyboard' });
    await expectSuccess('create_object', { name: 'Hero', pluginId: 'Sprite' });
    expect((await expectSuccess('list_objects')).text).toContain('Hero');

    await resetToSnapshot();

    const listed = await expectSuccess('list_objects');
    expect(listed.text).not.toContain('Hero');
    expect(listed.text).not.toContain('Keyboard');
    await expectSuccess('create_object', { name: 'Hero', pluginId: 'Sprite' });
    const validation = await expectSuccess('validate_project');
    expect(validation.data.valid).toBe(true);
    expect(validation.data.errors).toEqual([]);
  });

  it('a layout saved in the editor (project.c3proj unchanged) reaches the cached index', async () => {
    await expectSuccess('create_object', { name: 'Enemy', pluginId: 'Sprite' });
    expect((await expectSuccess('find_orphaned_objects')).text).toContain('Enemy');

    // The editor places an Enemy: only the layout file changes
    await editJson('layouts/Layout 1.json', layout => {
      layout.layers[0].instances.push({ ...layout.layers[0].instances[0], type: 'Enemy', uid: 1, sid: 500000000000100 });
    });

    const orphans = await expectSuccess('find_orphaned_objects');
    expect(JSON.stringify(orphans.data.orphanedObjects)).not.toContain('Enemy');
  });

  it('no UID is handed out twice when the editor added instances between two own writes', async () => {
    const add = () => expectSuccess('add_instance_to_layout', {
      layoutName: 'Layout 1', layerName: 'Main', objectType: 'Sprite', x: 1, y: 1,
    });
    await add();
    // The editor adds an instance with the next UID
    await editJson('layouts/Layout 1.json', layout => {
      const instances = layout.layers[0].instances;
      const next = Math.max(...instances.map((i: { uid: number }) => i.uid)) + 1;
      instances.push({ ...instances[0], uid: next, sid: 777000000000001 });
    });
    await add();

    const uids = instanceUids(await readJson('layouts/Layout 1.json'));
    expect(uids).toEqual([0, 1, 2, 3]);
  });

  it('a resource read shows project.c3proj as saved in the editor', async () => {
    const info = async () => JSON.parse((await server.readResource('construct3://project/info')).contents[0].text);
    expect((await info()).name).toBe('TestProject');

    await editJson('project.c3proj', project => { project.name = 'Renamed in the editor'; });

    expect((await info()).name).toBe('Renamed in the editor');
  });

  it('a prompt shows project.c3proj as saved in the editor', async () => {
    const text = async () => (await server.getPrompt('analyze_project')).messages[0].content.text;
    expect(await text()).toContain('Object Types: 1');

    await editJson('project.c3proj', project => { project.objectTypes.items.push('Hero'); });

    expect(await text()).toContain('Object Types: 2');
  });

  it('outside a tool call, syncWithDisk() brings the caches up to date', async () => {
    expect((await reader.readAllEventSheets()).get('MainSheet')?.events).toHaveLength(1);
    const epoch = reader.getDiskEpoch();

    await editJson('eventSheets/MainSheet.json', sheet => { sheet.events = []; });

    expect(await reader.syncWithDisk()).toBe(true);
    expect(reader.getDiskEpoch()).toBe(epoch + 1);
    expect((await reader.readAllEventSheets()).get('MainSheet')?.events).toHaveLength(0);
    expect(await reader.syncWithDisk()).toBe(false);
    expect(reader.getDiskEpoch()).toBe(epoch + 1);
  });

  it('a tool call reports a project.c3proj that cannot be read, and works again once it can', async () => {
    const original = await readFile(join(dir, 'project.c3proj'), 'utf-8');
    await writeFile(join(dir, 'project.c3proj'), '{ "half written', 'utf-8');

    const result = await call('list_objects');
    expect(result.isError).toBe(true);
    expect(result.text).toContain('project.c3proj changed on disk and could not be read again');

    await writeFile(join(dir, 'project.c3proj'), original, 'utf-8');
    expect((await expectSuccess('list_objects')).text).toContain('Sprite');
  });
});

// ─── Writes never replace a change they did not read ────────

describe('a write never replaces a change made on disk after the call read the file (#51)', () => {
  it('add_event_block refuses when the sheet is saved in the editor during the call', async () => {
    const readEventSheet = reader.readEventSheet.bind(reader);
    const editorVersion = JSON.stringify({ name: 'MainSheet', events: [], sid: 900000000000001, saved: 'in the editor' }, null, '\t');
    vi.spyOn(reader, 'readEventSheet').mockImplementation(async (name: string) => {
      const sheet = await readEventSheet(name);
      // Saved from the editor right after the tool read the sheet
      await writeFile(join(dir, 'eventSheets', 'MainSheet.json'), editorVersion, 'utf-8');
      return sheet;
    });

    const result = await call('add_event_block', {
      sheetName: 'MainSheet',
      conditions: [{ id: 'every-tick', objectClass: 'System' }],
      actions: [],
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('eventSheets/MainSheet.json was changed on disk after this server read it');
    expect(await readFile(join(dir, 'eventSheets', 'MainSheet.json'), 'utf-8')).toBe(editorVersion);
  });

  it('of two parallel calls on one object, none loses the other\'s change', async () => {
    // Both calls read the object before either writes it
    const readObjectType = reader.readObjectType.bind(reader);
    let reads = 0;
    let bothRead!: () => void;
    const bothHaveRead = new Promise<void>(resolve => { bothRead = resolve; });
    vi.spyOn(reader, 'readObjectType').mockImplementation(async (name: string) => {
      const obj = await readObjectType(name);
      if (++reads === 2) bothRead();
      await bothHaveRead;
      return obj;
    });

    const [a, b] = await Promise.all([
      call('update_object_properties', { name: 'Sprite', addVariables: [{ name: 'hp', type: 'number' }] }),
      call('update_object_properties', { name: 'Sprite', addVariables: [{ name: 'speed', type: 'number' }] }),
    ]);

    const names = ((await readJson('objectTypes/Sprite.json')).instanceVariables ?? []).map((v: { name: string }) => v.name);
    for (const [result, variable] of [[a, 'hp'], [b, 'speed']] as const) {
      if (result.isError) expect(result.text).toContain('was changed on disk after this server read it');
      else expect(names).toContain(variable);
    }
    expect([a, b].filter(r => r.isError)).toHaveLength(1);
  });

  it('delete_event_sheet refuses when the sheet is saved in the editor during the call', async () => {
    await expectSuccess('create_event_sheet', { name: 'Other' });
    // Saved from the editor after the tool read the sheet (for its reference check), before it deletes it
    const getSubfolderForEntity = writer.getSubfolderForEntity.bind(writer);
    vi.spyOn(writer, 'getSubfolderForEntity').mockImplementation((category, name) => {
      if (category === 'eventSheets' && name === 'Other') saveSheetInEditor('Other');
      return getSubfolderForEntity(category, name);
    });

    const result = await call('delete_event_sheet', { name: 'Other' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('eventSheets/Other.json was changed on disk after this server read it');
    expect((await readJson('eventSheets/Other.json')).events).toEqual([{ eventType: 'comment', text: 'saved in the editor' }]);
    expect((await readJson('project.c3proj')).eventSheets.items).toContain('Other');
  });

  it('of two parallel create_object calls with the same name, the second is refused', async () => {
    // Both calls pass the tool's own check for an existing file before either writes
    const entityFileRefusal = writer.entityFileRefusal.bind(writer);
    let checks = 0;
    let bothChecked!: () => void;
    const bothHaveChecked = new Promise<void>(resolve => { bothChecked = resolve; });
    vi.spyOn(writer, 'entityFileRefusal').mockImplementation(async (...args) => {
      const refusal = await entityFileRefusal(...args);
      if (++checks <= 2) {
        if (checks === 2) bothChecked();
        await bothHaveChecked;
      }
      return refusal;
    });

    const [sprite, text] = await Promise.all([
      call('create_object', { name: 'Enemy', pluginId: 'Sprite' }),
      call('create_object', { name: 'Enemy', pluginId: 'Text' }),
    ]);

    const results = [sprite, text];
    expect(results.filter(r => r.isError)).toHaveLength(1);
    const refused = results.find(r => r.isError)!;
    expect(refused.text).toContain('Refusing to create "Enemy": the file objectTypes/Enemy.json already exists');
    const winner = sprite.isError ? 'Text' : 'Sprite';
    expect((await readJson('objectTypes/Enemy.json'))['plugin-id']).toBe(winner);
    expect((await readJson('project.c3proj')).objectTypes.items.filter((n: string) => n === 'Enemy')).toHaveLength(1);
  });

  it('a file the call wrote itself can be written again in the same call', async () => {
    await runInToolCall(async () => {
      const sheet = await reader.readEventSheet('MainSheet');
      await writer.writeEntityFile('eventSheets', 'MainSheet', { ...sheet, events: [] });
      await writer.writeEntityFile('eventSheets', 'MainSheet', sheet);
    });
    expect((await readJson('eventSheets/MainSheet.json')).events).toHaveLength(1);
  });
});

// ─── project.c3proj updates of the writer merge ─────────────

describe('the writer\'s own updates of project.c3proj merge a change made on disk (#51)', () => {
  it('addToProject keeps the change, and the reader takes it in', async () => {
    await editJson('project.c3proj', project => { project.properties.author = 'Editor'; });

    await runInToolCall(async () => {
      const epoch = reader.getDiskEpoch();
      await writer.addToProject('eventSheets', 'Other');
      expect(reader.getDiskEpoch()).toBe(epoch + 1);
    });

    const project = await readJson('project.c3proj');
    expect(project.properties.author).toBe('Editor');
    expect(project.eventSheets.items).toContain('Other');
    expect(reader.getProject().properties.author).toBe('Editor');
  });

  it('create_event_sheet registers its sheet when project.c3proj is saved in the editor after the sheet was written', async () => {
    const writeEntityFile = writer.writeEntityFile.bind(writer);
    vi.spyOn(writer, 'writeEntityFile').mockImplementation(async (...args) => {
      const backup = await writeEntityFile(...args);
      saveProjectInEditor();
      return backup;
    });

    await expectSuccess('create_event_sheet', { name: 'Other' });

    const project = await readJson('project.c3proj');
    expect(project.properties.author).toBe('Editor');
    expect(project.eventSheets.items).toContain('Other');
    expect(existsSync(join(dir, 'eventSheets', 'Other.json'))).toBe(true);
    expect((await expectSuccess('validate_project')).data.valid).toBe(true);
  });

  it('delete_event_sheet unregisters its sheet when project.c3proj is saved in the editor after the sheet was deleted', async () => {
    await expectSuccess('create_event_sheet', { name: 'Other' });
    const deleteEntityFile = writer.deleteEntityFile.bind(writer);
    vi.spyOn(writer, 'deleteEntityFile').mockImplementation(async (...args) => {
      const backup = await deleteEntityFile(...args);
      saveProjectInEditor();
      return backup;
    });

    await expectSuccess('delete_event_sheet', { name: 'Other' });

    const project = await readJson('project.c3proj');
    expect(project.properties.author).toBe('Editor');
    expect(project.eventSheets.items).not.toContain('Other');
    expect(existsSync(join(dir, 'eventSheets', 'Other.json'))).toBe(false);
    expect((await expectSuccess('validate_project')).data.valid).toBe(true);
  });

  it('a change saved between the update\'s read and its write is read again and kept', async () => {
    // The backup is made after the read, right before the write
    const writerInternals = writer as unknown as { createBackup: (path: string) => Promise<string> };
    const createBackup = writerInternals.createBackup.bind(writer);
    let saved = false;
    vi.spyOn(writerInternals, 'createBackup').mockImplementation(async (path: string) => {
      const backup = await createBackup(path);
      if (!saved && path.endsWith('project.c3proj')) {
        saved = true;
        saveProjectInEditor();
      }
      return backup;
    });

    await runInToolCall(() => writer.addToProject('eventSheets', 'Other'));

    const project = await readJson('project.c3proj');
    expect(project.properties.author).toBe('Editor');
    expect(project.eventSheets.items).toContain('Other');
  });
});

// ─── A refused call puts back what it changed ───────────────

describe('a call refused after it changed other files puts them back (#51)', () => {
  const moveArgs = { sourceSheet: 'MainSheet', targetSheet: 'Other', sids: [400000000000003], deleteSource: true };

  async function eventCount(sheet: string, sid: number): Promise<number> {
    return (await readJson(`eventSheets/${sheet}.json`)).events.filter((e: { sid?: number }) => e.sid === sid).length;
  }

  it('move_events_between_sheets: the target sheet is put back when the source was saved in the editor', async () => {
    await expectSuccess('create_event_sheet', { name: 'Other' });
    const targetBefore = await readFile(join(dir, 'eventSheets', 'Other.json'), 'utf-8');
    // The editor saves the source sheet right after the tool wrote the target
    const writeEntityFile = writer.writeEntityFile.bind(writer);
    vi.spyOn(writer, 'writeEntityFile').mockImplementation(async (category, name, ...rest) => {
      const backup = await writeEntityFile(category, name, ...rest);
      if (name === 'Other') saveSheetInEditor('MainSheet');
      return backup;
    });

    const result = await call('move_events_between_sheets', moveArgs);

    expect(result.isError).toBe(true);
    expect(result.text).toContain('eventSheets/MainSheet.json was changed on disk after this server read it');
    expect(result.text).toContain('were put back as they were before the call (eventSheets/Other.json), so the call changed nothing');
    expect(await readFile(join(dir, 'eventSheets', 'Other.json'), 'utf-8')).toBe(targetBefore);
    const source = await readJson('eventSheets/MainSheet.json');
    expect(source.events.some((e: { text?: string }) => e.text === 'saved in the editor')).toBe(true);
    expect(await eventCount('MainSheet', 400000000000003)).toBe(1);

    // Run again, as the message says: the event is moved once
    vi.mocked(writer.writeEntityFile).mockRestore();
    const again = await expectSuccess('move_events_between_sheets', moveArgs);
    expect(again.data.warnings ?? []).toEqual([]);
    expect(await eventCount('Other', 400000000000003)).toBe(1);
    expect(await eventCount('MainSheet', 400000000000003)).toBe(0);
  });

  it('update_object_properties: project.c3proj and the object are put back when a layout was saved in the editor', async () => {
    const projectBefore = projectText();
    const objectBefore = await readFile(join(dir, 'objectTypes', 'Sprite.json'), 'utf-8');
    // The editor saves the layout right after the tool read it to add the new behavior's entries
    let objectWritten = false;
    const writeEntityFile = writer.writeEntityFile.bind(writer);
    vi.spyOn(writer, 'writeEntityFile').mockImplementation(async (category, ...rest) => {
      const backup = await writeEntityFile(category, ...rest);
      if (category === 'objectTypes') objectWritten = true;
      return backup;
    });
    const readAllLayouts = reader.readAllLayouts.bind(reader);
    vi.spyOn(reader, 'readAllLayouts').mockImplementation(async () => {
      const layouts = await readAllLayouts();
      if (objectWritten) {
        await editJson('layouts/Layout 1.json', layout => { layout.width = 1234; });
        objectWritten = false;
      }
      return layouts;
    });

    const result = await call('update_object_properties', {
      name: 'Sprite', addBehaviors: [{ behaviorId: 'Platform', name: 'Platform' }],
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('layouts/Layout 1.json was changed on disk after this server read it');
    expect(result.text).toContain('objectTypes/Sprite.json, project.c3proj');
    expect(projectText()).toBe(projectBefore);
    expect(await readFile(join(dir, 'objectTypes', 'Sprite.json'), 'utf-8')).toBe(objectBefore);
    expect((await readJson('layouts/Layout 1.json')).width).toBe(1234);
    expect(reader.getUsedAddons().map(a => a.id)).not.toContain('Platform');
  });

  it('a file the call created is deleted again', async () => {
    const error = await runInToolCall(async () => {
      await writer.writeEntityFile('eventSheets', 'New', { name: 'New', events: [], sid: 900000000000002 }, undefined, { createOnly: true });
      await writer.addToProject('eventSheets', 'New');
      const sheet = await reader.readEventSheet('MainSheet');
      saveSheetInEditor('MainSheet');
      return writer.writeEntityFile('eventSheets', 'MainSheet', { ...sheet, events: [] }).then(() => undefined, (e: Error) => e);
    });

    expect(error?.message).toContain('put back as they were before the call (project.c3proj, eventSheets/New.json (deleted: the call had created it))');
    expect(existsSync(join(dir, 'eventSheets', 'New.json'))).toBe(false);
    expect((await readJson('project.c3proj')).eventSheets.items).toEqual(['MainSheet']);
    expect(reader.getProject().eventSheets.items).toEqual(['MainSheet']);
    expect((await readJson('eventSheets/MainSheet.json')).events).toHaveLength(2);
  });

  it('a file changed on disk again after the call wrote it is left as it is and named', async () => {
    await expectSuccess('create_event_sheet', { name: 'Other' });
    // After the target write the editor saves both sheets
    const writeEntityFile = writer.writeEntityFile.bind(writer);
    vi.spyOn(writer, 'writeEntityFile').mockImplementation(async (category, name, ...rest) => {
      const backup = await writeEntityFile(category, name, ...rest);
      if (name === 'Other') {
        saveSheetInEditor('Other', 'target saved in the editor');
        saveSheetInEditor('MainSheet');
      }
      return backup;
    });

    const result = await call('move_events_between_sheets', moveArgs);

    expect(result.isError).toBe(true);
    expect(result.text).toContain('left as they are (changed on disk again after this call wrote them, or their backup was replaced): '
      + 'eventSheets/Other.json (its state from before the call is in eventSheets/Other.json.bak)');
    expect(result.text).toContain('Check the project (validate_project, git diff)');
    const target = await readJson('eventSheets/Other.json');
    expect(target.events.some((e: { text?: string }) => e.text === 'target saved in the editor')).toBe(true);
  });
});

// ─── Tools that update project.c3proj themselves ────────────

describe('tools that update project.c3proj themselves refuse a change made during the call, before their first write (#51)', () => {
  const refusal = 'project.c3proj was changed on disk after this server read it';
  const bridgeScript = () => join(dir, 'scripts', 'c3-runtime-bridge.js');

  it('create_timeline', async () => {
    editorSavesProjectBeforeFirstCallOf(reader, 'getProject');

    const result = await call('create_timeline', { name: 'Intro' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain(refusal);
    expect(existsSync(join(dir, 'timelines'))).toBe(false);
    const project = await readJson('project.c3proj');
    expect(project.properties.author).toBe('Editor');
    expect(JSON.stringify(project.timelines)).not.toContain('Intro');
  });

  it('delete_timeline', async () => {
    await expectSuccess('create_timeline', { name: 'Intro' });
    editorSavesProjectBeforeFirstCallOf(reader, 'getProject');

    const result = await call('delete_timeline', { name: 'Intro' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain(refusal);
    expect(existsSync(join(dir, 'timelines', 'Intro.json'))).toBe(true);
    expect(JSON.stringify((await readJson('project.c3proj')).timelines)).toContain('Intro');
  });

  it('register_addon', async () => {
    editorSavesProjectBeforeFirstCallOf(reader, 'getUsedAddons');

    const result = await call('register_addon', { type: 'behavior', id: 'Tween', name: 'Tween' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain(refusal);
    const project = await readJson('project.c3proj');
    expect(project.properties.author).toBe('Editor');
    expect(project.usedAddons.map((a: { id: string }) => a.id)).not.toContain('Tween');
  });

  it('unregister_addon', async () => {
    await expectSuccess('register_addon', { type: 'behavior', id: 'Tween', name: 'Tween' });
    editorSavesProjectBeforeFirstCallOf(reader, 'getUsedAddons');

    const result = await call('unregister_addon', { type: 'behavior', id: 'Tween', force: true });

    expect(result.isError).toBe(true);
    expect(result.text).toContain(refusal);
    expect((await readJson('project.c3proj')).usedAddons.map((a: { id: string }) => a.id)).toContain('Tween');
  });

  it('inject_runtime_bridge', async () => {
    editorSavesProjectBeforeFirstCallOf(reader, 'getProjectDir');

    const result = await call('inject_runtime_bridge');

    expect(result.isError).toBe(true);
    expect(result.text).toContain(refusal);
    expect(existsSync(bridgeScript())).toBe(false);
    expect(JSON.stringify((await readJson('project.c3proj')).rootFileFolders.script)).not.toContain('c3-runtime-bridge');
  });

  it('remove_runtime_bridge', async () => {
    await expectSuccess('inject_runtime_bridge');
    editorSavesProjectBeforeFirstCallOf(reader, 'getProjectDir');

    const result = await call('remove_runtime_bridge');

    expect(result.isError).toBe(true);
    expect(result.text).toContain(refusal);
    expect(existsSync(bridgeScript())).toBe(true);
    expect(JSON.stringify((await readJson('project.c3proj')).rootFileFolders.script)).toContain('c3-runtime-bridge');
  });

  it('export_for_preview', async () => {
    editorSavesProjectBeforeFirstCallOf(reader, 'getProjectDir');

    const result = await call('export_for_preview');

    expect(result.isError).toBe(true);
    expect(result.text).toContain(refusal);
    expect(existsSync(bridgeScript())).toBe(false);
  });

  it('pack_project', async () => {
    const output = join(snapshotDir, 'game.c3p');
    editorSavesProjectBeforeFirstCallOf(reader, 'getProjectDir');

    const result = await call('pack_project', { outputPath: output });

    expect(result.isError).toBe(true);
    expect(result.text).toContain(refusal);
    expect(existsSync(bridgeScript())).toBe(false);
    expect(existsSync(output)).toBe(false);
  });
});

// ─── The ID generator across writes (#38 item 13) ───────────

describe('the ID generator keeps its scan across the server\'s own writes (#38)', () => {
  it('a write does not make the next ID scan the project again, and its IDs are known', async () => {
    expect(await idGen.generateUid(reader)).toBe(1);
    const scans = vi.spyOn(reader, 'readAllLayouts');

    const layout = await reader.readLayout('Layout 1');
    layout.layers[0].instances.push({ ...layout.layers[0].instances[0], uid: 5000, sid: 500000000000200 });
    await writer.writeEntityFile('layouts', 'Layout 1', layout);

    expect(await idGen.generateUid(reader)).toBe(5001);
    expect(scans).not.toHaveBeenCalled();
  });

  it('add_event_block after add_event_block does not rescan the project', async () => {
    const add = () => expectSuccess('add_event_block', {
      sheetName: 'MainSheet', conditions: [{ id: 'every-tick', objectClass: 'System' }], actions: [],
    });
    await add();
    const scans = vi.spyOn(reader, 'readAllLayouts');
    await add();
    await add();
    expect(scans).not.toHaveBeenCalled();
  });

  it('a layout that could not be read at the first scan is tried again at the next UID request', async () => {
    // A registered layout with invalid JSON, so its UIDs are scanned as text, and a
    // lock (virus scanner, sync client) on it during the first scan only
    await writeFile(join(dir, 'layouts', 'Broken.json'), '{ "name": "Broken", "layers": [{ "instances": [{ "uid": 41, "sid": 500000000000041 }] }] ,,,', 'utf-8');
    await editJson('project.c3proj', project => { project.layouts.items.push('Broken'); });
    await reader.syncWithDisk();
    const scanEntityIdsRaw = reader.scanEntityIdsRaw.bind(reader);
    let locked = true;
    vi.spyOn(reader, 'scanEntityIdsRaw').mockImplementation(async (category, name) => {
      if (locked && name === 'Broken') {
        throw Object.assign(new Error(`EBUSY: resource busy or locked, open '${name}.json'`), { code: 'EBUSY' });
      }
      return scanEntityIdsRaw(category, name);
    });

    await runInToolCall(async () => {
      await expect(idGen.generateUid(reader)).rejects.toThrow(/Cannot generate a safe UID.*layouts\/Broken/);
    });
    locked = false;

    // The file is readable again; its state on disk did not change
    await runInToolCall(async () => {
      expect(await idGen.generateUid(reader)).toBe(42);
    });
  });

  it('the refusal after the second try names the file and the reason of that try', async () => {
    await writeFile(join(dir, 'layouts', 'Broken.json'), '{ "name": "Broken" ,,,', 'utf-8');
    await editJson('project.c3proj', project => { project.layouts.items.push('Broken'); });
    await reader.syncWithDisk();
    // Locked at the first scan, no read access when generateUid() tries it again
    vi.spyOn(reader, 'scanEntityIdsRaw')
      .mockRejectedValueOnce(Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }))
      .mockRejectedValue(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));

    await runInToolCall(async () => {
      const error = await idGen.generateUid(reader).then(() => undefined, (e: Error) => e);
      expect(error?.message).toContain('(layouts/Broken: no read access)');
      expect(error?.message).not.toContain('EBUSY');
    });
  });

  it('a layout that could not be read stops blocking UIDs once it is deleted', async () => {
    await writeFile(join(dir, 'layouts', 'Broken.json'), '{ "name": "Broken" ,,,', 'utf-8');
    await editJson('project.c3proj', project => { project.layouts.items.push('Broken'); });
    await reader.syncWithDisk();
    vi.spyOn(reader, 'scanEntityIdsRaw').mockRejectedValue(
      Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
    );

    await runInToolCall(async () => {
      await expect(idGen.generateUid(reader)).rejects.toThrow(/Cannot generate a safe UID.*layouts\/Broken/);
    });
    await runInToolCall(async () => {
      await writer.deleteEntityFile('layouts', 'Broken');
      await writer.removeFromProject('layouts', 'Broken');
    });

    await runInToolCall(async () => {
      expect(await idGen.generateUid(reader)).toBe(1);
    });
  });

  it('a rescan after an external change never hands out an ID twice', async () => {
    await runInToolCall(async () => {
      expect(await idGen.generateUid(reader)).toBe(1); // handed out, not written anywhere
    });
    // A change on disk: the next call scans again
    await editJson('eventSheets/MainSheet.json', sheet => { sheet.events = []; });
    await runInToolCall(async () => {
      await reader.checkProjectFile();
      expect(await idGen.generateUid(reader)).toBe(2);
    });
  });
});
