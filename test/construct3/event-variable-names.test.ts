import { describe, it, expect } from 'vitest';
import {
  SYSTEM_EXPRESSION_NAMES,
  SYSTEM_EXPRESSIONS_NOT_IN_R449,
  eventVariableNameUses,
  findEnclosingEvents,
  findEventVariableNameProblem,
  findNewEventVariableNameClashes,
  invalidEventVariableNameReason,
  listEventVariableDeclarations,
} from '../../src/construct3/event-variable-names.js';
import type { C3Event } from '../../src/construct3/types.js';

const variable = (name: string, sid: number): C3Event =>
  ({ eventType: 'variable', name, type: 'number', initialValue: '0', comment: '', isStatic: false, isConstant: false, sid }) as C3Event;

// Sheet "Arena": a global, two sibling groups with locals, a nested block, a function with a parameter
const damage = variable('Damage', 3);
const bonus = variable('Bonus', 5);
const choice = variable('Choice', 7);
const tally = variable('Tally', 10);
const nestedBlock = { eventType: 'block', conditions: [], actions: [], sid: 4, children: [bonus] } as unknown as C3Event;
const combat = { eventType: 'group', title: 'Combat', sid: 2, children: [damage, nestedBlock] } as unknown as C3Event;
const lobby = { eventType: 'group', title: 'Lobby', sid: 6, children: [choice] } as unknown as C3Event;
const addPoints = {
  eventType: 'function-block', functionName: 'AddPoints', sid: 8, conditions: [], actions: [],
  functionParameters: [{ name: 'Portion', type: 'number', initialValue: '0', comment: '', sid: 9 }],
  children: [tally],
} as unknown as C3Event;
const score = variable('Score', 1);
const arena: C3Event[] = [score, combat, lobby, addPoints];

// Sheet "Rules": a global, a local in a block, a function parameter
const rules: C3Event[] = [
  variable('Stage', 11),
  { eventType: 'block', conditions: [], actions: [], sid: 12, children: [variable('Countdown', 13)] } as unknown as C3Event,
  {
    eventType: 'function-block', functionName: 'Restart', sid: 14, conditions: [], actions: [],
    functionParameters: [{ name: 'Delay', type: 'number', initialValue: '0', comment: '', sid: 15 }], children: [],
  } as unknown as C3Event,
];
const sheets = new Map([['Arena', arena], ['Rules', rules]]);

const names = (uses: Array<{ name: string }>) => uses.map(u => u.name).sort();

describe('invalidEventVariableNameReason', () => {
  it('accepts names the editor keeps unchanged', () => {
    for (const name of ['Score', 'score_2', 'Gr\u00F6\u00DFe', 'x', '2ndTry']) {
      expect(invalidEventVariableNameReason(name), name).toBeUndefined();
    }
  });

  it('refuses whitespace, punctuation, a leading underscore, digits only, empty and non-NFC names', () => {
    expect(invalidEventVariableNameReason('')).toBe('it is empty');
    expect(invalidEventVariableNameReason('my score')).toBe('it contains whitespace');
    expect(invalidEventVariableNameReason('my\u00A0score')).toBe('it contains whitespace');
    expect(invalidEventVariableNameReason('hp-max')).toBe('it contains "-"');
    for (const ch of ['.', ':', '(', '$', '#', '\'', '"']) {
      expect(invalidEventVariableNameReason(`a${ch}b`), ch).toBe(`it contains "${ch}"`);
    }
    expect(invalidEventVariableNameReason('a\uFF08b')).toBe('it contains "\uFF08" (U+FF08)');
    expect(invalidEventVariableNameReason('a\u3002b')).toBe('it contains "\u3002" (U+3002)');
    expect(invalidEventVariableNameReason('a\u201Cb')).toBe('it contains "\u201C" (U+201C)');
    expect(invalidEventVariableNameReason('hp\u00ADmax')).toBe('it contains a soft hyphen (U+00AD)');
    // Only these full-width forms are removed: full-width . / - are kept by the editor
    for (const ch of ['\uFF0E', '\uFF0F', '\uFF0D']) {
      expect(invalidEventVariableNameReason(`a${ch}b`), ch).toBeUndefined();
    }
    expect(invalidEventVariableNameReason('_hidden')).toBe('it starts with an underscore');
    expect(invalidEventVariableNameReason('42')).toBe('it consists only of digits');
    expect(invalidEventVariableNameReason('Cafe\u0301')).toBe('it is not in Unicode normalization form C');
  });
});

describe('eventVariableNameUses', () => {
  it('a global variable: every variable and function parameter in every sheet', () => {
    expect(names(eventVariableNameUses(sheets, 'Arena', []))).toEqual(
      ['Bonus', 'Choice', 'Countdown', 'Damage', 'Delay', 'Portion', 'Score', 'Stage', 'Tally']);
  });

  it('a local variable: all globals, its enclosing events and everything below its parent event', () => {
    // A variable in group Combat: sees Bonus below, not Choice (sibling group) or other sheets' locals
    expect(names(eventVariableNameUses(sheets, 'Arena', [combat]))).toEqual(['Bonus', 'Damage', 'Score', 'Stage']);
    // A variable in the nested block: sees its block and the group around it
    expect(names(eventVariableNameUses(sheets, 'Arena', [combat, nestedBlock]))).toEqual(['Bonus', 'Damage', 'Score', 'Stage']);
    // A variable in the function: sees the function's parameter
    expect(names(eventVariableNameUses(sheets, 'Arena', [addPoints]))).toEqual(['Portion', 'Score', 'Stage', 'Tally']);
  });

  it('leaves out the variable being renamed, and reports kind and sheet', () => {
    const uses = eventVariableNameUses(sheets, 'Arena', [lobby], choice);
    expect(names(uses)).toEqual(['Score', 'Stage']);
    expect(eventVariableNameUses(sheets, 'Arena', [])).toContainEqual({ name: 'Delay', kind: 'function parameter', sheet: 'Rules' });
    expect(eventVariableNameUses(sheets, 'Arena', [])).toContainEqual({ name: 'Countdown', kind: 'variable', sheet: 'Rules' });
  });
});

describe('findEnclosingEvents', () => {
  it('returns the enclosing events outermost first', () => {
    expect(findEnclosingEvents(arena, score)).toEqual([]);
    expect(findEnclosingEvents(arena, bonus)).toEqual([combat, nestedBlock]);
    expect(findEnclosingEvents(arena, tally)).toEqual([addPoints]);
    expect(findEnclosingEvents(arena, variable('Bonus', 5))).toBeUndefined();
  });
});

describe('findEventVariableNameProblem', () => {
  const globalUses = eventVariableNameUses(sheets, 'Arena', []);

  it('finds a variable or function parameter ignoring case, the exact spelling first', () => {
    expect(findEventVariableNameProblem('countdown', globalUses)).toEqual(
      { problem: 'in-use', use: { name: 'Countdown', kind: 'variable', sheet: 'Rules' } });
    expect(findEventVariableNameProblem('DELAY', globalUses)).toEqual(
      { problem: 'in-use', use: { name: 'Delay', kind: 'function parameter', sheet: 'Rules' } });
  });

  it('compares with System expressions ignoring case', () => {
    expect(findEventVariableNameProblem('Time', globalUses)).toEqual({ problem: 'system-expression', expression: 'time' });
    expect(findEventVariableNameProblem('layoutname', globalUses)).toEqual({ problem: 'system-expression', expression: 'LayoutName' });
  });

  it('checks characters first, then names in use, then System expressions, like the editor dialog', () => {
    expect(findEventVariableNameProblem('_score', globalUses)?.problem).toBe('invalid');
    const uses = [{ name: 'random', kind: 'variable' as const, sheet: 'Arena' }];
    expect(findEventVariableNameProblem('Random', uses)?.problem).toBe('in-use');
  });

  it('accepts free names, names of objects included, and a case change of the own name', () => {
    expect(findEventVariableNameProblem('Coins', globalUses)).toBeUndefined();
    expect(findEventVariableNameProblem('Sprite', globalUses)).toBeUndefined();
    const renameUses = [{ name: 'SCORE', kind: 'variable' as const, sheet: 'Rules' }];
    expect(findEventVariableNameProblem('score', renameUses, 'Score')).toBeUndefined();
    expect(findEventVariableNameProblem('score', renameUses)?.problem).toBe('in-use');
  });

  it('lists each System expression once, ignoring case', () => {
    const keys = SYSTEM_EXPRESSION_NAMES.map(n => n.toLowerCase());
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(136);
  });
});

describe('System expressions and releases', () => {
  it('names the five r495.2 System expressions that r449 does not have', () => {
    expect([...SYSTEM_EXPRESSIONS_NOT_IN_R449].sort()).toEqual(
      ['ColorToHexString', 'HexColor', 'ProjectFileCount', 'ProjectFileNameAt', 'distance3d']);
    for (const name of SYSTEM_EXPRESSIONS_NOT_IN_R449) expect(SYSTEM_EXPRESSION_NAMES).toContain(name);
  });
});

describe('function parameters', () => {
  const portion = (addPoints as unknown as { functionParameters: object[] }).functionParameters[0];

  it('a parameter has the scope of a local variable declared directly in its function', () => {
    const uses = eventVariableNameUses(sheets, 'Arena', [addPoints], portion);
    expect(names(uses)).toEqual(['Score', 'Stage', 'Tally']);
    expect(findEventVariableNameProblem('stage', uses)).toEqual(
      { problem: 'in-use', use: { name: 'Stage', kind: 'variable', sheet: 'Rules' } });
    // Parameters of other functions and locals elsewhere are out of scope
    expect(findEventVariableNameProblem('Delay', uses)).toBeUndefined();
    expect(findEventVariableNameProblem('Choice', uses)).toBeUndefined();
  });
});

describe('listEventVariableDeclarations', () => {
  it('lists variables and parameters in document order with their enclosing events', () => {
    const found = listEventVariableDeclarations(arena);
    expect(found.map(d => [d.name, d.kind, d.parents.length])).toEqual([
      ['Score', 'variable', 0],
      ['Damage', 'variable', 1],
      ['Bonus', 'variable', 2],
      ['Choice', 'variable', 1],
      ['Portion', 'function parameter', 1],
      ['Tally', 'variable', 1],
    ]);
    expect(found[2].parents).toEqual([combat, nestedBlock]);
    expect(found[4].parents).toEqual([addPoints]);
    expect(found[4].declaration).toBe((addPoints as unknown as { functionParameters: object[] }).functionParameters[0]);
    expect(listEventVariableDeclarations([bonus], [combat, nestedBlock])[0].parents).toEqual([combat, nestedBlock]);
  });
});

describe('findNewEventVariableNameClashes', () => {
  const copyOf = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const group = (title: string, sid: number, children: C3Event[]) =>
    ({ eventType: 'group', title, sid, children }) as unknown as C3Event;

  it('finds a copy of a global variable in another sheet: the original keeps the name', () => {
    const copy = copyOf(score);
    const after = new Map([['Arena', arena], ['Rules', [...rules, copy]]]);
    const clashes = findNewEventVariableNameClashes(sheets, 'Arena', [score], after, 'Rules', [copy]);
    expect(clashes).toHaveLength(1);
    expect(clashes[0].declaration.name).toBe('Score');
    expect(clashes[0].declaration.parents).toEqual([]);
    expect(clashes[0].use).toEqual({ name: 'Score', kind: 'variable', sheet: 'Arena' });
  });

  it('accepts moving a global variable, and copying a function or a group with locals to another sheet', () => {
    const moved = copyOf(score);
    const afterMove = new Map([['Arena', arena.filter(e => e !== score)], ['Rules', [...rules, moved]]]);
    expect(findNewEventVariableNameClashes(sheets, 'Arena', [score], afterMove, 'Rules', [moved])).toEqual([]);

    const fnCopy = copyOf(addPoints);
    const groupCopy = copyOf(combat);
    const afterCopy = new Map([['Arena', arena], ['Rules', [...rules, fnCopy, groupCopy]]]);
    expect(findNewEventVariableNameClashes(sheets, 'Arena', [addPoints, combat], afterCopy, 'Rules', [fnCopy, groupCopy]))
      .toEqual([]);
  });

  it('finds a local that clashes with a variable of the group it is moved into', () => {
    const before = new Map([['Arena', arena], ['Rules', [...rules, group('Setup', 20, [variable('choice', 21)])]]]);
    const moved = copyOf(lobby);
    const after = new Map([
      ['Arena', arena.filter(e => e !== lobby)],
      ['Rules', [...rules, group('Setup', 20, [variable('choice', 21), moved])]],
    ]);
    const clashes = findNewEventVariableNameClashes(before, 'Arena', [lobby], after, 'Rules', [moved]);
    expect(clashes.map(c => [c.declaration.name, c.declaration.parents.length, c.use.name])).toEqual([['Choice', 2, 'choice']]);
  });

  it('finds a function parameter that clashes with a variable of the group the function is copied into', () => {
    const before = new Map([['Arena', arena], ['Rules', [...rules, group('Setup', 20, [variable('PORTION', 21)])]]]);
    const fnCopy = copyOf(addPoints);
    const after = new Map([['Arena', arena], ['Rules', [...rules, group('Setup', 20, [variable('PORTION', 21), fnCopy])]]]);
    const clashes = findNewEventVariableNameClashes(before, 'Arena', [addPoints], after, 'Rules', [fnCopy]);
    expect(clashes.map(c => [c.declaration.kind, c.declaration.name, c.use.name]))
      .toEqual([['function parameter', 'Portion', 'PORTION']]);
  });

  it('does not count a clash that was already there before the move', () => {
    const level = variable('Level', 30);
    const before = new Map([['Arena', [level]], ['Rules', [variable('LEVEL', 31)]]]);
    const moved = copyOf(level);
    const after = new Map([['Arena', [] as C3Event[]], ['Rules', [variable('LEVEL', 31), moved]]]);
    expect(findNewEventVariableNameClashes(before, 'Arena', [level], after, 'Rules', [moved])).toEqual([]);
  });
});
