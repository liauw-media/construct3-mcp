/**
 * What the analysis tools count on editor-saved event shapes (issue #38),
 * through the tools on a temp copy of the minimal fixture with the real
 * reader, writer and ID generator:
 * - get_function_map lists the parameters the editor saves in
 *   `functionParameters` (item 6)
 * - analyze_performance counts only the event blocks that run every tick
 *   (item 7)
 * - System "Create object (by name)" with a literal name counts as a use of
 *   the object for find_orphaned_objects, get_object_dependencies and the
 *   delete_object check, as in get_asset_usage (item 9)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, cp, rm, mkdir, readFile, writeFile, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { registerMutationTools } from '../../src/tools/mutations.js';
import { registerQueryTools } from '../../src/tools/query.js';
import { registerAnalysisTools } from '../../src/tools/analysis.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

let tmpDir: string;
let server: MockServer;
let nextSid = 810000000000000;
const sid = () => ++nextSid;

async function readJson(path: string): Promise<any> {
  return JSON.parse(await readFile(join(tmpDir, path), 'utf-8'));
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await writeFile(join(tmpDir, path), JSON.stringify(data, null, '\t'));
}

/** Add an event sheet with these events to the project (file and registration). */
async function addSheet(name: string, events: unknown[]): Promise<void> {
  await writeJson(`eventSheets/${name}.json`, { name, events, sid: sid() });
  const project = await readJson('project.c3proj');
  project.eventSheets.items.push(name);
  await writeJson('project.c3proj', project);
}

/** Add a Sprite object type with one animation (file and registration). */
async function addSprite(name: string): Promise<void> {
  const frame = { width: 32, height: 32, originX: 0.5, originY: 0.5, duration: 1, imageSpriteId: 1000000 + (nextSid % 1000) };
  await writeJson(`objectTypes/${name}.json`, {
    name, 'plugin-id': 'Sprite', sid: sid(), isGlobal: false, instanceVariables: [], behaviorTypes: [], effectTypes: [],
    animations: { items: [{ name: 'Default', sid: sid(), speed: 5, isLooping: false, isPingPong: false, repeatCount: 1, repeatTo: 0, frames: [frame] }], subfolders: [] },
  });
  const project = await readJson('project.c3proj');
  project.objectTypes.items.push(name);
  await writeJson('project.c3proj', project);
}

/** Start the tools on the project as it is on disk now (the reader loads project.c3proj once). */
async function startServer(): Promise<void> {
  const reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  server = new MockServer();
  registerMutationTools(server as never, reader, new Construct3ProjectWriter(reader, idGen), idGen);
  registerQueryTools(server as never, reader);
  registerAnalysisTools(server as never, reader);
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const result = await server.callTool(name, args);
  expect(result.isError, result.content[0].text).toBeUndefined();
  return JSON.parse(result.content[0].text);
}

beforeEach(async () => {
  resetProjectIndex();
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-analysis-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
});

// ─── get_function_map (#38 item 6) ──────────────────────────

describe('get_function_map parameters', () => {
  it('lists the parameters of editor-saved function blocks and of functions add_event_to_sheet creates', async () => {
    // An editor-saved function block: the parameters are under functionParameters
    await addSheet('Functions', [{
      functionName: 'Damage', functionDescription: '', functionCategory: '', functionReturnType: 'none',
      functionCopyPicked: false, functionIsAsync: false,
      functionParameters: [
        { name: 'amount', type: 'number', initialValue: '0', comment: '', sid: sid() },
        { name: 'source', type: 'string', initialValue: '', comment: '', sid: sid() },
      ],
      eventType: 'function-block', conditions: [], actions: [], sid: sid(),
    }]);
    await startServer();
    const added = await call('add_event_to_sheet', {
      sheetName: 'MainSheet', eventType: 'function', functionName: 'Heal', functionParams: [{ name: 'hp', type: 'number' }],
    });
    expect(added.success).toBe(true);

    for (const detail of ['summary', 'standard', 'full']) {
      const map = await call('get_function_map', { detail });
      const params = Object.fromEntries(map.functions.map((f: { name: string; params: string[] }) => [f.name, f.params]));
      expect(params).toEqual({ Damage: ['amount', 'source'], Heal: ['hp'] });
    }
  });

  it('still reads the parameters of a function block that has them under "parameters" only', async () => {
    await addSheet('Old', [{
      functionName: 'Legacy', eventType: 'function-block', conditions: [], actions: [], sid: sid(),
      parameters: [{ name: 'value', type: 'number' }],
    }]);
    await startServer();

    const map = await call('get_function_map', { eventsheet: 'Old' });
    expect(map.functions).toEqual([expect.objectContaining({ name: 'Legacy', params: ['value'] })]);
  });
});

// ─── analyze_performance every-tick count (#38 item 7) ──────

const trigger = () => ({ id: 'on-start-of-layout', objectClass: 'System', sid: sid() });
const compareX = () => ({ id: 'compare-x', objectClass: 'Sprite', sid: sid(), parameters: { comparison: 0, 'x-co-ordinate': '0' } });
const elseCondition = () => ({ id: 'else', objectClass: 'System', sid: sid() });
const setX = () => ({ id: 'set-x', objectClass: 'Sprite', sid: sid(), parameters: { x: '1' } });
const block = (conditions: unknown[] = [], children: unknown[] = [], extra: Record<string, unknown> = {}) => ({
  eventType: 'block', conditions, actions: [setX()], sid: sid(), ...(children.length > 0 ? { children } : {}), ...extra,
});
const group = (title: string, children: unknown[], extra: Record<string, unknown> = {}) => ({
  eventType: 'group', disabled: false, title, description: '', isActiveOnStart: true, children, sid: sid(), ...extra,
});

/** The number analyze_performance reports as running every tick for one sheet, or 0 without such an issue. */
async function everyTickCount(sheet: string): Promise<number> {
  const result = await call('analyze_performance', { scope: sheet, detail: 'full' });
  const issue = result.issues.find((i: { location: string; message: string }) => i.location === sheet && /every tick/.test(i.message));
  return issue ? Number(/^(\d+) event block/.exec(issue.message)![1]) : 0;
}

describe('analyze_performance every-tick count', () => {
  const cases: Record<string, { events: unknown[]; expected: number }> = {
    // Run every tick
    TopLevelNoConditions: { events: [block()], expected: 1 },
    OnlyEveryTickCondition: { events: [block([{ id: 'every-tick', objectClass: 'System', sid: sid() }])], expected: 1 },
    OnlyNonTriggerCondition: { events: [block([compareX()])], expected: 1 },
    InActiveGroups: { events: [group('Outer', [block(), group('Inner', [block([compareX()])])])], expected: 2 },
    // A sub-event runs as part of its parent, which is counted
    NonTriggerParentWithSubEvent: { events: [block([compareX()], [block(), block()])], expected: 1 },
    // An else block belongs to the block before it
    ElseAfterEveryTickBlock: { events: [block([compareX()]), block([elseCondition()])], expected: 1 },
    // Run only when a trigger fires or a function runs
    TriggerWithSubEvents: { events: [block([trigger()], [block(), block(), block()])], expected: 0 },
    TriggerWithSubEventElsePair: { events: [block([trigger()], [block(), block([elseCondition()])])], expected: 0 },
    OrBlockWithTrigger: { events: [block([compareX(), trigger()], [], { isOrBlock: true })], expected: 0 },
    FunctionBody: {
      events: [{
        functionName: 'F', functionDescription: '', functionCategory: '', functionReturnType: 'none', functionCopyPicked: false,
        functionIsAsync: false, functionParameters: [], eventType: 'function-block', conditions: [], actions: [], sid: sid(),
        children: [block(), block([compareX()])],
      }],
      expected: 0,
    },
    CustomActionBody: {
      events: [{ eventType: 'custom-ace-block', objectClass: 'Sprite', aceName: 'Hit', conditions: [], actions: [], sid: sid(), children: [block()] }],
      expected: 0,
    },
    // Do not run, or not until something activates them
    DisabledBlock: { events: [block([], [], { disabled: true })], expected: 0 },
    DisabledGroup: { events: [group('Off', [block()], { disabled: true })], expected: 0 },
    GroupInactiveOnStart: { events: [group('Later', [block(), group('Nested', [block()])], { isActiveOnStart: false })], expected: 0 },
    // Rows that are not event blocks
    NonBlockRows: {
      events: [
        { eventType: 'comment', text: 'note' },
        { eventType: 'variable', name: 'V', type: 'number', initialValue: '0', comment: '', isStatic: false, isConstant: false, sid: sid() },
        group('Empty', []),
      ],
      expected: 0,
    },
  };

  it('counts the event blocks at the top level or in active groups that have no trigger condition', async () => {
    for (const [name, { events }] of Object.entries(cases)) await addSheet(name, events);
    await startServer();

    const counts: Record<string, number> = {};
    for (const name of Object.keys(cases)) counts[name] = await everyTickCount(name);
    expect(counts).toEqual(Object.fromEntries(Object.entries(cases).map(([name, c]) => [name, c.expected])));
  });
});

// ─── Create object (by name) with a literal name (#38 item 9) ─

/** System "Create object (by name)" as the editor saves it; `objectName` is the expression. */
const createByName = (objectName: string) => ({
  id: 'create-object-by-name', objectClass: 'System', sid: sid(),
  parameters: { 'object-name': objectName, layer: '"Main"', x: '0', y: '0', 'create-hierarchy': false, 'template-name': '""' },
});

async function exists(path: string): Promise<boolean> {
  try {
    await stat(join(tmpDir, path));
    return true;
  } catch {
    return false;
  }
}

describe('System "Create object (by name)" with a literal name', () => {
  it('counts as a use in find_orphaned_objects, get_object_dependencies and the delete_object check, as in get_asset_usage', async () => {
    await addSprite('Bullet');
    await addSprite('Spare');
    await addSheet('Spawner', [block([trigger()], [], { actions: [createByName('"Bullet"')] })]);
    await startServer();

    const orphans = await call('find_orphaned_objects');
    expect(orphans.orphanedObjects.map((o: { name: string }) => o.name)).toEqual(['Spare']);

    const deps = await call('get_object_dependencies', { object: 'Bullet' });
    expect(deps.object.referencedIn.eventSheets).toEqual(['Spawner']);
    expect(deps.object.referenceCount).toBe(1);
    const projectWide = await call('get_object_dependencies', { detail: 'full' });
    expect(projectWide.projectWide.orphanedObjects).toEqual(['Spare']);

    const assets = await call('get_asset_usage', { type: 'image', detail: 'full' });
    expect(assets.assets.find((a: { name: string }) => a.name === 'Bullet').status).toBe('used');

    const validation = await call('validate_project');
    const orphanInfo = validation.info.filter((i: { check: string }) => i.check === 'orphaned-object').map((i: { entity: string }) => i.entity);
    expect(orphanInfo).toEqual(['objectTypes/Spare']);

    const refused = await call('delete_object', { name: 'Bullet' });
    expect(refused.action).toBe('delete_blocked');
    expect(refused.references.eventSheets).toEqual(['Spawner']);
    expect(await exists('objectTypes/Bullet.json')).toBe(true);

    const forced = await call('delete_object', { name: 'Bullet', force: true });
    expect(forced.success).toBe(true);
    // validate_project cannot report a name in a string literal once the object is gone
    expect(forced.warnings.join(' ')).toMatch(/will not report its 1 use\(s\) in expressions, scripts and Create object \(by name\)/);
  });

  it('matches the name ignoring case, as the runtime looks it up, and counts a family created by name for its members', async () => {
    await addSprite('Bullet');
    await addSprite('Shard');
    await mkdir(join(tmpDir, 'families'), { recursive: true });
    await writeJson('families/Debris.json', {
      name: 'Debris', 'plugin-id': 'Sprite', sid: sid(), instanceVariables: [], behaviorTypes: [], effectTypes: [], members: ['Shard'],
    });
    const project = await readJson('project.c3proj');
    project.families.items.push('Debris');
    await writeJson('project.c3proj', project);
    await addSheet('Spawner', [block([trigger()], [], { actions: [createByName(' "bullet" '), createByName('"DEBRIS"')] })]);
    await startServer();

    const orphans = await call('find_orphaned_objects');
    expect(orphans.orphanedObjects).toEqual([]);
    expect((await call('delete_object', { name: 'Shard' })).action).toBe('delete_blocked');
  });

  it('does not count a name built by an expression, or a literal inside a longer expression', async () => {
    await addSprite('Bullet');
    await addSheet('Spawner', [block([trigger()], [], { actions: [createByName('"Bul" & "let"'), createByName('LevelName & "Bullet"')] })]);
    await startServer();

    const orphans = await call('find_orphaned_objects');
    expect(orphans.orphanedObjects.map((o: { name: string }) => o.name)).toEqual(['Bullet']);
  });
});
