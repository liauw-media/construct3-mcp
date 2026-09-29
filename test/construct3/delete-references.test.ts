import { describe, it, expect } from 'vitest';
import { findReferencesLeftByDelete, countDeleteReferences, namesVisibleToOtherSheets } from '../../src/construct3/analyzers/delete-references.js';

const fn = (name: string, sid: number, extra: Record<string, unknown> = {}) => ({
  functionName: name, functionReturnType: 'none', functionParameters: [],
  eventType: 'function-block', conditions: [], actions: [], sid, ...extra,
});
const variable = (name: string, sid: number) => ({ eventType: 'variable', name, type: 'number', initialValue: '0', sid });
const block = (sid: number, actions: unknown[], extra: Record<string, unknown> = {}) => ({ eventType: 'block', sid, conditions: [], actions, ...extra });
const call = (name: string) => ({ callFunction: name, sid: 900 });
const setVar = (name: string) => ({ id: 'set-eventvar-value', objectClass: 'System', sid: 901, parameters: { variable: name, value: '1' } });

function scan(sheets: Record<string, unknown[]>, deleted: object, functionsName = 'Functions') {
  return findReferencesLeftByDelete(new Map(Object.entries(sheets)), deleted, functionsName);
}

describe('findReferencesLeftByDelete — functions', () => {
  it('finds Call function actions, function maps and expression calls in other sheets, ignoring case', () => {
    const target = fn('Spawn', 10);
    const report = scan({
      A: [target],
      B: [block(20, [
        call('spawn'),
        { id: 'map-function', objectClass: 'Functions', sid: 21, parameters: { name: '"m"', string: '"s"', function: 'SPAWN' } },
        { id: 'set-x', objectClass: 'Hero', sid: 22, parameters: { x: 'Functions.Spawn(1) + functions.spawn' } },
        { callFunction: 'Other', sid: 23, parameters: ['Functions.Spawn()'] },
      ])],
    }, target);
    expect(report.functions).toHaveLength(1);
    expect(report.functions[0].name).toBe('Spawn');
    expect(report.functions[0].references.map(r => [r.kind, r.path])).toEqual([
      ['callFunction', 'block > action:0'],
      ['function-map', 'block > action:1'],
      ['expression', 'block > action:2'],
      ['expression', 'block > action:2'],
      ['expression', 'block > action:3'],
    ]);
    expect(report.functions[0].references.every(r => r.sheet === 'B' && r.sid === 20)).toBe(true);
    expect(countDeleteReferences(report)).toBe(5);
  });

  it('uses the project\'s name for the Functions object', () => {
    const target = fn('Spawn', 10);
    const events = [target, block(20, [
      { id: 'set-x', objectClass: 'Hero', sid: 21, parameters: { x: 'Fn.Spawn(1) + Functions.Spawn(2)' } },
      { id: 'map-function', objectClass: 'Functions', sid: 22, parameters: { function: 'Spawn' } },
    ])];
    const report = scan({ A: events }, target, 'Fn');
    expect(report.functions[0].references.map(r => r.kind)).toEqual(['expression']);
  });

  it('finds functions inside a deleted group and ignores references inside the deleted events', () => {
    const group = { eventType: 'group', title: 'Helpers', sid: 10, children: [
      fn('Reset', 11, { actions: [call('Reset')] }),
      block(12, [call('Reset')]),
    ] };
    const report = scan({ A: [group, block(20, [call('Reset')])] }, group);
    expect(report.functions.map(f => [f.name, f.references.map(r => r.path)])).toEqual([['Reset', ['block > action:0']]]);
    expect(scan({ A: [group] }, group).functions).toEqual([]);
  });

  it('does not report a name another function block still defines, or references that were already dangling', () => {
    const target = fn('Twin', 10);
    expect(scan({ A: [target, block(20, [call('Twin')])], B: [fn('twin', 30)] }, target).functions).toEqual([]);

    const unrelated = block(40, [call('Missing')]);
    expect(scan({ A: [unrelated, block(41, [call('Missing')])] }, unrelated).functions).toEqual([]);
  });
});

describe('findReferencesLeftByDelete — event variables', () => {
  it('finds uses of a deleted global variable in every sheet, ignoring case', () => {
    const target = variable('Score', 10);
    const report = scan({
      A: [target, block(11, [setVar('score')])],
      B: [block(20, [], { conditions: [{ id: 'compare-eventvar', objectClass: 'System', sid: 21, parameters: { variable: 'SCORE', comparison: 0, value: '0' } }] })],
    }, target);
    expect(report.variables).toHaveLength(1);
    expect(report.variables[0].references.map(r => [r.sheet, r.path, r.kind])).toEqual([
      ['A', 'block > action:0', 'event-variable'],
      ['B', 'block > condition:0', 'event-variable'],
    ]);
  });

  it('reads the "variable" parameter as a variable name only on the System event variable ACEs', () => {
    const target = variable('Score', 10);
    const report = scan({ A: [target, block(11, [
      // An addon parameter named "variable" is read as an expression like any other
      { id: 'set-eventvar-value', objectClass: 'Hero', sid: 12, parameters: { variable: 'Score', value: '1' } },
      { id: 'set-instvar-value', objectClass: 'Hero', sid: 13, parameters: { 'instance-variable': 'Score', value: '1' } },
      { id: 'toggle-boolean-eventvar', objectClass: 'System', sid: 14, parameters: { variable: 'Score' } },
    ])] }, target);
    expect(report.variables[0].references.map(r => [r.path, r.kind])).toEqual([
      ['block > action:0', 'variable-expression'],
      ['block > action:2', 'event-variable'],
    ]);
  });

  it('finds a global variable used by name in expressions, in any case and in call arguments', () => {
    const target = variable('Score', 10);
    const report = scan({
      A: [target],
      B: [block(20, [
        { id: 'set-x', objectClass: 'Hero', sid: 21, parameters: { x: 'Score * 2' } },
        { id: 'set-text', objectClass: 'Label', sid: 22, parameters: { text: '"Score: " & score' } },
        { callFunction: 'Show', sid: 23, parameters: ['max(SCORE, 1)', true] },
        { customAction: 'bump', objectClass: 'Hero', sid: 24, parameters: ['Hero.X + Score'] },
      ], { conditions: [{ id: 'compare-two-values', objectClass: 'System', sid: 25, parameters: { 'first-value': 'Score', comparison: 4, 'second-value': '10' } }] })],
    }, target);
    expect(report.variables).toHaveLength(1);
    expect(report.variables[0].references.map(r => [r.sheet, r.path, r.kind])).toEqual([
      ['B', 'block > condition:0', 'variable-expression'],
      ['B', 'block > action:0', 'variable-expression'],
      ['B', 'block > action:1', 'variable-expression'],
      ['B', 'block > action:2', 'variable-expression'],
      ['B', 'block > action:3', 'variable-expression'],
    ]);
  });

  it('does not count names in string literals, members, longer names, name parameters or other scopes', () => {
    const target = variable('Score', 10);
    const setX = (sid: number, x: string) => ({ id: 'set-x', objectClass: 'Hero', sid, parameters: { x } });
    const events = [
      target,
      block(20, [
        setX(21, '"Score"'),
        setX(22, 'Hero.Score'),
        setX(23, 'Score2 + max(Score2, 1)'),
        setX(24, 'Score(0) + Score.X'),
        { id: 'set-instvar-value', objectClass: 'Hero', sid: 25, parameters: { 'instance-variable': 'Score', value: '1' } },
        { id: 'spawn-another-object', objectClass: 'Hero', sid: 26, parameters: { object: 'Score', layer: '0', 'image-point': '0' } },
        { id: 'go-to-layout', objectClass: 'System', sid: 27, parameters: { layout: 'Score' } },
        { id: 'play', objectClass: 'Audio', sid: 28, parameters: { 'audio-file': 'score', loop: 'not-looping', volume: '0', 'tag-optional': '""' } },
      ]),
      // A function parameter of that name is what the expression uses
      fn('Uses', 30, { functionParameters: [{ name: 'Score', type: 'number' }], actions: [setX(31, 'Score + 1')] }),
      // A local variable of that name beside the using block
      { eventType: 'group', title: 'G', sid: 40, children: [variable('Score', 41), block(42, [setX(43, 'Score + 1')])] },
    ];
    expect(scan({ A: events }, target).variables).toEqual([]);

    // Another sheet's global of that name still resolves the use after the delete
    const global = variable('Score', 50);
    expect(scan({ A: [global, block(51, [setX(52, 'Score * 2')])], B: [variable('score', 60)] }, global).variables).toEqual([]);
  });

  it('finds a deleted local variable used by name beside it, but not outside its scope', () => {
    const local = variable('Tally', 11);
    const setX = (sid: number, x: string) => ({ id: 'set-x', objectClass: 'Hero', sid, parameters: { x } });
    const events = [
      { eventType: 'group', title: 'G', sid: 10, children: [local, block(12, [setX(13, 'Tally + 1')])] },
      block(20, [setX(21, 'Tally + 1')]),
    ];
    expect(scan({ A: events }, local).variables[0].references.map(r => [r.path, r.kind])).toEqual([
      ['group:G > block > action:0', 'variable-expression'],
    ]);
  });

  it('follows the scope of local variables and function parameters', () => {
    const local = variable('Tally', 11);
    const events = [
      { eventType: 'group', title: 'G', sid: 10, children: [
        block(12, [setVar('Tally')]),
        local,
        block(13, [], { children: [block(14, [setVar('tally')])] }),
      ] },
      // Outside the group the local is not in scope: already dangling, not reported
      block(20, [setVar('Tally')]),
      // A function parameter of that name is what this reference resolves to
      fn('Uses', 30, { functionParameters: [{ name: 'Tally', type: 'number' }], actions: [setVar('Tally')] }),
    ];
    const report = scan({ A: events }, local);
    expect(report.variables[0].references.map(r => r.path)).toEqual([
      'group:G > block > action:0',
      'group:G > block > block > action:0',
    ]);
  });

  it('does not report a reference that another variable of that name still resolves', () => {
    const shadow = variable('Count', 11);
    const events = [variable('Count', 1), { eventType: 'group', title: 'G', sid: 10, children: [shadow, block(12, [setVar('Count')])] }];
    expect(scan({ A: events }, shadow).variables).toEqual([]);

    const global = variable('Count', 20);
    expect(scan({ A: [global, block(21, [setVar('Count')])], B: [variable('count', 30)] }, global).variables).toEqual([]);
  });

  it('finds variables inside a deleted event and returns nothing for a delete without functions or variables', () => {
    const inner = variable('Local', 11);
    const parent = block(10, [], { children: [inner, block(12, [setVar('Local')])] });
    expect(scan({ A: [parent] }, parent).variables).toEqual([]);

    const plain = block(40, [setVar('Anything')]);
    const report = scan({ A: [plain, variable('Anything', 41)] }, plain);
    expect(report).toEqual({ functions: [], variables: [], complete: true });
  });
});

describe('namesVisibleToOtherSheets', () => {
  it('names the functions a delete removes and a top-level (global) variable', () => {
    const group = { eventType: 'group', title: 'G', sid: 50, children: [fn('Inner', 51), variable('Local', 52)] };
    expect(namesVisibleToOtherSheets(fn('Spawn', 53), true)).toEqual(['Spawn']);
    expect(namesVisibleToOtherSheets(variable('Score', 54), true)).toEqual(['Score']);
    expect(namesVisibleToOtherSheets(group, true)).toEqual(['Inner']);
  });

  it('leaves out variables that are local: not at the top level of the sheet', () => {
    expect(namesVisibleToOtherSheets(variable('Local', 55), false)).toEqual([]);
  });
});
