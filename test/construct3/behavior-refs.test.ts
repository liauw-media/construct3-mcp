/**
 * Unit tests for behaviorType resolution (issue #16).
 * Data mirrors real C3 projects (mapsandapps/construct-3-games battlelands):
 * Player has EightDir named "8Direction"; family Entities (Player, Enemy) has Tween.
 */

import { describe, it, expect } from 'vitest';
import { checkBehaviorName } from '../../src/construct3/analyzers/behavior-refs.js';
import type { BehaviorLookupData } from '../../src/construct3/analyzers/behavior-refs.js';

function lookup(overrides: Partial<BehaviorLookupData> = {}): BehaviorLookupData {
  return {
    objectNames: new Set(['Player', 'Enemy', 'Wall']),
    familyNames: new Set(['Entities']),
    objectTypes: new Map<string, unknown>([
      ['Player', { name: 'Player', behaviorTypes: [
        { behaviorId: 'MoveTo', name: 'MoveTo', sid: 11 },
        { behaviorId: 'EightDir', name: '8Direction', sid: 12 },
      ] }],
      ['Enemy', { name: 'Enemy', behaviorTypes: [] }],
      ['Wall', { name: 'Wall' }],
    ]),
    families: new Map<string, unknown>([
      ['Entities', { name: 'Entities', members: ['Player', 'Enemy'], behaviorTypes: [{ behaviorId: 'Tween', name: 'Tween', sid: 41 }] }],
    ]),
    ...overrides,
  };
}

describe('checkBehaviorName', () => {
  it('accepts behaviors on the object type and on its families', () => {
    expect(checkBehaviorName('Player', '8Direction', lookup())).toEqual({ status: 'ok' });
    expect(checkBehaviorName('Enemy', 'Tween', lookup())).toEqual({ status: 'ok' });
    expect(checkBehaviorName('Entities', 'Tween', lookup())).toEqual({ status: 'ok' });
  });

  it('reports a behaviorId with a hint to the behavior name', () => {
    const check = checkBehaviorName('Player', 'EightDir', lookup());
    expect(check.status).toBe('missing');
    expect(check.status !== 'ok' && check.message).toContain('Did you mean the behavior name "8Direction"');
  });

  it('checks a family objectClass against the family behaviors only', () => {
    const check = checkBehaviorName('Entities', '8Direction', lookup());
    expect(check.status).toBe('missing');
    expect(check.status !== 'ok' && check.message).toContain('family "Entities"');
  });

  it('reports System and unknown objectClasses as missing', () => {
    const system = checkBehaviorName('System', 'Platform', lookup());
    expect(system.status !== 'ok' && system.message).toContain('System has no behaviors');
    const unknown = checkBehaviorName('Nobody', 'Platform', lookup());
    expect(unknown.status).toBe('missing');
    expect(unknown.status !== 'ok' && unknown.message).toContain('not an object type or family');
  });

  it('reports an unreadable object type as unverified', () => {
    const data = lookup({ objectTypes: new Map() });
    const check = checkBehaviorName('Player', '8Direction', data);
    expect(check.status).toBe('unverified');
    expect(check.status !== 'ok' && check.message).toContain('object type file unreadable');
  });

  it('reports an unreadable family as unverified, not as "available: none"', () => {
    const data = lookup({ families: new Map() });
    const family = checkBehaviorName('Entities', 'Tween', data);
    expect(family.status).toBe('unverified');
    expect(family.status !== 'ok' && family.message).toContain('family file unreadable');

    // Not on the object, and a family that might hold it could not be read
    const member = checkBehaviorName('Enemy', 'Tween', data);
    expect(member.status).toBe('unverified');
    expect(member.status !== 'ok' && member.message).toContain('1 family file(s) could not be read');

    // Found on the object itself: no need for the families
    expect(checkBehaviorName('Player', 'MoveTo', data)).toEqual({ status: 'ok' });
  });
});
