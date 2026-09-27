import { describe, it, expect } from 'vitest';
import {
  collectFunctionSignatures,
  resolveCallName,
  setKeyAfterSid,
  setConditionParameters,
  functionsObjectName,
  toScriptLines,
  isLegacyScript,
  findExpressionIdentifiers,
} from '../../src/construct3/event-shapes.js';

describe('findExpressionIdentifiers', () => {
  it('returns bare names, lower-cased, once per use', () => {
    expect(findExpressionIdentifiers('Score * 2')).toEqual(['score']);
    expect(findExpressionIdentifiers('max(Score, Lives) + score')).toEqual(['score', 'lives', 'score']);
    expect(findExpressionIdentifiers('a?b:c_1')).toEqual(['a', 'b', 'c_1']);
    expect(findExpressionIdentifiers('Array.At(i, j)')).toEqual(['i', 'j']);
    expect(findExpressionIdentifiers('Functions.Twice(Score)')).toEqual(['score']);
  });

  it('skips string literals, numbers, members and names before "." or "("', () => {
    expect(findExpressionIdentifiers('"Score" & "a ""Score"" b"')).toEqual([]);
    expect(findExpressionIdentifiers('Sprite.Score + Sprite . Score')).toEqual([]);
    expect(findExpressionIdentifiers('Sprite(0).X + Self.Width')).toEqual([]);
    expect(findExpressionIdentifiers('1.5e3 + 2 + 0.5')).toEqual([]);
    expect(findExpressionIdentifiers('int (x)')).toEqual(['x']);
    expect(findExpressionIdentifiers('dt * 60')).toEqual(['dt']);
  });

  it('stops at an unterminated string literal', () => {
    expect(findExpressionIdentifiers('a & "b & c')).toEqual(['a']);
    expect(findExpressionIdentifiers('')).toEqual([]);
  });
});

const fnBlock = (functionName: string, sid: number) =>
  ({ eventType: 'function-block', functionName, sid, functionParameters: [], conditions: [], actions: [] });

describe('resolveCallName', () => {
  const signatures = collectFunctionSignatures([{ events: [fnBlock('DoThing', 1), fnBlock('other', 2)] }]);

  it('keeps a call spelled like its function', () => {
    const warnings: string[] = [];
    expect(resolveCallName('DoThing', signatures.get('dothing'), 'call', warnings)).toBe('DoThing');
    expect(warnings).toEqual([]);
  });

  it('writes the defined spelling for a call that differs only in case, with a warning', () => {
    const warnings: string[] = [];
    expect(resolveCallName('dOTHING', signatures.get('dothing'), 'call', warnings)).toBe('DoThing');
    expect(warnings).toEqual(['call: the function is defined as "DoThing", so the call was written with that spelling, as Construct 3 saves calls.']);
  });

  it('keeps an unknown function name as given (the unknown-function warning covers it)', () => {
    const warnings: string[] = [];
    expect(resolveCallName('missing', signatures.get('missing'), 'call', warnings)).toBe('missing');
    expect(warnings).toEqual([]);
  });

  it('keeps a spelling that another function block uses exactly', () => {
    const both = collectFunctionSignatures([{ events: [fnBlock('Twin', 1), fnBlock('twin', 2), fnBlock('Twin', 3)] }]);
    expect(both.get('twin')).toMatchObject({ name: 'Twin', otherSpellings: ['twin'] });
    const warnings: string[] = [];
    expect(resolveCallName('twin', both.get('twin'), 'call', warnings)).toBe('twin');
    expect(resolveCallName('TWIN', both.get('twin'), 'call', warnings)).toBe('Twin');
    expect(warnings).toHaveLength(1);
  });
});

describe('setKeyAfterSid', () => {
  it('puts disabled right after sid on a block with children and isOrBlock', () => {
    const block: Record<string, unknown> = { eventType: 'block', conditions: [], actions: [], sid: 1, children: [], isOrBlock: true };
    setKeyAfterSid(block, 'disabled', true);
    expect(Object.keys(block)).toEqual(['eventType', 'conditions', 'actions', 'sid', 'disabled', 'children', 'isOrBlock']);
  });
});

describe('setConditionParameters', () => {
  it('puts parameters added to an inverted condition before isInverted, as the editor orders them', () => {
    const cond: Record<string, unknown> = { id: 'is-visible', objectClass: 'Hero', sid: 1, isInverted: true };
    setConditionParameters(cond, { layer: '"HUD"' });
    expect(Object.keys(cond)).toEqual(['id', 'objectClass', 'sid', 'parameters', 'isInverted']);
    expect(cond.isInverted).toBe(true);
  });

  it('keeps an existing parameters key in place and appends to a condition without isInverted', () => {
    const stored: Record<string, unknown> = { id: 'x', objectClass: 'System', sid: 1, isInverted: true, parameters: { a: '1' } };
    setConditionParameters(stored, { a: '2' });
    expect(Object.keys(stored)).toEqual(['id', 'objectClass', 'sid', 'isInverted', 'parameters']);
    expect(stored.parameters).toEqual({ a: '2' });

    const plain: Record<string, unknown> = { id: 'x', objectClass: 'System', sid: 1, disabled: true };
    setConditionParameters(plain, { a: '1' });
    expect(Object.keys(plain)).toEqual(['id', 'objectClass', 'sid', 'disabled', 'parameters']);
  });
});

describe('functionsObjectName', () => {
  it('reads functionsName from the project and falls back to "Functions"', () => {
    expect(functionsObjectName({ getProject: () => ({ functionsName: 'Fn' }) })).toBe('Fn');
    expect(functionsObjectName({ getProject: () => ({}) })).toBe('Functions');
    expect(functionsObjectName({ getProject: () => ({ functionsName: '' }) })).toBe('Functions');
    expect(functionsObjectName({ getProject: () => { throw new Error('not loaded'); } })).toBe('Functions');
    expect(functionsObjectName(undefined)).toBe('Functions');
  });
});

describe('script shapes', () => {
  it('splits a string into lines and copies an array', () => {
    expect(toScriptLines('a();\r\nb();\n')).toEqual(['a();', 'b();', '']);
    const lines = ['x();'];
    expect(toScriptLines(lines)).toEqual(['x();']);
    expect(toScriptLines(lines)).not.toBe(lines);
  });

  it('flags one-string scripts and scripts without language, in actions and script events', () => {
    expect(isLegacyScript({ type: 'script', script: 'x();' })).toBe(true);
    expect(isLegacyScript({ type: 'script', script: ['x();'] })).toBe(true);
    expect(isLegacyScript({ type: 'script', language: 'javascript', script: 'x();' })).toBe(true);
    expect(isLegacyScript({ eventType: 'script', script: 'x();' })).toBe(true);
    expect(isLegacyScript({ type: 'script', language: 'javascript', script: ['x();'], disabled: true })).toBe(false);
    expect(isLegacyScript({ eventType: 'script', language: 'javascript', script: ['x();'] })).toBe(false);
    expect(isLegacyScript({ type: 'comment', text: 'x' })).toBe(false);
  });
});
