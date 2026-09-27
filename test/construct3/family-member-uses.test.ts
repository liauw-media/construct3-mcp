/**
 * The project index's uses of family instance variables and behaviors through
 * member object types (what delete_family checks besides uses by name).
 * Synthetic data.
 */

import { describe, it, expect } from 'vitest';
import { MockReader } from '../mocks/mock-reader.js';
import { ProjectIndex, expressionMemberAccesses } from '../../src/construct3/analyzers/index-builder.js';

type Json = Record<string, any>;

const sprite = (name: string, sid: number, extra: Json = {}): [string, Json] =>
  [name, { name, 'plugin-id': 'Sprite', sid, instanceVariables: [], behaviorTypes: [], ...extra }];
const family = (name: string, sid: number, members: string[], extra: Json = {}): [string, Json] =>
  [name, { name, 'plugin-id': 'Sprite', sid, instanceVariables: [], behaviorTypes: [], members, ...extra }];
const variable = (name: string, sid: number) => ({ name, type: 'number', initialValue: 0, desc: '', sid });

async function buildIndex(data: Json): Promise<ProjectIndex> {
  const index = new ProjectIndex();
  await index.build(new MockReader(data) as any);
  return index;
}

function sheetWith(actions: Json[], conditions: Json[] = []): Map<string, Json> {
  return new Map([['Sheet1', {
    name: 'Sheet1', sid: 200,
    events: [{ eventType: 'block', sid: 201, conditions, actions }],
  }]]);
}

describe('expressionMemberAccesses', () => {
  it('finds Name.member, with an instance index and whitespace', () => {
    expect(expressionMemberAccesses('Sprite1.hp + Sprite1 (0) . speed')).toEqual([['Sprite1', 'hp'], ['Sprite1', 'speed']]);
    expect(expressionMemberAccesses('Sprite1(Sprite1.Count - 1).hp')).toEqual([['Sprite1', 'hp'], ['Sprite1', 'Count']]);
    expect(expressionMemberAccesses('Sprite1.Fade.FadeInTime')).toEqual([['Sprite1', 'Fade']]);
  });

  it('skips string literals, member chains, calls without a member and unclosed parentheses', () => {
    expect(expressionMemberAccesses('"Sprite1.hp" & Other.Sprite1.hp')).toEqual([['Other', 'Sprite1']]);
    expect(expressionMemberAccesses('max(1, 2) + abs(3)')).toEqual([]);
    expect(expressionMemberAccesses('Sprite1(0.hp')).toEqual([]);
    expect(expressionMemberAccesses('1.5 + x')).toEqual([]);
  });
});

describe('ProjectIndex.getFamilyMemberUses', () => {
  const hpFamily = () => family('Family1', 120, ['Sprite1', 'Sprite2'], {
    instanceVariables: [variable('hp', 121)],
    behaviorTypes: [{ behaviorId: 'Fade', name: 'Fade', sid: 122 }],
  });

  it('records instance variable parameters, behaviors and expressions on members', async () => {
    const index = await buildIndex({
      objects: new Map([sprite('Sprite1', 101), sprite('Sprite2', 102), sprite('Sprite3', 103)]),
      families: new Map([hpFamily()]),
      eventSheets: sheetWith([
        // legacy key of older writes still names the behavior
        { id: 'start-fade', objectClass: 'Sprite2', 'behavior-type': 'Fade', sid: 203 },
        // expression on a non-member object's action, through a behavior of a member
        { id: 'set-x', objectClass: 'Sprite3', sid: 204, parameters: { x: 'Sprite2(0).Fade.FadeOutTime + Sprite3.hp' } },
        // function call with positional parameters
        { callFunction: 'Fn', sid: 205, parameters: ['Sprite1.hp'] },
      ], [
        { id: 'compare-instance-variable', objectClass: 'Sprite1', sid: 202, parameters: { 'instance-variable': 'hp', comparison: 0, value: '0' } },
      ]),
    });
    expect(index.getFamilyMemberUses('Family1')).toEqual([
      { eventSheet: 'Sheet1', path: 'block > condition:0', eventPath: 'events[0]', sid: 202, member: 'Sprite1', kind: 'instance variable', name: 'hp', context: 'condition' },
      { eventSheet: 'Sheet1', path: 'block > action:0', eventPath: 'events[0]', sid: 203, member: 'Sprite2', kind: 'behavior', name: 'Fade', context: 'action' },
      { eventSheet: 'Sheet1', path: 'block > action:1', eventPath: 'events[0]', sid: 204, member: 'Sprite2', kind: 'behavior', name: 'Fade', context: 'expression' },
      { eventSheet: 'Sheet1', path: 'block > action:2', eventPath: 'events[0]', sid: 205, member: 'Sprite1', kind: 'instance variable', name: 'hp', context: 'expression' },
    ]);
  });

  it('resolves Self in a condition or action on a member to that member', async () => {
    const index = await buildIndex({
      objects: new Map([sprite('Sprite1', 101), sprite('Sprite2', 102)]),
      families: new Map([hpFamily()]),
      eventSheets: sheetWith([
        { id: 'set-x', objectClass: 'Sprite1', sid: 203, parameters: { x: 'Self.hp' } },
        // a behavior through Self, with a behavior action and an instance index elsewhere
        { id: 'set-fade-out-time', objectClass: 'Sprite2', behaviorType: 'Fade', sid: 204, parameters: { time: 'Self . Fade.FadeInTime + Sprite1(Self.IID).X' } },
      ], [
        { id: 'compare-x', objectClass: 'Sprite2', sid: 202, parameters: { comparison: 0, 'x-co-ordinate': 'Self.hp' } },
      ]),
    });
    expect(index.getFamilyMemberUses('Family1')).toEqual([
      { eventSheet: 'Sheet1', path: 'block > condition:0', eventPath: 'events[0]', sid: 202, member: 'Sprite2', kind: 'instance variable', name: 'hp', context: 'expression' },
      { eventSheet: 'Sheet1', path: 'block > action:0', eventPath: 'events[0]', sid: 203, member: 'Sprite1', kind: 'instance variable', name: 'hp', context: 'expression' },
      { eventSheet: 'Sheet1', path: 'block > action:1', eventPath: 'events[0]', sid: 204, member: 'Sprite2', kind: 'behavior', name: 'Fade', context: 'action' },
      { eventSheet: 'Sheet1', path: 'block > action:1', eventPath: 'events[0]', sid: 204, member: 'Sprite2', kind: 'behavior', name: 'Fade', context: 'expression' },
    ]);
  });

  it('does not resolve Self on a non-member, the family itself or System, nor in a string literal', async () => {
    const index = await buildIndex({
      objects: new Map([sprite('Sprite1', 101), sprite('Sprite2', 102), sprite('Sprite3', 103)]),
      families: new Map([hpFamily()]),
      eventSheets: sheetWith([
        { id: 'set-x', objectClass: 'Sprite3', sid: 203, parameters: { x: 'Self.hp + Self.Fade.FadeInTime' } },
        // on the family, its own name is the use (not a use through a member)
        { id: 'set-x', objectClass: 'Family1', sid: 204, parameters: { x: 'Self.hp' } },
        { id: 'set-eventvar-value', objectClass: 'System', sid: 205, parameters: { variable: 'v', value: 'Self.hp' } },
        { id: 'set-x', objectClass: 'Sprite1', sid: 206, parameters: { x: 'len("Self.hp")' } },
      ]),
    });
    expect(index.getFamilyMemberUses('Family1')).toEqual([]);
  });

  it('does not count names the member declares itself or also gets from another family', async () => {
    const index = await buildIndex({
      objects: new Map([
        sprite('Sprite1', 101, { instanceVariables: [variable('hp', 105)] }),
        sprite('Sprite2', 102),
      ]),
      families: new Map([
        hpFamily(),
        family('Family2', 130, ['Sprite2'], { behaviorTypes: [{ behaviorId: 'Fade', name: 'Fade', sid: 131 }] }),
      ]),
      eventSheets: sheetWith([
        { id: 'set-x', objectClass: 'Sprite1', sid: 203, parameters: { x: 'Sprite1.hp' } },
        { id: 'start-fade', objectClass: 'Sprite2', behaviorType: 'Fade', sid: 204 },
      ], [
        { id: 'compare-instance-variable', objectClass: 'Sprite1', sid: 202, parameters: { 'instance-variable': 'hp', comparison: 0, value: '0' } },
      ]),
    });
    expect(index.getFamilyMemberUses('Family1')).toEqual([]);
    expect(index.getFamilyMemberUses('Family2')).toEqual([]);
  });

  it('does not count a use through an object that is not a member', async () => {
    const index = await buildIndex({
      objects: new Map([sprite('Sprite1', 101), sprite('Sprite2', 102), sprite('Sprite3', 103)]),
      families: new Map([hpFamily()]),
      eventSheets: sheetWith([
        { id: 'start-fade', objectClass: 'Sprite3', behaviorType: 'Fade', sid: 203 },
        { id: 'set-x', objectClass: 'Sprite3', sid: 204, parameters: { x: 'Sprite3.hp' } },
      ], [
        { id: 'compare-instance-variable', objectClass: 'Sprite3', sid: 202, parameters: { 'instance-variable': 'hp', comparison: 0, value: '0' } },
      ]),
    });
    expect(index.getFamilyMemberUses('Family1')).toEqual([]);
  });
});
