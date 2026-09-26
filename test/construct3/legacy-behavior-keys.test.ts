/**
 * Unit tests for the legacy "behavior-type" scanner/fixer (issue #16).
 */

import { describe, it, expect } from 'vitest';
import {
  scanLegacyBehaviorKeys,
  scanLegacyBehaviorKeysInAces,
  hasOnlyLegacyBehaviorName,
} from '../../src/construct3/analyzers/legacy-behavior-keys.js';
import type { C3Event } from '../../src/construct3/types.js';

describe('scanLegacyBehaviorKeys', () => {
  it('finds legacy keys in blocks, groups, function-blocks and sub-events without mutating', () => {
    const events = [
      {
        eventType: 'group', title: 'G', children: [{
          eventType: 'block',
          conditions: [{ id: 'is-moving', objectClass: 'Car', sid: 1, 'behavior-type': 'Car' }],
          actions: [],
          children: [{
            eventType: 'block',
            conditions: [],
            actions: [{ id: 'flash', objectClass: 'Car', sid: 2, 'behavior-type': 'Flash' }],
          }],
        }],
      },
      {
        eventType: 'function-block', functionName: 'F', conditions: [],
        actions: [{ id: 'set-speed', objectClass: 'Car', sid: 3, 'behavior-type': 'Car' }],
      },
    ] as unknown as C3Event[];
    const before = JSON.stringify(events);

    const scan = scanLegacyBehaviorKeys(events);
    expect(scan.fixable.map(h => [h.kind, h.sid, h.legacyValue])).toEqual([
      ['condition', 1, 'Car'],
      ['action', 2, 'Flash'],
      ['action', 3, 'Car'],
    ]);
    expect(scan.conflicts).toEqual([]);
    expect(JSON.stringify(events)).toBe(before);
  });

  it('renames in place with apply, keeping key order', () => {
    const cond = { id: 'is-moving', objectClass: 'Car', sid: 1, 'behavior-type': 'Car', isInverted: true };
    const events = [{ eventType: 'block', conditions: [cond], actions: [] }] as unknown as C3Event[];

    scanLegacyBehaviorKeys(events, { apply: true });
    expect(Object.keys(cond)).toEqual(['id', 'objectClass', 'sid', 'behaviorType', 'isInverted']);
    expect((cond as Record<string, unknown>).behaviorType).toBe('Car');
  });

  it('reports non-string and conflicting values as conflicts and never touches them', () => {
    const bad = { id: 'a', objectClass: 'Car', sid: 1, 'behavior-type': 42 };
    const clash = { id: 'b', objectClass: 'Car', sid: 2, behaviorType: 'Car', 'behavior-type': 'Flash' };
    const events = [{ eventType: 'block', conditions: [bad], actions: [clash] }] as unknown as C3Event[];

    const scan = scanLegacyBehaviorKeys(events, { apply: true });
    expect(scan.fixable).toEqual([]);
    expect(scan.conflicts.map(c => c.sid)).toEqual([1, 2]);
    expect(bad['behavior-type']).toBe(42);
    expect(clash['behavior-type']).toBe('Flash');
  });

  it('checks names with resolve: renames matches, flags unverified ones, leaves missing ones', () => {
    const ok = { id: 'a', objectClass: 'Car', sid: 1, 'behavior-type': 'Car' };
    const unverified = { id: 'b', objectClass: 'Ghost', sid: 2, 'behavior-type': 'Car' };
    const missing = { id: 'c', objectClass: 'Car', sid: 3, 'behavior-type': 'Nope' };
    const duplicate = { id: 'd', objectClass: 'Car', sid: 4, behaviorType: 'Nope', 'behavior-type': 'Nope' };
    const events = [{ eventType: 'block', conditions: [ok, unverified, missing, duplicate], actions: [] }] as unknown as C3Event[];
    const asked: string[] = [];

    const scan = scanLegacyBehaviorKeys(events, {
      apply: true,
      resolve: (objectClass, name) => {
        asked.push(`${objectClass}/${name}`);
        if (objectClass === 'Ghost') return { status: 'unverified', message: 'could not be verified' };
        return name === 'Car' ? { status: 'ok' } : { status: 'missing', message: `no "${name}"` };
      },
    });

    expect(scan.fixable.map(h => h.sid)).toEqual([1, 2, 4]);
    expect(scan.fixable[1].warning).toBe('could not be verified');
    expect(scan.unresolved).toEqual([expect.objectContaining({ sid: 3, reason: 'no "Nope"' })]);
    // Dropping a duplicate of an existing behaviorType does not need a lookup
    expect(asked).toEqual(['Car/Car', 'Ghost/Car', 'Car/Nope']);
    expect((ok as Record<string, unknown>).behaviorType).toBe('Car');
    expect((unverified as Record<string, unknown>).behaviorType).toBe('Car');
    expect(missing['behavior-type']).toBe('Nope');
    expect('behaviorType' in missing).toBe(false);
    expect(duplicate).toEqual({ id: 'd', objectClass: 'Car', sid: 4, behaviorType: 'Nope' });
  });

  it('reports a truncated scan instead of silently missing deep ACEs', () => {
    let deepest: Record<string, unknown> = {
      eventType: 'block', conditions: [{ id: 'x', objectClass: 'Car', sid: 1, 'behavior-type': 'Car' }], actions: [],
    };
    for (let i = 0; i < 55; i++) deepest = { eventType: 'group', children: [deepest] };

    const scan = scanLegacyBehaviorKeys([deepest] as unknown as C3Event[]);
    expect(scan.fixable).toEqual([]);
    expect(scan.truncated).toBe(true);
    expect(scanLegacyBehaviorKeys([{ eventType: 'block', conditions: [], actions: [] }] as unknown as C3Event[]).truncated).toBe(false);
  });

  it('scans a flat list of ACEs', () => {
    const act = { id: 'flash', objectClass: 'Car', sid: 1, 'behavior-type': 'Flash' };
    const scan = scanLegacyBehaviorKeysInAces([act, { id: 'destroy', objectClass: 'Car', sid: 2 }], 'action', { apply: true });
    expect(scan.fixable).toEqual([{ kind: 'action', id: 'flash', objectClass: 'Car', sid: 1, legacyValue: 'Flash' }]);
    expect(act).toEqual({ id: 'flash', objectClass: 'Car', sid: 1, behaviorType: 'Flash' });
  });

  it('tells legacy-only names apart from leftovers next to a valid behaviorType', () => {
    const base = { kind: 'action' as const };
    expect(hasOnlyLegacyBehaviorName({ ...base, legacyValue: 'Car' })).toBe(true);
    expect(hasOnlyLegacyBehaviorName({ ...base, legacyValue: 'Car', behaviorType: '' })).toBe(true);
    expect(hasOnlyLegacyBehaviorName({ ...base, legacyValue: 'Car', behaviorType: 'Car' })).toBe(false);
    expect(hasOnlyLegacyBehaviorName({ ...base, legacyValue: null })).toBe(false);
  });

  it('ignores script actions of both shapes and non-object entries', () => {
    const events = [{
      eventType: 'block',
      conditions: [null, 'x'],
      actions: [
        { type: 'script', script: ['a();', 'b();'] },
        { type: 'script', script: 'c();' },
      ],
    }] as unknown as C3Event[];
    const scan = scanLegacyBehaviorKeys(events, { apply: true });
    expect(scan.fixable).toEqual([]);
    expect(scan.conflicts).toEqual([]);
  });
});
