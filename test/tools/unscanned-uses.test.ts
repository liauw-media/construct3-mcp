/**
 * Reference checks and registered files the bulk reads skip (issue #55),
 * through the tools on a temp copy of the minimal fixture with the real
 * reader, writer and ID generator.
 *
 * A layout over the reader's 10MB cap, an event sheet or family that is not
 * valid JSON, or a file that cannot be read at all is left out of the
 * cross-reference index, so its uses were invisible to every reference check.
 * The checks now search such files as text for the names they look for:
 * a match (a possible use), or a file that cannot be read even as text,
 * refuses without force; force goes ahead and names the files; no match goes
 * ahead with a warning that the file was only searched as text. A registered
 * file that does not exist holds no uses and changes nothing.
 *
 * The big layouts are valid JSON padded past the cap BEFORE the instances,
 * so a search that only read the first 10MB would miss them.
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
/** Must match MAX_FILE_SIZE in src/construct3/project-reader.ts */
const READER_SIZE_CAP = 10 * 1024 * 1024;

type Category = 'objectTypes' | 'eventSheets' | 'layouts' | 'families';

const ENEMY_SID = 710000000000001;
const FOES_SID = 720000000000001;

let tmpDir: string;
let server: MockServer;

async function register(category: Category, name: string): Promise<void> {
  const c3projPath = join(tmpDir, 'project.c3proj');
  const project = JSON.parse(await readFile(c3projPath, 'utf-8'));
  project[category].items.push(name);
  await writeFile(c3projPath, JSON.stringify(project, null, '\t'));
}

async function writeEntity(category: Category, name: string, content: string | Buffer): Promise<void> {
  await mkdir(join(tmpDir, category), { recursive: true });
  await writeFile(join(tmpDir, category, `${name}.json`), content);
}

async function addEntity(category: Category, name: string, data: unknown): Promise<void> {
  await register(category, name);
  await writeEntity(category, name, JSON.stringify(data, null, '\t'));
}

const frame = { width: 64, height: 64, originX: 0.5, originY: 0.5, duration: 1 };
const animation = (name: string, sid: number) => ({
  name, sid, speed: 5, isLooping: false, isPingPong: false, repeatCount: 1, repeatTo: 0, frames: [frame],
});

/** Enemy: a Sprite with instance variable "hp", behavior "Fade" and animations "Walk" and "Idle". */
async function addEnemy(): Promise<void> {
  await addEntity('objectTypes', 'Enemy', {
    name: 'Enemy',
    'plugin-id': 'Sprite',
    sid: ENEMY_SID,
    isGlobal: false,
    instanceVariables: [{ name: 'hp', type: 'number', desc: '', show: true, sid: 710000000000002 }],
    behaviorTypes: [{ behaviorId: 'Fade', name: 'Fade', sid: 710000000000003 }],
    effectTypes: [],
    animations: { items: [animation('Walk', 710000000000004), animation('Idle', 710000000000005)], subfolders: [] },
  });
}

/** Family Foes (Sprite) with member Enemy and instance variable "armor". */
async function addFoes(): Promise<void> {
  await addEntity('families', 'Foes', {
    name: 'Foes',
    'plugin-id': 'Sprite',
    sid: FOES_SID,
    instanceVariables: [{ name: 'armor', type: 'number', desc: '', show: true, sid: 720000000000002 }],
    behaviorTypes: [],
    effectTypes: [],
    members: ['Enemy'],
  });
}

let nextUid = 1000;
const instance = (type: string, extra: Record<string, unknown> = {}) => ({
  type, uid: nextUid++, sid: 730000000000000 + nextUid, properties: {}, instanceVariables: {}, behaviors: {},
  world: { x: 0, y: 0, width: 64, height: 64 }, ...extra,
});

/**
 * A registered layout over the read cap: valid JSON whose layers (with
 * `instances`) and event sheet binding come after a string of spaces that
 * pushes them past the cap.
 */
async function addBigLayout(name: string, instances: unknown[], eventSheet = ''): Promise<void> {
  const head = `{"name":${JSON.stringify(name)},"padding":"`;
  const tail = `","layers":[{"name":"Main","sid":740000000000001,"instances":${JSON.stringify(instances)}}],` +
    `"sid":740000000000002,"eventSheet":${JSON.stringify(eventSheet)},"width":1920,"height":1080}`;
  await register('layouts', name);
  await writeEntity('layouts', name, Buffer.concat([
    Buffer.from(head), Buffer.alloc(READER_SIZE_CAP + 4096, 0x20), Buffer.from(tail),
  ]));
}

/** A registered event sheet that is not valid JSON (cut off), holding `events` as written. */
async function addBrokenSheet(name: string, events: unknown[]): Promise<void> {
  const text = JSON.stringify({ name, events, sid: 750000000000001 }, null, '\t');
  await register('eventSheets', name);
  await writeEntity('eventSheets', name, text.slice(0, text.length - 3));
}

/** A registered file of `category` that exists but cannot be read, even as text (a directory). */
async function addUnreadable(category: Category, name: string): Promise<void> {
  await register(category, name);
  await mkdir(join(tmpDir, category, `${name}.json`), { recursive: true });
}

const block = (sid: number, actions: unknown[], conditions: unknown[] = []) =>
  ({ eventType: 'block', sid, conditions, actions });
const setX = (expression: string) =>
  ({ id: 'set-x', objectClass: 'Sprite', sid: 760000000000001, parameters: { x: expression } });

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

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const result = await server.callTool(name, args);
  expect(result.isError, result.content[0].text).toBeUndefined();
  return JSON.parse(result.content[0].text);
}

async function exists(category: Category, name: string): Promise<boolean> {
  try {
    await stat(join(tmpDir, category, `${name}.json`));
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  resetProjectIndex();
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-unscanned-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
});

// ─── delete_object ──────────────────────────────────────────

describe('delete_object with registered files that could not be parsed', () => {
  it('refuses without force when a layout over the read cap names the object (the #55 repro)', async () => {
    await addEnemy();
    await addBigLayout('Big', [instance('Enemy'), instance('Enemy')]);
    await startServer();

    const result = await call('delete_object', { name: 'Enemy' });
    expect(result.success).toBe(false);
    expect(result.action).toBe('delete_blocked');
    expect(result.message).toContain('possible uses in files that could not be parsed');
    expect(result.message).toContain('layouts/Big (over the 10MB read limit)');
    expect(result.unscannedFiles).toEqual([
      { file: 'layouts/Big', reason: 'over the 10MB read limit', textSearch: 'possible-use', names: ['Enemy'] },
    ]);
    expect(await exists('objectTypes', 'Enemy')).toBe(true);
  });

  it('deletes with force and names the files it could not check', async () => {
    await addEnemy();
    await addBigLayout('Big', [instance('Enemy')]);
    await startServer();

    const result = await call('delete_object', { name: 'Enemy', force: true });
    expect(result.success).toBe(true);
    expect(result.action).toBe('deleted');
    expect(result.warnings.join(' ')).toMatch(/possible uses.*layouts\/Big \(over the 10MB read limit\)/);
    expect(await exists('objectTypes', 'Enemy')).toBe(false);
  });

  it('deletes when the file does not name the object, with a warning that it was only searched as text', async () => {
    await addEnemy();
    // A longer name that starts with the object's name is not a use of it
    await addBigLayout('Big', [instance('Sprite'), instance('EnemyBullet')]);
    await startServer();

    const result = await call('delete_object', { name: 'Enemy' });
    expect(result.success).toBe(true);
    expect(result.warnings.join(' ')).toContain('layouts/Big (over the 10MB read limit) could not be parsed and was only searched as text');
    expect(await exists('objectTypes', 'Enemy')).toBe(false);
  });

  it('refuses when an event sheet that is not valid JSON names the object in an expression, ignoring case', async () => {
    await addEnemy();
    await addBrokenSheet('Broken', [block(760000000000010, [setX('enemy.X + 1')])]);
    await startServer();

    const result = await call('delete_object', { name: 'Enemy' });
    expect(result.action).toBe('delete_blocked');
    expect(result.unscannedFiles).toEqual([
      { file: 'eventSheets/Broken', reason: 'not valid JSON', textSearch: 'possible-use', names: ['Enemy'] },
    ]);
  });

  it('refuses when a family file that is not valid JSON lists the object', async () => {
    await addEnemy();
    await register('families', 'Foes');
    await writeEntity('families', 'Foes', '{"name":"Foes","plugin-id":"Sprite","members":["Enemy"]');
    await startServer();

    const result = await call('delete_object', { name: 'Enemy' });
    expect(result.action).toBe('delete_blocked');
    expect(result.unscannedFiles[0]).toMatchObject({ file: 'families/Foes', textSearch: 'possible-use' });
  });

  it('refuses when an object property in a layout over the read cap holds the object\'s SID', async () => {
    await addEnemy();
    await addBigLayout('Big', [instance('Sprite', { properties: { object: ENEMY_SID } })]);
    await startServer();

    const result = await call('delete_object', { name: 'Enemy' });
    expect(result.action).toBe('delete_blocked');
    expect(result.unscannedFiles[0].names).toEqual([`SID ${ENEMY_SID} of "Enemy"`]);
  });

  it('refuses when a registered file exists but cannot be read, even as text', async () => {
    await addEnemy();
    await addUnreadable('layouts', 'Bad');
    await startServer();

    const result = await call('delete_object', { name: 'Enemy' });
    expect(result.action).toBe('delete_blocked');
    expect(result.message).toContain('layouts/Bad (could not be read, not even as text)');
    expect(result.message).not.toContain(tmpDir);
    expect(result.unscannedFiles).toEqual([{ file: 'layouts/Bad', reason: 'could not be read', textSearch: 'unreadable' }]);
    expect(await exists('objectTypes', 'Enemy')).toBe(true);
  });

  it('a registered layout without a file does not block and is not mentioned', async () => {
    await addEnemy();
    await register('layouts', 'Ghost');
    await startServer();

    const result = await call('delete_object', { name: 'Enemy' });
    expect(result.success).toBe(true);
    expect(result.warnings).toBeUndefined();
  });

  it('a file that is gone by the time of the text search does not block', async () => {
    await addEnemy();
    await addBigLayout('Big', [instance('Enemy')]);
    await startServer();
    // Builds and caches the index while the layout is there
    await call('get_object_dependencies', { object: 'Sprite' });
    await rm(join(tmpDir, 'layouts', 'Big.json'));

    const result = await call('delete_object', { name: 'Enemy' });
    expect(result.success).toBe(true);
    expect(result.warnings).toBeUndefined();
  });
});

// ─── delete_family ──────────────────────────────────────────

describe('delete_family with registered files that could not be parsed', () => {
  it('refuses when an event sheet that is not valid JSON names the family', async () => {
    await addEnemy();
    await addFoes();
    await addBrokenSheet('Broken', [block(760000000000010, [], [{ id: 'is-visible', objectClass: 'Foes', sid: 760000000000011 }])]);
    await startServer();

    const result = await call('delete_family', { name: 'Foes' });
    expect(result.action).toBe('delete_blocked');
    expect(result.unscannedFiles).toEqual([
      { file: 'eventSheets/Broken', reason: 'not valid JSON', textSearch: 'possible-use', names: ['Foes'] },
    ]);
    expect(await exists('families', 'Foes')).toBe(true);

    const forced = await call('delete_family', { name: 'Foes', force: true });
    expect(forced.success).toBe(true);
    expect(forced.warnings.join(' ')).toMatch(/possible uses.*eventSheets\/Broken/);
    expect(await exists('families', 'Foes')).toBe(false);
  });

  it('refuses when a member uses the family\'s instance variable there ("Enemy.armor")', async () => {
    await addEnemy();
    await addFoes();
    await addBrokenSheet('Broken', [block(760000000000010, [setX('Enemy.armor * 2')])]);
    await startServer();

    const result = await call('delete_family', { name: 'Foes' });
    expect(result.action).toBe('delete_blocked');
    expect(result.unscannedFiles[0].names).toEqual(['armor', 'Enemy']);
  });

  it('does not refuse when the file names a member but none of the family\'s names', async () => {
    await addEnemy();
    await addFoes();
    await addBrokenSheet('Broken', [block(760000000000010, [setX('Enemy.X')])]);
    await startServer();

    const result = await call('delete_family', { name: 'Foes' });
    expect(result.success).toBe(true);
    expect(result.warnings.join(' ')).toContain('eventSheets/Broken (not valid JSON) could not be parsed and was only searched as text');
  });

  it('refuses when a registered event sheet cannot be read, even as text', async () => {
    await addEnemy();
    await addFoes();
    await addUnreadable('eventSheets', 'Bad');
    await startServer();

    const result = await call('delete_family', { name: 'Foes' });
    expect(result.action).toBe('delete_blocked');
    expect(result.unscannedFiles).toEqual([{ file: 'eventSheets/Bad', reason: 'could not be read', textSearch: 'unreadable' }]);
  });
});

// ─── delete_layout ──────────────────────────────────────────

describe('delete_layout of a layout that could not be parsed', () => {
  it('refuses without force when its text holds instances, deletes with force', async () => {
    await addBigLayout('Big', [instance('Sprite')]);
    await startServer();

    const result = await call('delete_layout', { name: 'Big' });
    expect(result.success).toBe(false);
    expect(result.action).toBe('delete_blocked');
    expect(result.unscannedFiles).toEqual([
      { file: 'layouts/Big', reason: 'over the 10MB read limit', textSearch: 'possible-use', names: ['instances'] },
    ]);
    expect(await exists('layouts', 'Big')).toBe(true);

    const forced = await call('delete_layout', { name: 'Big', force: true });
    expect(forced.success).toBe(true);
    expect(forced.warnings.join(' ')).toContain('layouts/Big');
    expect(await exists('layouts', 'Big')).toBe(false);
  });

  it('refuses when its text binds an event sheet', async () => {
    await addBigLayout('Big', [], 'MainSheet');
    await startServer();

    const result = await call('delete_layout', { name: 'Big' });
    expect(result.action).toBe('delete_blocked');
    expect(result.unscannedFiles[0].names).toEqual(['an event sheet binding']);
  });

  it('deletes an empty unbound layout, with a warning that it was only searched as text', async () => {
    await addBigLayout('Big', []);
    await startServer();

    const result = await call('delete_layout', { name: 'Big' });
    expect(result.success).toBe(true);
    expect(result.warnings.join(' ')).toContain('layouts/Big (over the 10MB read limit) could not be parsed and was only searched as text');
  });

  it('refuses when the layout cannot be read, even as text', async () => {
    await addUnreadable('layouts', 'Bad');
    await startServer();

    const result = await call('delete_layout', { name: 'Bad' });
    expect(result.action).toBe('delete_blocked');
    expect(result.unscannedFiles).toEqual([{ file: 'layouts/Bad', reason: 'could not be read', textSearch: 'unreadable' }]);
  });

  it('is not held up by other layouts that could not be parsed', async () => {
    await addEntity('layouts', 'Spare', { name: 'Spare', layers: [], sid: 740000000000010, eventSheet: '', width: 10, height: 10 });
    await addBigLayout('Big', [instance('Sprite')], 'MainSheet');
    await startServer();

    const result = await call('delete_layout', { name: 'Spare' });
    expect(result.success).toBe(true);
    expect(result.warnings).toBeUndefined();
  });
});

// ─── delete_event_sheet ─────────────────────────────────────

describe('delete_event_sheet with registered files that could not be parsed', () => {
  beforeEach(async () => {
    await addEntity('eventSheets', 'Extra', { name: 'Extra', events: [], sid: 750000000000020 });
  });

  it('refuses when a layout over the read cap is bound to the sheet, deletes with force', async () => {
    await addBigLayout('Big', [], 'Extra');
    await startServer();

    const result = await call('delete_event_sheet', { name: 'Extra' });
    expect(result.action).toBe('delete_blocked');
    expect(result.unscannedFiles).toEqual([
      { file: 'layouts/Big', reason: 'over the 10MB read limit', textSearch: 'possible-use', names: ['Extra'] },
    ]);
    expect(await exists('eventSheets', 'Extra')).toBe(true);

    const forced = await call('delete_event_sheet', { name: 'Extra', force: true });
    expect(forced.success).toBe(true);
    expect(forced.warnings.join(' ')).toMatch(/possible uses.*layouts\/Big/);
    expect(await exists('eventSheets', 'Extra')).toBe(false);
  });

  it('refuses when an event sheet that is not valid JSON includes it', async () => {
    await addBrokenSheet('Broken', [{ eventType: 'include', includeSheet: 'Extra' }]);
    await startServer();

    const result = await call('delete_event_sheet', { name: 'Extra' });
    expect(result.action).toBe('delete_blocked');
    expect(result.unscannedFiles[0]).toMatchObject({ file: 'eventSheets/Broken', textSearch: 'possible-use' });
  });

  it('deletes when no such file names the sheet, with a warning', async () => {
    await addBigLayout('Big', [], 'MainSheet');
    await startServer();

    const result = await call('delete_event_sheet', { name: 'Extra' });
    expect(result.success).toBe(true);
    expect(result.warnings.join(' ')).toContain('layouts/Big (over the 10MB read limit) could not be parsed and was only searched as text');
  });

  it('refuses when a registered layout cannot be read, even as text', async () => {
    await addUnreadable('layouts', 'Bad');
    await startServer();

    const result = await call('delete_event_sheet', { name: 'Extra' });
    expect(result.action).toBe('delete_blocked');
    expect(result.unscannedFiles).toEqual([{ file: 'layouts/Bad', reason: 'could not be read', textSearch: 'unreadable' }]);
  });
});

// ─── delete_event_from_sheet ────────────────────────────────

describe('delete_event_from_sheet with event sheets that could not be parsed', () => {
  const FUNCTION_SID = 770000000000001;
  const GLOBAL_SID = 770000000000002;
  const GROUP_SID = 770000000000003;

  beforeEach(async () => {
    await addEntity('eventSheets', 'Lib', {
      name: 'Lib',
      events: [
        { eventType: 'function-block', functionName: 'Spawn', functionParameters: [], sid: FUNCTION_SID, conditions: [], actions: [] },
        { eventType: 'variable', name: 'Score', type: 'number', initialValue: '0', isStatic: false, isConstant: false, sid: GLOBAL_SID },
        {
          eventType: 'group', title: 'Locals', sid: GROUP_SID, isActiveOnStart: true, children: [
            { eventType: 'variable', name: 'Local', type: 'number', initialValue: '0', isStatic: false, isConstant: false, sid: 770000000000004 },
          ],
        },
      ],
      sid: 750000000000030,
    });
  });

  it('refuses to delete a function another sheet that is not valid JSON may call, deletes with force', async () => {
    await addBrokenSheet('Broken', [block(760000000000010, [{ callFunction: 'spawn', sid: 760000000000012, parameters: [] }])]);
    await startServer();

    const result = await call('delete_event_from_sheet', { sheetName: 'Lib', sid: FUNCTION_SID });
    expect(result.action).toBe('delete_blocked');
    expect(result.unscannedFiles).toEqual([
      { file: 'eventSheets/Broken', reason: 'not valid JSON', textSearch: 'possible-use', names: ['Spawn'] },
    ]);

    const forced = await call('delete_event_from_sheet', { sheetName: 'Lib', sid: FUNCTION_SID, force: true });
    expect(forced.success).toBe(true);
    expect(forced.warnings.join(' ')).toMatch(/possible uses.*eventSheets\/Broken/);
  });

  it('refuses to delete a global variable such a sheet may use', async () => {
    await addBrokenSheet('Broken', [block(760000000000010, [setX('Score * 2')])]);
    await startServer();

    const result = await call('delete_event_from_sheet', { sheetName: 'Lib', sid: GLOBAL_SID });
    expect(result.action).toBe('delete_blocked');
    expect(result.unscannedFiles[0].names).toEqual(['Score']);
  });

  it('does not search other sheets for a local variable, which they cannot see', async () => {
    await addBrokenSheet('Broken', [block(760000000000010, [setX('Local + 1')])]);
    await startServer();

    const result = await call('delete_event_from_sheet', { sheetName: 'Lib', sid: GROUP_SID });
    expect(result.success).toBe(true);
    expect(result.unscannedFiles).toBeUndefined();
  });

  it('deletes when the sheet does not name the function, with a warning', async () => {
    await addBrokenSheet('Broken', [block(760000000000010, [setX('Spawner.X')])]);
    await startServer();

    const result = await call('delete_event_from_sheet', { sheetName: 'Lib', sid: FUNCTION_SID });
    expect(result.success).toBe(true);
    expect(result.warnings.join(' ')).toContain('eventSheets/Broken (not valid JSON) could not be parsed and was only searched as text');
  });

  it('refuses when a registered event sheet cannot be read, even as text', async () => {
    await addUnreadable('eventSheets', 'Bad');
    await startServer();

    const result = await call('delete_event_from_sheet', { sheetName: 'Lib', sid: FUNCTION_SID, dryRun: true });
    expect(result.action).toBe('delete_blocked');
    expect(result.unscannedFiles).toEqual([{ file: 'eventSheets/Bad', reason: 'could not be read', textSearch: 'unreadable' }]);
  });
});

// ─── update_object_properties / update_family ───────────────

describe('instance variable, behavior and member removal with event sheets that could not be parsed', () => {
  it('update_object_properties refuses to remove an instance variable such a sheet may use, removes it with force', async () => {
    await addEnemy();
    await addBrokenSheet('Broken', [block(760000000000010, [setX('Enemy.hp')])]);
    await startServer();

    const result = await call('update_object_properties', { name: 'Enemy', removeVariables: ['hp'] });
    expect(result.success).toBe(false);
    expect(result.action).toBe('update_blocked');
    expect(result.unscannedFiles).toEqual([
      { file: 'eventSheets/Broken', reason: 'not valid JSON', textSearch: 'possible-use', names: ['hp', 'Enemy'] },
    ]);

    const forced = await call('update_object_properties', { name: 'Enemy', removeVariables: ['hp'], force: true });
    expect(forced.success).toBe(true);
    expect(forced.warnings.join(' ')).toMatch(/possible uses.*eventSheets\/Broken/);
    const enemy = JSON.parse(await readFile(join(tmpDir, 'objectTypes', 'Enemy.json'), 'utf-8'));
    expect(enemy.instanceVariables).toEqual([]);
  });

  it('update_object_properties refuses to remove a behavior such a sheet may use', async () => {
    await addEnemy();
    await addBrokenSheet('Broken', [block(760000000000010, [{ id: 'start-fade', objectClass: 'Enemy', behaviorType: 'Fade', sid: 760000000000013 }])]);
    await startServer();

    const result = await call('update_object_properties', { name: 'Enemy', removeBehaviors: ['Fade'] });
    expect(result.action).toBe('update_blocked');
    expect(result.unscannedFiles[0].names).toEqual(['Fade', 'Enemy']);
  });

  it('update_object_properties does not refuse when the sheet names the variable only on another object', async () => {
    await addEnemy();
    await addBrokenSheet('Broken', [block(760000000000010, [setX('Sprite.hp')])]);
    await startServer();

    const result = await call('update_object_properties', { name: 'Enemy', removeVariables: ['hp'] });
    expect(result.success).toBe(true);
    expect(result.warnings.join(' ')).toContain('eventSheets/Broken (not valid JSON) could not be parsed and was only searched as text');
  });

  it('update_object_properties refuses when a registered event sheet cannot be read, even as text', async () => {
    await addEnemy();
    await addUnreadable('eventSheets', 'Bad');
    await startServer();

    const result = await call('update_object_properties', { name: 'Enemy', removeVariables: ['hp'] });
    expect(result.action).toBe('update_blocked');
    expect(result.unscannedFiles).toEqual([{ file: 'eventSheets/Bad', reason: 'could not be read', textSearch: 'unreadable' }]);
  });

  it('update_object_properties is not held up when nothing is removed', async () => {
    await addEnemy();
    await addUnreadable('eventSheets', 'Bad');
    await startServer();

    const result = await call('update_object_properties', { name: 'Enemy', isGlobal: false });
    expect(result.success).toBe(true);
  });

  it('update_family refuses to remove an instance variable such a sheet may use through the family, removes it with force', async () => {
    await addEnemy();
    await addFoes();
    await addBrokenSheet('Broken', [block(760000000000010, [setX('Foes.armor')])]);
    await startServer();

    const result = await call('update_family', { name: 'Foes', removeVariables: ['armor'] });
    expect(result.action).toBe('update_blocked');
    expect(result.unscannedFiles[0].names).toEqual(['armor', 'Foes']);

    const forced = await call('update_family', { name: 'Foes', removeVariables: ['armor'], force: true });
    expect(forced.success).toBe(true);
    expect(forced.warnings.join(' ')).toMatch(/possible uses.*eventSheets\/Broken/);
  });

  it('update_family refuses to remove a member such a sheet may use the family\'s names through', async () => {
    await addEnemy();
    await addFoes();
    await addBrokenSheet('Broken', [block(760000000000010, [setX('Enemy.armor')])]);
    await startServer();

    const result = await call('update_family', { name: 'Foes', removeMembers: ['Enemy'] });
    expect(result.action).toBe('update_blocked');
    expect(result.unscannedFiles[0].names).toEqual(['armor', 'Enemy']);
  });

  it('update_family does not refuse when the sheet does not name the variable', async () => {
    await addEnemy();
    await addFoes();
    await addBrokenSheet('Broken', [block(760000000000010, [setX('Foes.X')])]);
    await startServer();

    const result = await call('update_family', { name: 'Foes', removeVariables: ['armor'] });
    expect(result.success).toBe(true);
    expect(result.warnings.join(' ')).toContain('only searched as text');
  });

  it('update_family refuses when a registered event sheet cannot be read, even as text', async () => {
    await addEnemy();
    await addFoes();
    await addUnreadable('eventSheets', 'Bad');
    await startServer();

    const result = await call('update_family', { name: 'Foes', removeMembers: ['Enemy'] });
    expect(result.action).toBe('update_blocked');
    expect(result.unscannedFiles).toEqual([{ file: 'eventSheets/Bad', reason: 'could not be read', textSearch: 'unreadable' }]);
  });
});
