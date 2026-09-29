/**
 * Guards of the event sheet tools, through the tools on a temp copy of the
 * minimal fixture with the real reader, writer and ID generator:
 * - delete_event_sheet and the functions and global variables the deleted
 *   sheet defines (issue #58);
 * - moves that take a used global variable out of scope (issue #38);
 * - function names (issue #38);
 * - what add_event_to_sheet returns (issue #38);
 * - comment rows and function calls edited in place (issue #38).
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

async function register(name: string): Promise<void> {
  const c3projPath = join(tmpDir, 'project.c3proj');
  const project = JSON.parse(await readFile(c3projPath, 'utf-8'));
  project.eventSheets.items.push(name);
  await writeFile(c3projPath, JSON.stringify(project, null, '\t'));
}

/** A registered event sheet holding `events`. */
async function addSheet(name: string, events: unknown[], sid = 750000000000100 + Math.floor(Math.random() * 1000)): Promise<void> {
  await register(name);
  await writeFile(join(tmpDir, 'eventSheets', `${name}.json`), JSON.stringify({ name, events, sid }, null, '\t'));
}

/** A registered event sheet that is not valid JSON (cut off), holding `events` as written. */
async function addBrokenSheet(name: string, events: unknown[]): Promise<void> {
  const text = JSON.stringify({ name, events, sid: 750000000000001 }, null, '\t');
  await register(name);
  await mkdir(join(tmpDir, 'eventSheets'), { recursive: true });
  await writeFile(join(tmpDir, 'eventSheets', `${name}.json`), text.slice(0, text.length - 3));
}

async function readSheet(name: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(join(tmpDir, 'eventSheets', `${name}.json`), 'utf-8'));
}

async function sheetExists(name: string): Promise<boolean> {
  try {
    await stat(join(tmpDir, 'eventSheets', `${name}.json`));
    return true;
  } catch {
    return false;
  }
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

/** Call a tool that must not fail with an error result; returns its parsed result. */
async function call(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const result = await server.callTool(name, args);
  expect(result.isError, result.content[0].text).toBeUndefined();
  return JSON.parse(result.content[0].text);
}

/** Call a tool that must fail with an error result; returns the error text. */
async function callError(name: string, args: Record<string, unknown>): Promise<string> {
  const result = await server.callTool(name, args);
  expect(result.isError, result.content[0].text).toBe(true);
  return result.content[0].text as string;
}

const fn = (name: string, sid: number, extra: Record<string, unknown> = {}) => ({
  eventType: 'function-block', functionName: name, functionDescription: '', functionCategory: '',
  functionReturnType: 'none', functionCopyPicked: false, functionIsAsync: false, functionParameters: [],
  conditions: [], actions: [], sid, ...extra,
});
const variable = (name: string, sid: number) =>
  ({ eventType: 'variable', name, type: 'number', initialValue: '0', comment: '', isStatic: false, isConstant: false, sid });
const group = (title: string, sid: number, children: unknown[]) =>
  ({ eventType: 'group', disabled: false, title, description: '', isActiveOnStart: true, children, sid });
const block = (sid: number, actions: unknown[], conditions: unknown[] = []) =>
  ({ eventType: 'block', conditions, actions, sid });
const callFn = (name: string, sid: number) => ({ callFunction: name, sid });
const setX = (expression: string, sid: number) =>
  ({ id: 'set-x', objectClass: 'Sprite', sid, parameters: { x: expression } });
const compareVar = (name: string, sid: number) =>
  ({ id: 'compare-eventvar', objectClass: 'System', sid, parameters: { variable: name, comparison: 4, value: '10' } });

beforeEach(async () => {
  resetProjectIndex();
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-sheet-guards-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
});

// ─── delete_event_sheet (#58) ───────────────────────────────

describe('delete_event_sheet and the functions and global variables the sheet defines (#58)', () => {
  const LIB_FUNCTION_SID = 780000000000001;
  const LIB_GLOBAL_SID = 780000000000002;

  beforeEach(async () => {
    await addSheet('Lib', [
      fn('Spawn', LIB_FUNCTION_SID),
      variable('Score', LIB_GLOBAL_SID),
      group('Locals', 780000000000003, [variable('Local', 780000000000004), block(780000000000005, [setX('Local', 780000000000006)])]),
      // Uses inside the deleted sheet do not count
      block(780000000000007, [callFn('Spawn', 780000000000008), setX('Score', 780000000000009)]),
    ]);
  });

  it('refuses while another sheet calls a function it defines, and deletes with force, listing the calls left behind', async () => {
    await addSheet('Game', [block(781000000000001, [
      callFn('spawn', 781000000000002),
      { id: 'map-function', objectClass: 'Functions', sid: 781000000000003, parameters: { name: '"m"', string: '"s"', function: 'Spawn' } },
      setX('Functions.Spawn()', 781000000000004),
    ])]);
    await startServer();

    const blocked = await call('delete_event_sheet', { name: 'Lib' });
    expect(blocked.success).toBe(false);
    expect(blocked.action).toBe('delete_blocked');
    expect(blocked.message).toContain('Function "Spawn" is still referenced 3 time(s) in other event sheets than "Lib"');
    expect(blocked.message).toContain('invalid function name');
    expect(blocked.references.callers.map((c: any) => [c.function, c.via, c.sheet, c.path])).toEqual([
      ['Spawn', 'callFunction', 'Game', 'block > action:0'],
      ['Spawn', 'function-map', 'Game', 'block > action:1'],
      ['Spawn', 'expression', 'Game', 'block > action:2'],
    ]);
    expect(blocked.references.includedBy).toEqual([]);
    expect(await sheetExists('Lib')).toBe(true);

    const forced = await call('delete_event_sheet', { name: 'Lib', force: true });
    expect(forced.success).toBe(true);
    expect(forced.warnings.join(' ')).toMatch(/Deleted with force=true: Function "Spawn" is still referenced 3 time/);
    expect(forced.references.callers).toHaveLength(3);
    expect(await sheetExists('Lib')).toBe(false);
  });

  it('refuses while another sheet uses a global variable it defines', async () => {
    await addSheet('Game', [block(781000000000001, [setX('score * 2', 781000000000002)], [compareVar('Score', 781000000000003)])]);
    await startServer();

    const blocked = await call('delete_event_sheet', { name: 'Lib' });
    expect(blocked.action).toBe('delete_blocked');
    expect(blocked.message).toContain('Event variable "Score" is still used 2 time(s) in other event sheets than "Lib"');
    expect(blocked.references.variableReferences.map((r: any) => [r.variable, r.via, r.sheet, r.path])).toEqual([
      ['Score', 'event-variable', 'Game', 'block > condition:0'],
      ['Score', 'expression', 'Game', 'block > action:0'],
    ]);
    expect(await sheetExists('Lib')).toBe(true);
  });

  it('deletes when other sheets use neither, or use a name another sheet still defines', async () => {
    // "Spawn" is defined again elsewhere, "Local" is local to Lib, "Score" is not used elsewhere
    await addSheet('Game', [fn('SPAWN', 781000000000010), block(781000000000001, [callFn('Spawn', 781000000000002), setX('Local', 781000000000003)])]);
    await startServer();

    const result = await call('delete_event_sheet', { name: 'Lib' });
    expect(result.success).toBe(true);
    expect(result.references).toBeUndefined();
    expect(await sheetExists('Lib')).toBe(false);
  });

  it('refuses when an event sheet that could not be parsed names one of its functions or global variables', async () => {
    await addBrokenSheet('Broken', [block(781000000000001, [setX('Score + 1', 781000000000002)])]);
    await startServer();

    const blocked = await call('delete_event_sheet', { name: 'Lib' });
    expect(blocked.action).toBe('delete_blocked');
    expect(blocked.unscannedFiles).toEqual([
      { file: 'eventSheets/Broken', reason: 'not valid JSON', textSearch: 'possible-use', names: ['Score'] },
    ]);
    expect(await sheetExists('Lib')).toBe(true);
  });

  it('refuses without force when the sheet itself could not be parsed, and deletes it with force', async () => {
    await addBrokenSheet('Corrupt', [fn('Spawn2', 781000000000001)]);
    await startServer();

    const blocked = await call('delete_event_sheet', { name: 'Corrupt' });
    expect(blocked.action).toBe('delete_blocked');
    expect(blocked.message).toContain('Its own file could not be parsed: eventSheets/Corrupt (not valid JSON)');
    expect(blocked.unscannedFiles).toEqual([{
      file: 'eventSheets/Corrupt',
      reason: 'not valid JSON',
      textSearch: 'not-searched',
      unchecked: 'the functions and global variables it defines are unknown, so their uses in other event sheets could not be checked',
    }]);

    const forced = await call('delete_event_sheet', { name: 'Corrupt', force: true });
    expect(forced.success).toBe(true);
    expect(forced.warnings.join(' ')).toContain('Deleted with force=true: Its own file could not be parsed');
    expect(await sheetExists('Corrupt')).toBe(false);
  });
});

// ─── move_events_between_sheets and variable scope (#38) ────

describe('move_events_between_sheets and event variables taken out of scope (#38)', () => {
  const SCORE_SID = 782000000000001;
  const USER_SID = 782000000000002;

  /** MainSheet: global Score (first) used by the fixture block's sibling; Other: group G. */
  async function setUp(otherEvents: unknown[] = [group('G', 782000000000010, [])]): Promise<void> {
    const main = await readSheet('MainSheet');
    main.events.unshift(variable('Score', SCORE_SID));
    main.events.push(block(USER_SID, [
      { id: 'add-to-eventvar', objectClass: 'System', sid: 782000000000003, parameters: { variable: 'Score', value: '1' } },
      setX('Score * 2', 782000000000004),
    ], [compareVar('score', 782000000000005)]));
    await writeFile(join(tmpDir, 'eventSheets', 'MainSheet.json'), JSON.stringify(main, null, '\t'));
    await addSheet('Other', otherEvents);
  }

  it('refuses to move a used global variable into a group, lists the uses, and moves it with force (the #38 repro)', async () => {
    await setUp();
    await startServer();
    const before = await readFile(join(tmpDir, 'eventSheets', 'Other.json'), 'utf-8');

    const blocked = await call('move_events_between_sheets', {
      sourceSheet: 'MainSheet', targetSheet: 'Other', sids: [SCORE_SID], deleteSource: true, targetGroupPath: 'G',
    });
    expect(blocked.success).toBe(false);
    expect(blocked.action).toBe('move_blocked');
    expect(blocked.message).toContain('Event variable "Score" is still used 3 time(s) where it is no longer in scope after the move');
    expect(blocked.message).toContain('cannot find event variable');
    expect(blocked.references.variableReferences.map((r: any) => [r.variable, r.via, r.sheet, r.path, r.sid])).toEqual([
      ['Score', 'event-variable', 'MainSheet', 'block > condition:0', USER_SID],
      ['Score', 'event-variable', 'MainSheet', 'block > action:0', USER_SID],
      ['Score', 'expression', 'MainSheet', 'block > action:1', USER_SID],
    ]);
    expect(await readFile(join(tmpDir, 'eventSheets', 'Other.json'), 'utf-8')).toBe(before);
    expect((await readSheet('MainSheet')).events[0].name).toBe('Score');

    const forced = await call('move_events_between_sheets', {
      sourceSheet: 'MainSheet', targetSheet: 'Other', sids: [SCORE_SID], deleteSource: true, targetGroupPath: 'G', force: true,
    });
    expect(forced.success).toBe(true);
    expect(forced.warnings.join(' ')).toContain('Moved with force=true: Event variable "Score" is still used 3 time(s)');
    expect(forced.references.variableReferences).toHaveLength(3);
    expect((await readSheet('Other')).events[0].children.map((e: any) => e.name)).toEqual(['Score']);
  });

  it('moves a used global variable to the top level of another sheet, where it stays global', async () => {
    await setUp();
    await startServer();
    const result = await call('move_events_between_sheets', {
      sourceSheet: 'MainSheet', targetSheet: 'Other', sids: [SCORE_SID], deleteSource: true,
    });
    expect(result.success).toBe(true);
    expect(result.references).toBeUndefined();
  });

  it('moves a global variable into a group together with the events that use it', async () => {
    await setUp();
    await startServer();
    const result = await call('move_events_between_sheets', {
      sourceSheet: 'MainSheet', targetSheet: 'Other', sids: [SCORE_SID, USER_SID], deleteSource: true, targetGroupPath: 'G',
    });
    expect(result.success).toBe(true);
    expect(result.warnings ?? []).not.toContainEqual(expect.stringContaining('no longer in scope'));
  });

  it('refuses when an event sheet that could not be parsed names the global variable', async () => {
    const main = await readSheet('MainSheet');
    main.events.unshift(variable('Score', SCORE_SID));
    await writeFile(join(tmpDir, 'eventSheets', 'MainSheet.json'), JSON.stringify(main, null, '\t'));
    await addSheet('Other', [group('G', 782000000000010, [])]);
    await addBrokenSheet('Broken', [block(782000000000020, [setX('Score + 1', 782000000000021)])]);
    await startServer();

    const blocked = await call('move_events_between_sheets', {
      sourceSheet: 'MainSheet', targetSheet: 'Other', sids: [SCORE_SID], deleteSource: true, targetGroupPath: 'G',
    });
    expect(blocked.action).toBe('move_blocked');
    expect(blocked.unscannedFiles).toEqual([
      { file: 'eventSheets/Broken', reason: 'not valid JSON', textSearch: 'possible-use', names: ['Score'] },
    ]);
  });
});

// ─── add_event_to_sheet results (#38) ───────────────────────

describe('add_event_to_sheet returns what it created (#38)', () => {
  it('returns the SID of a new group, function (with its parameter SIDs) and variable, the eventPath and backupFile', async () => {
    await startServer();

    const g = await call('add_event_to_sheet', { sheetName: 'MainSheet', eventType: 'group', title: 'Movement' });
    const f = await call('add_event_to_sheet', {
      sheetName: 'MainSheet', eventType: 'function', functionName: 'Heal',
      functionParams: [{ name: 'amount', type: 'number' }, { name: 'source', type: 'string' }],
    });
    const v = await call('add_event_to_sheet', { sheetName: 'MainSheet', eventType: 'variable', variableName: 'Score', position: 'start' });
    const c = await call('add_event_to_sheet', { sheetName: 'MainSheet', eventType: 'comment', commentText: 'note' });

    const events = (await readSheet('MainSheet')).events;
    expect(g.generatedSid).toBe(events[2].sid);
    expect(g.eventPath).toBe('events[1]');
    expect(f.generatedSid).toBe(events[3].sid);
    expect(f.functionParameterSids).toEqual([
      { name: 'amount', sid: events[3].functionParameters[0].sid },
      { name: 'source', sid: events[3].functionParameters[1].sid },
    ]);
    expect(v.generatedSid).toBe(events[0].sid);
    expect(v.eventPath).toBe('events[0]');
    expect(c.generatedSid).toBeUndefined();
    expect(c.eventPath).toBe('events[4]');
    for (const r of [g, f, v, c]) expect(r.backupFile).toMatch(/MainSheet\.json\.bak$/);
  });

  it('writes the colours of a comment event in the editor\'s keys', async () => {
    await startServer();
    await call('add_event_to_sheet', {
      sheetName: 'MainSheet', eventType: 'comment', commentText: 'Boss fight',
      commentTextColor: [1, 0, 0, 1], commentBackgroundColor: [1, 1, 0.5, 1],
    });
    expect((await readSheet('MainSheet')).events.at(-1)).toEqual({
      eventType: 'comment', text: 'Boss fight', 'text-color': [1, 0, 0, 1], 'background-color': [1, 1, 0.5, 1],
    });
  });
});
