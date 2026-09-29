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

// ─── sheet names spelled otherwise than registered (#38) ────

describe('sheet names that differ from the registered name in case (#38)', () => {
  const SCORE_SID = 785000000000001;
  const USER_SID = 785000000000002;

  /** MainSheet: global Score used by a block; Other: group G. */
  async function setUp(): Promise<void> {
    const main = await readSheet('MainSheet');
    main.events.unshift(variable('Score', SCORE_SID));
    main.events.push(block(USER_SID, [setX('Score * 2', 785000000000003)]));
    await writeFile(join(tmpDir, 'eventSheets', 'MainSheet.json'), JSON.stringify(main, null, '\t'));
    await addSheet('Other', [group('G', 785000000000010, [])]);
    await startServer();
  }
  const files = () => Promise.all(['MainSheet', 'Other'].map(n => readFile(join(tmpDir, 'eventSheets', `${n}.json`), 'utf-8')));

  it('move_events_between_sheets refuses them, so a used global variable cannot slip into a group unchecked', async () => {
    await setUp();
    const before = await files();

    for (const [sourceSheet, targetSheet, named, meant] of [
      ['mainsheet', 'Other', 'mainsheet', 'MainSheet'],
      ['MainSheet', 'other', 'other', 'Other'],
    ]) {
      const error = await callError('move_events_between_sheets', {
        sourceSheet, targetSheet, sids: [SCORE_SID], deleteSource: true, targetGroupPath: 'G',
      });
      expect(error).toContain(`Event sheet "${named}" not found: names are matched with their letter case. Did you mean "${meant}"?`);
    }
    expect(await files()).toEqual(before);
  });

  it('move_events_between_sheets refuses the source sheet in another case as the target, which lost the moved events', async () => {
    await setUp();
    const before = await files();

    const error = await callError('move_events_between_sheets', {
      sourceSheet: 'MainSheet', targetSheet: 'mainsheet', sids: [USER_SID], deleteSource: true,
    });
    expect(error).toContain('Event sheet "mainsheet" not found: names are matched with their letter case. Did you mean "MainSheet"?');
    expect(await files()).toEqual(before);
  });

  it('delete_event_from_sheet, update_event_variable and add_event_to_sheet refuse them', async () => {
    const MEANT_MAIN_SHEET = 'Event sheet "mainsheet" not found: names are matched with their letter case. Did you mean "MainSheet"?';
    await setUp();
    const before = await files();

    expect(await callError('delete_event_from_sheet', { sheetName: 'mainsheet', sid: SCORE_SID, dryRun: true }))
      .toContain(MEANT_MAIN_SHEET);
    expect(await callError('update_event_variable', { sheetName: 'mainsheet', sid: SCORE_SID, newName: 'SCORE' }))
      .toContain(MEANT_MAIN_SHEET);
    expect(await callError('add_event_to_sheet', { sheetName: 'mainsheet', eventType: 'variable', variableName: 'Lives' }))
      .toContain(MEANT_MAIN_SHEET);
    expect(await files()).toEqual(before);

    // Spelled as registered, the delete is refused for the use and the case-only rename goes through
    expect((await call('delete_event_from_sheet', { sheetName: 'MainSheet', sid: SCORE_SID, dryRun: true })).action).toBe('delete_blocked');
    expect((await call('update_event_variable', { sheetName: 'MainSheet', sid: SCORE_SID, newName: 'SCORE' })).success).toBe(true);
  });
});

// ─── reference checks at their traversal limit (#58, #38) ───

describe('reference checks that stop at their traversal limit refuse without force (#58, #38)', () => {
  /** A registered event sheet with more events than the checks visit (100,000), as compact JSON (about 3MB). */
  async function addHugeSheet(name: string): Promise<void> {
    await register(name);
    const events = Array.from({ length: 100_001 }, () => ({ eventType: 'comment', text: '' }));
    await writeFile(join(tmpDir, 'eventSheets', `${name}.json`), JSON.stringify({ name, events, sid: 750000000000999 }));
  }
  const LIMIT_REACHED = 'stopped at its traversal limit (100,000 events across all event sheets), so uses further on are unknown';

  it('delete_event_sheet refuses a sheet that defines functions or globals, and deletes it with force', async () => {
    await addSheet('Lib', [fn('Spawn', 786000000000001), variable('Score', 786000000000002)]);
    await addSheet('Plain', [block(786000000000003, [setX('1', 786000000000004)])]);
    await addHugeSheet('Big');
    await startServer();

    const blocked = await call('delete_event_sheet', { name: 'Lib' });
    expect(blocked.action).toBe('delete_blocked');
    expect(blocked.message).toContain(`The check for uses of the functions and global variables the sheet defines ${LIMIT_REACHED}`);
    expect(await sheetExists('Lib')).toBe(true);

    const forced = await call('delete_event_sheet', { name: 'Lib', force: true });
    expect(forced.action).toBe('deleted');
    expect(forced.warnings).toContainEqual(expect.stringContaining(`Deleted with force=true: The check for uses of the functions and global variables the sheet defines ${LIMIT_REACHED}`));
    expect(await sheetExists('Lib')).toBe(false);

    // A sheet that defines neither needs no such check
    expect((await call('delete_event_sheet', { name: 'Plain' })).action).toBe('deleted');
  });

  it('move_events_between_sheets refuses to move an event variable into a group, and moves it with force', async () => {
    const main = await readSheet('MainSheet');
    main.events.unshift(variable('Score', 786000000000011));
    await writeFile(join(tmpDir, 'eventSheets', 'MainSheet.json'), JSON.stringify(main, null, '\t'));
    await addSheet('Other', [group('G', 786000000000012, [])]);
    await addHugeSheet('Big');
    await startServer();
    const before = await readFile(join(tmpDir, 'eventSheets', 'Other.json'), 'utf-8');
    const move = { sourceSheet: 'MainSheet', targetSheet: 'Other', sids: [786000000000011], deleteSource: true, targetGroupPath: 'G' };

    const blocked = await call('move_events_between_sheets', move);
    expect(blocked.action).toBe('move_blocked');
    expect(blocked.message).toContain(`The check for uses of the moved event variables ${LIMIT_REACHED}`);
    expect(await readFile(join(tmpDir, 'eventSheets', 'Other.json'), 'utf-8')).toBe(before);

    const forced = await call('move_events_between_sheets', { ...move, force: true });
    expect(forced.success).toBe(true);
    expect(forced.warnings).toContainEqual(expect.stringContaining(`Moved with force=true: The check for uses of the moved event variables ${LIMIT_REACHED}`));
    expect((await readSheet('Other')).events[0].children.map((e: any) => e.name)).toEqual(['Score']);

    // Events that declare no variable need no such check
    expect((await call('move_events_between_sheets', {
      sourceSheet: 'MainSheet', targetSheet: 'Other', sids: [400000000000003], deleteSource: true, targetGroupPath: 'G',
    })).success).toBe(true);
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

// ─── comment rows and function calls edited in place (#38) ──

describe('comment rows and function calls edited in place (#38)', () => {
  const BLOCK_SID = 400000000000003;

  /** MainSheet's block gets `actions` after its set-position; Heal(amount) is defined. */
  async function setUp(actions: unknown[]): Promise<void> {
    const main = await readSheet('MainSheet');
    main.events[0].actions.push(...actions);
    main.events.unshift(fn('Heal', 783000000000001, {
      functionParameters: [{ name: 'amount', type: 'number', initialValue: '0', comment: '', sid: 783000000000002 }],
    }));
    await writeFile(join(tmpDir, 'eventSheets', 'MainSheet.json'), JSON.stringify(main, null, '\t'));
    await startServer();
  }
  const blockActions = async () => (await readSheet('MainSheet')).events[1].actions;

  it('changes the text and colours of a comment row where it stands, keeping its keys', async () => {
    await setUp([
      { type: 'comment', text: 'old', 'text-color': [1, 0, 0, 1], 'background-color': [1, 1, 0.5, 1] },
      callFn('Heal', 783000000000003),
    ]);

    await call('update_event_block', { sheetName: 'MainSheet', sid: BLOCK_SID, updateActions: [{ index: 1, text: 'new' }] });
    let actions = await blockActions();
    expect(actions[1]).toEqual({ type: 'comment', text: 'new', 'text-color': [1, 0, 0, 1], 'background-color': [1, 1, 0.5, 1] });
    expect(actions[2].callFunction).toBe('Heal');

    await call('update_event_block', {
      sheetName: 'MainSheet', sid: BLOCK_SID, updateActions: [{ index: 1, 'text-color': null, 'background-color': [0, 0, 1, 1] }],
    });
    actions = await blockActions();
    expect(Object.entries(actions[1])).toEqual([['type', 'comment'], ['text', 'new'], ['background-color', [0, 0, 1, 1]]]);

    await call('update_event_block', { sheetName: 'MainSheet', sid: BLOCK_SID, updateActions: [{ index: 1, 'text-color': [0, 1, 0, 1] }] });
    expect(Object.keys((await blockActions())[1])).toEqual(['type', 'text', 'text-color', 'background-color']);
  });

  it('refuses text and colours on an action that is not a comment row, and points update_event_block_action to them', async () => {
    await setUp([{ type: 'comment', text: 'note' }]);
    expect(await callError('update_event_block', { sheetName: 'MainSheet', sid: BLOCK_SID, updateActions: [{ index: 0, text: 'x' }] }))
      .toContain('is not a comment row');
    expect(await callError('update_event_block_action', { sheetName: 'MainSheet', blockSid: BLOCK_SID, actionIndex: 1, parameters: { text: 'x' } }))
      .toContain('updateActions [{ index: 1, text, "text-color", "background-color" }]');
  });

  it('an update with the same arguments leaves a disabled call\'s keys in their order', async () => {
    const stored = { callFunction: 'Heal', sid: 783000000000003, parameters: ['5'], disabled: true };
    await setUp([stored]);
    const text = async () => JSON.stringify((await blockActions())[1]);
    const before = await text();

    await call('update_event_block', { sheetName: 'MainSheet', sid: BLOCK_SID, updateActions: [{ index: 1, parameters: ['5'] }] });
    expect(await text()).toBe(before);
    await call('update_event_block', { sheetName: 'MainSheet', sid: BLOCK_SID, updateActions: [{ index: 1, parameters: {} }] });
    expect(await text()).toBe(before);
    await call('update_event_block_action', { sheetName: 'MainSheet', blockSid: BLOCK_SID, actionIndex: 1, parameters: ['5'] });
    expect(await text()).toBe(before);

    await call('update_event_block_action', { sheetName: 'MainSheet', blockSid: BLOCK_SID, actionIndex: 1, parameters: ['7'] });
    expect(Object.entries((await blockActions())[1])).toEqual([
      ['callFunction', 'Heal'], ['sid', 783000000000003], ['parameters', ['7']], ['disabled', true],
    ]);
  });
});

// ─── function names (#38) ───────────────────────────────────

describe('function names are checked like in the editor and duplicates are reported (#38)', () => {
  const addFunction = (functionName: string, extra: Record<string, unknown> = {}, sheetName = 'MainSheet') =>
    server.callTool('add_event_to_sheet', { sheetName, eventType: 'function', functionName, ...extra });

  it('add_event_to_sheet refuses a name another function has, also only in case or in another sheet (the #38 repro)', async () => {
    await addSheet('Other', [group('Helpers', 784000000000001, [fn('Spawn', 784000000000002)])]);
    await startServer();

    expect((await addFunction('DoIt')).isError).toBeUndefined();
    expect(await callError('add_event_to_sheet', { sheetName: 'MainSheet', eventType: 'function', functionName: 'DoIt' }))
      .toContain('A function named "DoIt" already exists in sheet "MainSheet"');
    expect(await callError('add_event_to_sheet', { sheetName: 'MainSheet', eventType: 'function', functionName: 'doit' }))
      .toContain('The function "DoIt", which differs from "doit" only in case, already exists');
    expect(await callError('add_event_to_sheet', { sheetName: 'MainSheet', eventType: 'function', functionName: 'SPAWN' }))
      .toContain('already exists in sheet "Other" (events[0].children[0], SID 784000000000002)');
    expect((await readSheet('MainSheet')).events.filter((e: any) => e.eventType === 'function-block')).toHaveLength(1);
  });

  it('checks the characters only for a function with a return type, as the editor does, and refuses System expression names', async () => {
    await startServer();
    for (const name of ['Do It', 'a.b', '_x']) {
      expect((await addFunction(name)).isError, name).toBeUndefined();
      expect(await callError('add_event_to_sheet', {
        sheetName: 'MainSheet', eventType: 'function', functionName: `${name}2`, functionReturnType: 'number',
      })).toContain(`is not a valid name for a function with return type "number"`);
    }
    expect(await callError('add_event_to_sheet', { sheetName: 'MainSheet', eventType: 'function', functionName: 'Random' }))
      .toContain('is the name of the System expression "random" (ignoring case)');
    expect((await addFunction('Sprite')).isError).toBeUndefined();
  });

  it('move_events_between_sheets refuses to copy a function block, and moves it', async () => {
    await addSheet('Other', []);
    const main = await readSheet('MainSheet');
    main.events.push(fn('DoIt', 784000000000010));
    await writeFile(join(tmpDir, 'eventSheets', 'MainSheet.json'), JSON.stringify(main, null, '\t'));
    await startServer();

    expect(await callError('move_events_between_sheets', { sourceSheet: 'MainSheet', targetSheet: 'Other', sids: [784000000000010] }))
      .toContain('would leave function blocks whose names match, ignoring case:\n- "DoIt" in sheet "MainSheet" (events[1]), "DoIt" in sheet "Other" (events[0])');
    expect((await readSheet('Other')).events).toEqual([]);
    const moved = await call('move_events_between_sheets', { sourceSheet: 'MainSheet', targetSheet: 'Other', sids: [784000000000010], deleteSource: true });
    expect(moved.success).toBe(true);
  });

  it('validate_project reports function names that several function blocks have, and the analyses list each of them', async () => {
    await addSheet('Other', [fn('doit', 784000000000021)]);
    const main = await readSheet('MainSheet');
    main.events.push(fn('DoIt', 784000000000020), fn('DoIt', 784000000000024), block(784000000000022, [callFn('DoIt', 784000000000023)]));
    await writeFile(join(tmpDir, 'eventSheets', 'MainSheet.json'), JSON.stringify(main, null, '\t'));
    await startServer();

    const validation = await call('validate_project', {});
    const issue = validation.warnings.find((w: any) => w.check === 'duplicate-function-name');
    expect(issue.message).toContain('3 function blocks have the name "DoIt", ignoring case: "DoIt" in eventSheets/MainSheet at events[1] (sid 784000000000020), "DoIt" in eventSheets/MainSheet at events[2] (sid 784000000000024), "doit" in eventSheets/Other at events[0] (sid 784000000000021)');

    const map = await call('get_function_map', {});
    expect(map.functions.map((f: any) => [f.name, f.sheet, f.callCount, f.sameNameAs.length])).toEqual([
      ['DoIt', 'MainSheet', 1, 2], ['DoIt', 'MainSheet', 1, 2], ['doit', 'Other', 1, 2],
    ]);
    expect(map.summary).toMatchObject({ totalFunctions: 3, totalCallSites: 1, duplicateFunctionNames: ['DoIt'] });

    const flow = await call('get_eventsheet_flow', { format: 'json' });
    expect(flow.nodes.find((n: any) => n.name === 'MainSheet').functionCount).toBe(2);
    expect(flow.nodes.find((n: any) => n.name === 'Other').functionCount).toBe(1);
  });
});
