/**
 * Removing instance variables, behaviors and family members that events still
 * use (update_object_properties, update_family), and validate_project's
 * missing-behavior-or-variable check. Synthetic data.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MockServer } from '../mocks/mock-server.js';
import { MockReader } from '../mocks/mock-reader.js';
import { MockWriter } from '../mocks/mock-writer.js';
import { MockIdGenerator } from '../mocks/mock-id-generator.js';
import { registerObjectTools } from '../../src/tools/object-tools.js';
import { ProjectIndex, expressionMemberChains, resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { validateProjectIntegrity } from '../../src/construct3/analyzers/integrity.js';

type Json = Record<string, any>;

const variable = (name: string, sid: number) => ({ name, type: 'number', initialValue: 0, desc: '', sid });
const behavior = (name: string, sid: number, behaviorId = name) => ({ behaviorId, name, sid });
const sprite = (name: string, sid: number, extra: Json = {}): [string, Json] =>
  [name, { name, 'plugin-id': 'Sprite', sid, instanceVariables: [], behaviorTypes: [], ...extra }];
const family = (name: string, sid: number, members: string[], extra: Json = {}): [string, Json] =>
  [name, { name, 'plugin-id': 'Sprite', sid, instanceVariables: [], behaviorTypes: [], effectTypes: [], members, ...extra }];
const sheet = (events: Json[]): Map<string, Json> => new Map([['Sheet1', { name: 'Sheet1', sid: 900, events }]]);
const block = (sid: number, conditions: Json[], actions: Json[], extra: Json = {}): Json =>
  ({ eventType: 'block', sid, conditions, actions, ...extra });
const compareVar = (objectClass: string, name: string, sid: number): Json =>
  ({ id: 'compare-instance-variable', objectClass, sid, parameters: { 'instance-variable': name, comparison: 0, value: '0' } });
const setX = (objectClass: string, x: string, sid: number): Json =>
  ({ id: 'set-x', objectClass, sid, parameters: { x } });

function setup(data: Json) {
  const server = new MockServer();
  const reader = new MockReader(data);
  const writer = new MockWriter();
  const idGen = new MockIdGenerator();
  registerObjectTools({ server, reader, writer, idGen } as any);
  return { server, reader, writer };
}

const parse = (result: any) => JSON.parse(result.content[0].text);

beforeEach(() => resetProjectIndex());

describe('expressionMemberChains', () => {
  it('finds Name.member and the expression after a behavior', () => {
    expect(expressionMemberChains('Sprite1.hp + Sprite1(0).Fade.FadeInTime')).toEqual([
      { object: 'Sprite1', member: 'hp' },
      { object: 'Sprite1', member: 'Fade', next: 'FadeInTime' },
    ]);
    expect(expressionMemberChains('Self . Fade . Time')).toEqual([{ object: 'Self', member: 'Fade', next: 'Time' }]);
    expect(expressionMemberChains('"Self.hp" & max(1, 2)')).toEqual([]);
  });
});

describe('update_object_properties: removing what events use', () => {
  /** Sprite1 with hp, speed and Fade, used in several ways; Sprite2 has its own hp and Fade */
  function project(events: Json[]): Json {
    return {
      objects: new Map([
        sprite('Sprite1', 101, {
          instanceVariables: [variable('hp', 111), variable('speed', 112)],
          behaviorTypes: [behavior('Fade', 113), behavior('Sine', 114, 'Sin')],
        }),
        sprite('Sprite2', 102, { instanceVariables: [variable('hp', 121)], behaviorTypes: [behavior('Fade', 122)] }),
      ]),
      eventSheets: sheet(events),
    };
  }

  it('refuses removing an instance variable that events use, listing the uses, and changes nothing', async () => {
    const { server, reader, writer } = setup(project([
      block(1, [compareVar('Sprite1', 'hp', 2)], [
        setX('Sprite2', 'Sprite1.hp + Sprite1(0).HP', 3),
        // Self is the action's object; names in expressions are matched ignoring case
        setX('Sprite1', 'self.Hp', 4),
        { callFunction: 'Fn', sid: 5, parameters: ['sprite1.hp'] },
      ], { children: [block(6, [], [setX('System', 'Self.hp', 7)])] }),
    ]));
    const data = parse(await server.callTool('update_object_properties', { name: 'Sprite1', removeVariables: ['speed', 'hp'] }));
    expect(data).toMatchObject({ success: false, entity: 'Sprite1', category: 'object', action: 'update_blocked' });
    expect(data.message).toContain('instance variable "hp" used 4 time(s) (1 condition, 3 expression) in events of "Sheet1"');
    expect(data.message).toContain('Nothing was changed');
    expect(data.references.eventSheets).toEqual(['Sheet1']);
    expect(data.references.uses).toEqual([
      { eventSheet: 'Sheet1', path: 'block > condition:0', objectClass: 'Sprite1', kind: 'instance variable', name: 'hp', context: 'condition', form: 'instance-variable' },
      { eventSheet: 'Sheet1', path: 'block > action:0', objectClass: 'Sprite1', kind: 'instance variable', name: 'hp', context: 'expression', form: 'member-expression' },
      { eventSheet: 'Sheet1', path: 'block > action:1', objectClass: 'Sprite1', kind: 'instance variable', name: 'Hp', context: 'expression', form: 'member-expression' },
      { eventSheet: 'Sheet1', path: 'block > action:2', objectClass: 'Sprite1', kind: 'instance variable', name: 'hp', context: 'expression', form: 'member-expression' },
    ]);
    expect(writer.calls.filter(c => c.method !== 'entityFileRefusal')).toEqual([]);
    expect((await reader.readObjectType('Sprite1')).instanceVariables.map((v: Json) => v.name)).toEqual(['hp', 'speed']);
  });

  it('refuses removing a behavior used as behaviorType or as Name.Behavior.Expression', async () => {
    const { server } = setup(project([
      block(1, [{ id: 'is-fading', objectClass: 'Sprite1', behaviorType: 'Fade', sid: 2 }], [
        setX('Sprite2', 'Sprite1.Fade.FadeInTime', 3),
        { id: 'set-magnitude', objectClass: 'Sprite1', behaviorType: 'Sine', sid: 4, parameters: { magnitude: 'Self.Fade.FadeOutTime' } },
      ]),
    ]));
    const data = parse(await server.callTool('update_object_properties', { name: 'Sprite1', removeBehaviors: ['Fade'] }));
    expect(data.action).toBe('update_blocked');
    expect(data.references.uses.map((u: Json) => [u.path, u.context, u.form])).toEqual([
      ['block > condition:0', 'condition', 'behaviorType'],
      ['block > action:0', 'expression', 'behavior-expression'],
      ['block > action:1', 'expression', 'behavior-expression'],
    ]);
  });

  it('removes what no event uses: same names on other objects, System, string literals and plugin expressions do not count', async () => {
    const { server, writer } = setup(project([
      block(1, [compareVar('Sprite2', 'hp', 2), { id: 'is-fading', objectClass: 'Sprite2', behaviorType: 'Fade', sid: 3 }], [
        setX('Sprite2', 'Self.hp + Sprite2.Fade.FadeInTime + len("Sprite1.hp") + Sprite1.X', 4),
        setX('System', 'Self.hp', 5),
      ]),
    ]));
    const data = parse(await server.callTool('update_object_properties', { name: 'Sprite1', removeVariables: ['hp'], removeBehaviors: ['Fade'] }));
    expect(data.success).toBe(true);
    expect(data.warnings).toBeUndefined();
    const written = writer.callsFor('writeEntityFile')[0].args[2] as Json;
    expect(written.instanceVariables.map((v: Json) => v.name)).toEqual(['speed']);
    expect(written.behaviorTypes.map((b: Json) => b.name)).toEqual(['Sine']);
  });

  it('keeps uses that a family of the object still resolves', async () => {
    const data = project([block(1, [compareVar('Sprite1', 'hp', 2)], [setX('Sprite1', 'Self.Fade.FadeInTime', 3)])]);
    data.families = new Map([family('Family1', 130, ['Sprite1'], {
      instanceVariables: [variable('hp', 131)], behaviorTypes: [behavior('Fade', 132)],
    })]);
    const { server } = setup(data);
    const result = parse(await server.callTool('update_object_properties', { name: 'Sprite1', removeVariables: ['hp'], removeBehaviors: ['Fade'] }));
    expect(result.success).toBe(true);
  });

  it('with force removes them and warns about the uses validate_project cannot report', async () => {
    const { server, writer } = setup(project([
      block(1, [compareVar('Sprite1', 'hp', 2)], [setX('Sprite1', 'Self.hp', 3)]),
    ]));
    const data = parse(await server.callTool('update_object_properties', { name: 'Sprite1', removeVariables: ['hp'], force: true }));
    expect(data.success).toBe(true);
    expect(data.warnings[0]).toBe('Removed although events still use it: instance variable "hp" used 2 time(s) (1 condition, 1 expression) in events of "Sheet1". The uses were NOT changed.');
    expect(data.warnings[1]).toContain('validate_project reports the other uses as missing-behavior-or-variable, but will not report the 1 use(s) written as "Name.member"');
    expect(data.warnings[1]).toContain('"Sheet1" block > action:0');
    expect((writer.callsFor('writeEntityFile')[0].args[2] as Json).instanceVariables.map((v: Json) => v.name)).toEqual(['speed']);
  });
});

describe('update_family: removing what events use', () => {
  /** Family1 (hp, Fade) with members Sprite1 and Sprite2; Sprite2 declares its own hp */
  function project(events: Json[], extraFamilies: Array<[string, Json]> = []): Json {
    return {
      objects: new Map([
        sprite('Sprite1', 101),
        sprite('Sprite2', 102, { instanceVariables: [variable('hp', 121)] }),
        sprite('Sprite3', 103),
      ]),
      families: new Map([
        family('Family1', 130, ['Sprite1', 'Sprite2'], {
          instanceVariables: [variable('hp', 131), variable('armor', 132)],
          behaviorTypes: [behavior('Fade', 133)],
        }),
        ...extraFamilies,
      ]),
      eventSheets: sheet(events),
    };
  }

  it('refuses removing an instance variable used on the family or through a member that gets it only from the family', async () => {
    const { server, reader, writer } = setup(project([
      block(1, [compareVar('Family1', 'hp', 2), compareVar('Sprite1', 'hp', 3)], [
        setX('Family1', 'Self.hp + Family1.hp', 4),
        // Sprite2 declares hp itself, Sprite3 is no member: not affected
        setX('Sprite3', 'Sprite2.hp + Sprite1.hp', 5),
      ]),
    ]));
    const data = parse(await server.callTool('update_family', { name: 'Family1', removeVariables: ['hp'] }));
    expect(data).toMatchObject({ success: false, category: 'family', action: 'update_blocked' });
    expect(data.references.uses.map((u: Json) => [u.path, u.objectClass, u.context])).toEqual([
      ['block > condition:0', 'Family1', 'condition'],
      ['block > condition:1', 'Sprite1', 'condition'],
      ['block > action:0', 'Family1', 'expression'],
      ['block > action:1', 'Sprite1', 'expression'],
    ]);
    expect(data.message).toContain('instance variable "hp" through "Sprite1" used 2 time(s)');
    expect(writer.calls.filter(c => c.method === 'writeEntityFile')).toEqual([]);
    expect((await reader.readFamily('Family1')).instanceVariables.map((v: Json) => v.name)).toEqual(['hp', 'armor']);
  });

  it('removes an instance variable no event uses', async () => {
    const { server, writer } = setup(project([block(1, [compareVar('Sprite1', 'hp', 2)], [])]));
    const data = parse(await server.callTool('update_family', { name: 'Family1', removeVariables: ['armor'] }));
    expect(data.success).toBe(true);
    expect((writer.callsFor('writeEntityFile')[0].args[2] as Json).instanceVariables.map((v: Json) => v.name)).toEqual(['hp']);
  });

  it('refuses removing a member through which events use the family instance variables or behaviors', async () => {
    const { server, reader } = setup(project([
      block(1, [{ id: 'is-fading', objectClass: 'Sprite1', behaviorType: 'Fade', sid: 2 }], [
        setX('Sprite3', 'Sprite1.armor', 3),
        // Sprite2 keeps its own hp when it leaves
        setX('Sprite2', 'Self.hp', 4),
      ]),
    ]));
    const blocked = parse(await server.callTool('update_family', { name: 'Family1', removeMembers: ['Sprite1', 'Sprite2'] }));
    expect(blocked.action).toBe('update_blocked');
    expect(blocked.references.uses.map((u: Json) => [u.objectClass, u.kind, u.name])).toEqual([
      ['Sprite1', 'behavior', 'Fade'],
      ['Sprite1', 'instance variable', 'armor'],
    ]);
    expect((await reader.readFamily('Family1')).members).toEqual(['Sprite1', 'Sprite2']);

    const allowed = parse(await server.callTool('update_family', { name: 'Family1', removeMembers: ['Sprite2'] }));
    expect(allowed.success).toBe(true);
  });

  it('removes a member with a warning when events use the family itself', async () => {
    const { server, writer } = setup(project([block(1, [compareVar('Family1', 'hp', 2)], [])]));
    const data = parse(await server.callTool('update_family', { name: 'Family1', removeMembers: ['Sprite1'] }));
    expect(data.success).toBe(true);
    expect(data.warnings).toContain('Events use family "Family1" 1 time(s) (in "Sheet1"); they no longer apply to "Sprite1" once it leaves the family. '
      + 'Whether they rely on these members cannot be checked: review them.');
    expect((writer.callsFor('writeEntityFile')[0].args[2] as Json).members).toEqual(['Sprite2']);
  });

  it('keeps uses through a member that another family still provides', async () => {
    const { server } = setup(project(
      [block(1, [compareVar('Sprite1', 'armor', 2)], [])],
      [family('Family2', 140, ['Sprite1'], { instanceVariables: [variable('armor', 141)] })],
    ));
    expect(parse(await server.callTool('update_family', { name: 'Family1', removeMembers: ['Sprite1'] })).success).toBe(true);
    resetProjectIndex();
    expect(parse(await server.callTool('update_family', { name: 'Family1', removeVariables: ['armor'] })).success).toBe(true);
  });

  it('with force removes the member and names the uses left behind', async () => {
    const { server, writer } = setup(project([block(1, [compareVar('Sprite1', 'hp', 2)], [])]));
    const data = parse(await server.callTool('update_family', { name: 'Family1', removeMembers: ['Sprite1'], force: true }));
    expect(data.success).toBe(true);
    expect(data.warnings[0]).toContain('Removed although events still use it: instance variable "hp" through "Sprite1" used 1 time(s) (1 condition)');
    expect((writer.callsFor('writeEntityFile')[0].args[2] as Json).members).toEqual(['Sprite2']);
  });
});

describe('ProjectIndex.findUnresolvedMemberReferences and validate_project', () => {
  function project(events: Json[]): Json {
    return {
      objects: new Map([
        sprite('Sprite1', 101, { instanceVariables: [variable('hp', 111)], behaviorTypes: [behavior('Fade', 112)] }),
        sprite('Sprite2', 102),
      ]),
      families: new Map([family('Family1', 130, ['Sprite1', 'Sprite2'], {
        instanceVariables: [variable('armor', 131)], behaviorTypes: [behavior('Sine', 132, 'Sin')],
      })]),
      eventSheets: sheet(events),
      usedAddons: [
        { type: 'plugin', id: 'Sprite', name: 'Sprite', author: 'Scirra', bundled: true },
        { type: 'behavior', id: 'Fade', name: 'Fade', author: 'Scirra', bundled: true },
        { type: 'behavior', id: 'Sin', name: 'Sine', author: 'Scirra', bundled: true },
      ],
    };
  }

  it('reports uses of behaviors and instance variables that neither the object type nor its families have', async () => {
    const reader = new MockReader(project([
      block(1, [
        compareVar('Sprite2', 'hp', 2),
        { id: 'is-fading', objectClass: 'Sprite2', behaviorType: 'Fade', sid: 3 },
        // A family only reaches its own instance variables and behaviors
        compareVar('Family1', 'hp', 4),
      ], [
        setX('Sprite1', 'Sprite2.Fade.FadeInTime + Self.Ghost.X', 5),
        setX('Sprite1', 'Sprite1.X + Sprite2.hp', 6),
      ]),
    ]));
    const index = new ProjectIndex();
    await index.build(reader as any);
    expect(index.findUnresolvedMemberReferences().map(r => [r.path, r.objectClass, r.kind, r.name, r.form])).toEqual([
      ['block > condition:0', 'Sprite2', 'instance variable', 'hp', 'instance-variable'],
      ['block > condition:1', 'Sprite2', 'behavior', 'Fade', 'behaviorType'],
      ['block > condition:2', 'Family1', 'instance variable', 'hp', 'instance-variable'],
      ['block > action:0', 'Sprite2', 'behavior', 'Fade', 'behavior-expression'],
      ['block > action:0', 'Sprite1', 'behavior', 'Ghost', 'behavior-expression'],
    ]);

    const result = await validateProjectIntegrity(reader as any);
    const issues = result.warnings.filter(w => w.check === 'missing-behavior-or-variable');
    expect(issues.map(i => i.message)).toEqual([
      '1 use(s) of instance variable "hp" on "Sprite2", which neither "Sprite2" nor any of its families has: block > condition:0 ("instance-variable" parameter). Instance variables it has: "armor".',
      '2 use(s) of behavior "Fade" on "Sprite2", which neither "Sprite2" nor any of its families has: block > condition:1 (behaviorType), block > action:0 (expression). Behaviors it has: "Sine".',
      '1 use(s) of instance variable "hp" on family "Family1", which the family does not have (a family\'s conditions, actions and expressions only reach its own instance variables): block > condition:2 ("instance-variable" parameter). Instance variables it has: "armor".',
      '1 use(s) of behavior "Ghost" on "Sprite1", which neither "Sprite1" nor any of its families has: block > action:0 (expression). Behaviors it has: "Fade", "Sine".',
    ]);
    expect(issues.every(i => i.entity === 'eventSheets/Sheet1')).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts names from families, in any case, and does not check Name.member or the legacy key', async () => {
    const reader = new MockReader(project([
      block(1, [compareVar('Sprite2', 'armor', 2), { id: 'is-enabled', objectClass: 'Sprite1', behaviorType: 'sine', sid: 3 }], [
        setX('Sprite2', 'sprite1.FADE.FadeInTime + Self.Sine.Magnitude + Family1.Sine.Period + Sprite2.Ghost', 4),
        { id: 'start-fade', objectClass: 'Sprite2', 'behavior-type': 'Fade', sid: 5 },
      ]),
    ]));
    const result = await validateProjectIntegrity(reader as any);
    expect(result.warnings.filter(w => w.check === 'missing-behavior-or-variable')).toEqual([]);
  });

  it('reports the uses through members that a forced delete_family leaves', async () => {
    const data = project([
      block(1, [compareVar('Sprite2', 'armor', 2)], [setX('Sprite2', 'Self.armor + Sprite2.Sine.Magnitude', 3)]),
    ]);
    const { server, reader } = setup(data);
    const deleted = parse(await server.callTool('delete_family', { name: 'Family1', force: true }));
    expect(deleted.action).toBe('deleted');
    expect(deleted.warnings[1]).toContain('1 use(s) of its instance variables and behaviors through members written as "Member.name" in expressions');
    data.families.delete('Family1');
    resetProjectIndex();
    const result = await validateProjectIntegrity(reader as any);
    expect(result.warnings.filter(w => w.check === 'missing-behavior-or-variable').map(w => w.message.split(':')[0])).toEqual([
      '1 use(s) of instance variable "armor" on "Sprite2", which neither "Sprite2" nor any of its families has',
      '1 use(s) of behavior "Sine" on "Sprite2", which neither "Sprite2" nor any of its families has',
    ]);
  });

  it('reports what a forced removal leaves, except Name.member in expressions', async () => {
    const data = project([
      block(1, [compareVar('Sprite1', 'hp', 2)], [setX('Sprite1', 'Self.hp + Self.Fade.FadeInTime', 3)]),
    ]);
    const { server, reader } = setup(data);
    // MockWriter does not write through: apply the forced removal to the project data by hand
    const forced = parse(await server.callTool('update_object_properties', { name: 'Sprite1', removeVariables: ['hp'], removeBehaviors: ['Fade'], force: true }));
    expect(forced.success).toBe(true);
    (data.objects.get('Sprite1') as Json).instanceVariables = [];
    (data.objects.get('Sprite1') as Json).behaviorTypes = [];
    resetProjectIndex();
    const result = await validateProjectIntegrity(reader as any);
    expect(result.warnings.filter(w => w.check === 'missing-behavior-or-variable').map(w => w.message.split(':')[0])).toEqual([
      '1 use(s) of instance variable "hp" on "Sprite1", which neither "Sprite1" nor any of its families has',
      '1 use(s) of behavior "Fade" on "Sprite1", which neither "Sprite1" nor any of its families has',
    ]);
    expect(forced.warnings[1]).toContain('will not report the 1 use(s) written as "Name.member"');
  });
});
