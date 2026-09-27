import { describe, it, expect } from 'vitest';
import {
  buildInstanceBehaviors,
  expectedInstanceBehaviors,
  findMissingBehaviorEntries,
  syncInstanceBehaviors,
  unknownDefaultsWarning,
} from '../../src/construct3/instance-behaviors.js';
import { BEHAVIOR_INSTANCE_DEFAULTS, createBehaviorInstanceEntry } from '../../src/construct3/templates.js';

// Synthetic data only: object Sprite1 (Tween, Pin), Family1 (Sine) and Family2 (Fade) contain it
const sprite1 = {
  name: 'Sprite1',
  behaviorTypes: [
    { behaviorId: 'Tween', name: 'Tween', sid: 1 },
    { behaviorId: 'Pin', name: 'Pin', sid: 2 },
  ],
};
const families = new Map<string, unknown>([
  ['Family1', { name: 'Family1', members: ['Sprite1'], behaviorTypes: [{ behaviorId: 'Sin', name: 'Sine', sid: 3 }] }],
  ['Family3', { name: 'Family3', members: ['Sprite2'], behaviorTypes: [{ behaviorId: 'Bullet', name: 'Bullet', sid: 4 }] }],
  ['Family2', { name: 'Family2', members: ['Sprite2', 'Sprite1'], behaviorTypes: [{ behaviorId: 'Fade', name: 'Fade', sid: 5 }] }],
]);

describe('BEHAVIOR_INSTANCE_DEFAULTS / createBehaviorInstanceEntry', () => {
  it('covers built-in behaviors by their behaviorId, with editor property ids', () => {
    expect(BEHAVIOR_INSTANCE_DEFAULTS.Tween).toEqual({ enabled: true });
    expect(BEHAVIOR_INSTANCE_DEFAULTS.Pin).toEqual({ destroy: false });
    expect(BEHAVIOR_INSTANCE_DEFAULTS.Timer).toEqual({});
    expect(Object.keys(BEHAVIOR_INSTANCE_DEFAULTS.Sin)).toEqual([
      'movement', 'wave', 'period', 'period-random', 'period-offset', 'period-offset-random',
      'magnitude', 'magnitude-random', 'enabled', 'live-preview',
    ]);
    expect(BEHAVIOR_INSTANCE_DEFAULTS.EightDir.directions).toBe('dir-8');
    for (const props of Object.values(BEHAVIOR_INSTANCE_DEFAULTS)) {
      for (const [key, value] of Object.entries(props)) {
        expect(key).toMatch(/^[a-z]+(-[a-z]+)*$/);
        expect(['string', 'number', 'boolean']).toContain(typeof value);
      }
    }
  });

  it('returns a fresh { properties } entry, flagged unknown for other ids', () => {
    const tween = createBehaviorInstanceEntry('Tween');
    expect(tween).toEqual({ entry: { properties: { enabled: true } }, known: true });
    tween.entry.properties.enabled = false;
    expect(BEHAVIOR_INSTANCE_DEFAULTS.Tween.enabled).toBe(true);

    expect(createBehaviorInstanceEntry('Custom1')).toEqual({ entry: { properties: {} }, known: false });
    // Lookup is exact: behaviorIds are case-sensitive and inherited keys do not count
    expect(createBehaviorInstanceEntry('tween').known).toBe(false);
    expect(createBehaviorInstanceEntry('toString').known).toBe(false);
  });
});

describe('expectedInstanceBehaviors', () => {
  it('lists family behaviors first (in family order), then the object\'s own', () => {
    expect(expectedInstanceBehaviors('Sprite1', sprite1, families)).toEqual([
      { name: 'Sine', behaviorId: 'Sin' },
      { name: 'Fade', behaviorId: 'Fade' },
      { name: 'Tween', behaviorId: 'Tween' },
      { name: 'Pin', behaviorId: 'Pin' },
    ]);
  });

  it('handles objects without behaviors or families and skips malformed entries', () => {
    expect(expectedInstanceBehaviors('LoneObject', { name: 'LoneObject' }, new Map())).toEqual([]);
    expect(expectedInstanceBehaviors('LoneObject', {
      behaviorTypes: [{ name: 'NoId' }, null, { behaviorId: 'Pin', name: 'Pin' }],
    }, new Map([['Broken', null]]))).toEqual([{ name: 'Pin', behaviorId: 'Pin' }]);
  });
});

describe('buildInstanceBehaviors', () => {
  const expected = expectedInstanceBehaviors('Sprite1', sprite1, families);

  it('writes default entries in order when nothing is given', () => {
    const { behaviors, warnings } = buildInstanceBehaviors('Sprite1', expected, undefined);
    expect(warnings).toEqual([]);
    expect(Object.keys(behaviors)).toEqual(['Sine', 'Fade', 'Tween', 'Pin']);
    expect(behaviors.Fade).toEqual({ properties: { ...BEHAVIOR_INSTANCE_DEFAULTS.Fade } });
  });

  it('merges flat and editor-shaped values over the defaults', () => {
    const { behaviors, warnings } = buildInstanceBehaviors('Sprite1', expected, {
      Pin: { destroy: true },
      Sine: { properties: { magnitude: 5 }, extra: 1 },
    });
    expect(warnings).toEqual([]);
    expect(behaviors.Pin).toEqual({ properties: { destroy: true } });
    expect(behaviors.Sine).toEqual({ properties: { ...BEHAVIOR_INSTANCE_DEFAULTS.Sin, magnitude: 5 }, extra: 1 });
  });

  it('keeps entries for other names after the expected ones, with a warning', () => {
    const { behaviors, warnings } = buildInstanceBehaviors('Sprite1', expected, { Ghost: { speed: 1 } });
    expect(Object.keys(behaviors)).toEqual(['Sine', 'Fade', 'Tween', 'Pin', 'Ghost']);
    expect(behaviors.Ghost).toEqual({ properties: { speed: 1 } });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"Ghost" is not defined on "Sprite1" or its families');
  });

  it('warns about values whose type differs from the property default', () => {
    const { behaviors, warnings } = buildInstanceBehaviors('Sprite1', expected, {
      Pin: { destroy: 'yes' },
      Sine: { properties: { magnitude: '5', period: 2, wave: 'triangle' } },
    });
    expect(behaviors.Pin).toEqual({ properties: { destroy: 'yes' } });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('Behavior "Sine" (Sin): "magnitude" should be a number (default 50), got "5"');
    expect(warnings[0]).not.toContain('period');
    expect(warnings[1]).toContain('Behavior "Pin" (Pin): "destroy" should be a boolean (default false), got "yes"');
  });

  it('warns once for behaviors without known defaults, unless the caller gave the entry', () => {
    const custom = [{ name: 'A', behaviorId: 'Custom1' }, { name: 'B', behaviorId: 'Custom2' }];
    const built = buildInstanceBehaviors('Sprite1', custom, { B: { speed: 3 } });
    expect(built.behaviors).toEqual({ A: { properties: {} }, B: { properties: { speed: 3 } } });
    expect(built.warnings).toHaveLength(1);
    expect(built.warnings[0]).toContain('"A" (Custom1)');
    expect(built.warnings[0]).not.toContain('"B"');
  });
});

describe('syncInstanceBehaviors', () => {
  const expected = expectedInstanceBehaviors('Sprite1', sprite1, families);

  it('adds missing entries in editor order and keeps existing ones untouched', () => {
    const tween = { properties: { enabled: false } };
    const instance: Record<string, unknown> = { behaviors: { Tween: tween, Stale: { properties: {} } } };
    const result = syncInstanceBehaviors(instance, expected, { add: ['Sine', 'Pin'] });
    expect(result).toEqual({ modified: true, added: ['Sine', 'Pin'], unknownDefaults: [] });
    const behaviors = instance.behaviors as Record<string, unknown>;
    expect(Object.keys(behaviors)).toEqual(['Sine', 'Tween', 'Pin', 'Stale']);
    expect(behaviors.Tween).toBe(tween);
    expect(behaviors.Pin).toEqual({ properties: { destroy: false } });
  });

  it('drops only names that are no longer expected', () => {
    const instance: Record<string, unknown> = {
      behaviors: { Sine: { properties: {} }, Old: { properties: {} }, Tween: { properties: {} } },
    };
    const result = syncInstanceBehaviors(instance, expected, { drop: ['Sine', 'Old'] });
    expect(result.modified).toBe(true);
    expect(Object.keys(instance.behaviors as object)).toEqual(['Sine', 'Tween']);
  });

  it('leaves the instance as it is when nothing changes', () => {
    const behaviors = { Pin: { properties: { destroy: true } } };
    const instance: Record<string, unknown> = { behaviors };
    expect(syncInstanceBehaviors(instance, expected, { add: ['Pin', 'NotExpected'], drop: ['Pin', 'Missing'] }))
      .toEqual({ modified: false, added: [], unknownDefaults: [] });
    expect(instance.behaviors).toBe(behaviors);
  });

  it('keeps the saved order of existing entries and places new ones next to their neighbours', () => {
    // Saved with the family entries in the other order than the project's family order
    const saved = (): Record<string, unknown> => ({
      behaviors: { Fade: { properties: {} }, Sine: { properties: {} }, Pin: { properties: {} } },
    });

    const ownAdded = saved();
    syncInstanceBehaviors(ownAdded, expected, { add: ['Tween'] });
    // Tween ranks after Sine and Fade: goes after the last of them, before Pin
    expect(Object.keys(ownAdded.behaviors as object)).toEqual(['Fade', 'Sine', 'Tween', 'Pin']);

    const familyFirst = [{ name: 'Flash', behaviorId: 'Flash' }, ...expected];
    const familyAdded = saved();
    syncInstanceBehaviors(familyAdded, familyFirst, { add: ['Flash'] });
    expect(Object.keys(familyAdded.behaviors as object)).toEqual(['Flash', 'Fade', 'Sine', 'Pin']);

    // Added out of order, onto an instance with only an unexpected entry
    const fresh: Record<string, unknown> = { behaviors: { Stale: { properties: {} } } };
    syncInstanceBehaviors(fresh, expected, { add: ['Pin', 'Tween', 'Sine'] });
    expect(Object.keys(fresh.behaviors as object)).toEqual(['Sine', 'Tween', 'Pin', 'Stale']);

    const dropped = saved();
    syncInstanceBehaviors(dropped, expected.filter(b => b.name !== 'Fade'), { drop: ['Fade'] });
    expect(Object.keys(dropped.behaviors as object)).toEqual(['Sine', 'Pin']);
  });

  it('creates the behaviors dict and reports behaviors without known defaults', () => {
    const custom = [{ name: 'MyCustom', behaviorId: 'Custom1' }];
    const instance: Record<string, unknown> = {};
    const result = syncInstanceBehaviors(instance, custom, { add: ['MyCustom'] });
    expect(result).toEqual({ modified: true, added: ['MyCustom'], unknownDefaults: custom });
    expect(instance.behaviors).toEqual({ MyCustom: { properties: {} } });
  });
});

describe('findMissingBehaviorEntries', () => {
  const objects = new Map<string, unknown>([['Sprite1', sprite1], ['Plain', { name: 'Plain', behaviorTypes: [] }]]);
  const full = { Sine: { properties: {} }, Fade: { properties: {} }, Tween: { properties: {} }, Pin: { properties: {} } };

  it('groups instances per layout and object type, with the missing names in editor order', () => {
    const layouts = new Map<string, unknown>([
      ['Layout A', {
        layers: [{
          instances: [
            { type: 'Sprite1', uid: 7, behaviors: { Sine: {}, Fade: {}, Tween: {} } },
            { type: 'Sprite1', uid: 8, behaviors: full },
            { type: 'Plain', uid: 9, behaviors: {} },
            { type: 'Unknown', uid: 10 },
          ],
          subLayers: [{ instances: [{ type: 'Sprite1', behaviors: { Pin: {}, Tween: {} } }] }],
        }],
      }],
      ['Layout B', { layers: [], 'nonworld-instances': [{ type: 'Sprite1', uid: 11 }] }],
      ['Layout C', { layers: [{ instances: [{ type: 'Sprite1', uid: 12, behaviors: full }] }] }],
    ]);
    expect(findMissingBehaviorEntries(layouts, objects, families)).toEqual([
      { layout: 'Layout A', objectType: 'Sprite1', uids: [7], instances: 2, missing: ['Sine', 'Fade', 'Pin'] },
      { layout: 'Layout B', objectType: 'Sprite1', uids: [11], instances: 1, missing: ['Sine', 'Fade', 'Tween', 'Pin'] },
    ]);
  });
});

describe('unknownDefaultsWarning', () => {
  it('names each behavior once and says who fills in the properties of a third-party addon', () => {
    const warning = unknownDefaultsWarning([
      { name: 'MyCustom', behaviorId: 'Custom1' },
      { name: 'MyCustom', behaviorId: 'Custom1' },
    ]);
    expect(warning.match(/"MyCustom"/g)).toHaveLength(1);
    expect(warning).toContain('For a third-party addon, Construct 3 fills in missing properties');
    expect(warning).not.toContain('case-sensitive');
    expect(warning).not.toContain('not a behavior id');
  });

  it('points out ids that are not ones the r449 editor defines', () => {
    // "Solid" differs from the editor's id "solid" only in case; "8Direction" is not an id at all
    const warning = unknownDefaultsWarning([
      { name: 'Solid', behaviorId: 'Solid' },
      { name: 'Move', behaviorId: '8Direction' },
    ]);
    expect(warning).toContain('the Construct 3 r449 editor\'s built-in behavior is "solid", not "Solid"');
    expect(warning).toContain('"8Direction" is not a behavior id the Construct 3 r449 editor defines');
  });
});
