/**
 * Unit tests for project integrity validation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cp, mkdtemp, mkdir, readFile, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { MockReader } from '../mocks/mock-reader.js';
import { MockServer } from '../mocks/mock-server.js';
import { registerAnalysisTools } from '../../src/tools/analysis.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { validateProjectIntegrity } from '../../src/construct3/analyzers/integrity.js';
import { getProjectIndex, resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { findOrphanedObjects, getObjectDependencies } from '../../src/construct3/analyzers/object-deps.js';
import { analyzePerformance } from '../../src/construct3/analyzers/performance.js';
import { getEventSheetFlow } from '../../src/construct3/analyzers/event-flow.js';
import { getAssetUsage } from '../../src/construct3/analyzers/asset-usage.js';

// Cast MockReader to 'any' since it implements the same interface as Construct3ProjectReader
// but is not a class instance of it.
function createReader(data: ConstructorParameters<typeof MockReader>[0] = {}) {
  return new MockReader(data) as any;
}

/** Minimal valid project data */
function validProject() {
  return createReader({
    objects: new Map([
      ['Sprite', { name: 'Sprite', 'plugin-id': 'Sprite', sid: 100 }],
    ]),
    eventSheets: new Map([
      ['MainSheet', { name: 'MainSheet', events: [], sid: 200 }],
    ]),
    layouts: new Map([
      ['Layout 1', {
        name: 'Layout 1',
        sid: 300,
        eventSheet: 'MainSheet',
        layers: [{
          name: 'Main',
          sid: 301,
          instances: [{ type: 'Sprite', uid: 0, sid: 302, properties: {} }],
        }],
      }],
    ]),
    usedAddons: [
      { type: 'plugin', id: 'Sprite', name: 'Sprite', author: 'Scirra', bundled: false },
    ],
  });
}

describe('validateProjectIntegrity', () => {
  beforeEach(() => {
    resetProjectIndex();
  });

  // ─── Clean project ───────────────────────────────────────

  it('returns valid: true for a clean project', async () => {
    const reader = validProject();
    const result = await validateProjectIntegrity(reader);
    expect(result.valid).toBe(true);
    expect(result.summary.errors).toBe(0);
    expect(result.summary.checksRun).toBe(25);
    expect(result.summary.entitiesScanned).toBeGreaterThan(0);
  });

  // ─── Check 1: file-existence ─────────────────────────────

  it('detects missing object file', async () => {
    const reader = validProject();
    reader.registerEntityName('objects', 'MissingSprite');
    const result = await validateProjectIntegrity(reader);
    expect(result.valid).toBe(false);
    const err = result.errors.find(e => e.check === 'file-existence' && e.entity.includes('MissingSprite'));
    expect(err).toBeDefined();
    expect(err!.message).toContain('missing or contains invalid JSON');
  });

  it('detects missing event sheet file', async () => {
    const reader = validProject();
    reader.registerEntityName('eventSheets', 'GhostSheet');
    const result = await validateProjectIntegrity(reader);
    expect(result.valid).toBe(false);
    const err = result.errors.find(e => e.check === 'file-existence' && e.entity.includes('GhostSheet'));
    expect(err).toBeDefined();
  });

  it('detects missing layout file', async () => {
    const reader = validProject();
    reader.registerEntityName('layouts', 'GhostLayout');
    const result = await validateProjectIntegrity(reader);
    expect(result.valid).toBe(false);
    const err = result.errors.find(e => e.check === 'file-existence' && e.entity.includes('GhostLayout'));
    expect(err).toBeDefined();
  });

  // ─── Check 2: required-fields ────────────────────────────

  it('detects missing plugin-id on object', async () => {
    const reader = createReader({
      objects: new Map([
        ['BadObj', { name: 'BadObj', sid: 100 }],
      ]),
      eventSheets: new Map([
        ['MainSheet', { name: 'MainSheet', events: [], sid: 200 }],
      ]),
      layouts: new Map([
        ['Layout 1', { name: 'Layout 1', sid: 300, layers: [{ name: 'Main', sid: 301, instances: [] }] }],
      ]),
    });
    const result = await validateProjectIntegrity(reader);
    expect(result.valid).toBe(false);
    const err = result.errors.find(e => e.check === 'required-fields' && e.entity.includes('BadObj'));
    expect(err).toBeDefined();
    expect(err!.message).toContain('plugin-id');
  });

  it('detects missing events array on event sheet', async () => {
    const reader = createReader({
      objects: new Map([
        ['Sprite', { name: 'Sprite', 'plugin-id': 'Sprite', sid: 100 }],
      ]),
      eventSheets: new Map([
        ['BadSheet', { name: 'BadSheet', sid: 200 }], // missing events
      ]),
      layouts: new Map([
        ['Layout 1', { name: 'Layout 1', sid: 300, layers: [{ name: 'Main', sid: 301, instances: [] }] }],
      ]),
    });
    const result = await validateProjectIntegrity(reader);
    expect(result.valid).toBe(false);
    const err = result.errors.find(e => e.check === 'required-fields' && e.entity.includes('BadSheet'));
    expect(err).toBeDefined();
    expect(err!.message).toContain('events');
  });

  it('detects missing layers on layout', async () => {
    const reader = createReader({
      objects: new Map([
        ['Sprite', { name: 'Sprite', 'plugin-id': 'Sprite', sid: 100 }],
      ]),
      eventSheets: new Map([
        ['MainSheet', { name: 'MainSheet', events: [], sid: 200 }],
      ]),
      layouts: new Map([
        ['BadLayout', { name: 'BadLayout', sid: 300 }], // missing layers
      ]),
    });
    const result = await validateProjectIntegrity(reader);
    expect(result.valid).toBe(false);
    const err = result.errors.find(e => e.check === 'required-fields' && e.entity.includes('BadLayout'));
    expect(err).toBeDefined();
    expect(err!.message).toContain('layers');
  });

  it('detects missing sid on layout', async () => {
    const reader = createReader({
      objects: new Map(),
      eventSheets: new Map([
        ['MainSheet', { name: 'MainSheet', events: [], sid: 200 }],
      ]),
      layouts: new Map([
        ['NoSidLayout', { name: 'NoSidLayout', layers: [{ name: 'Main', sid: 301, instances: [] }] }],
      ]),
    });
    const result = await validateProjectIntegrity(reader);
    expect(result.valid).toBe(false);
    const err = result.errors.find(e => e.check === 'required-fields' && e.message.includes('sid'));
    expect(err).toBeDefined();
  });

  // ─── Check 3: name-consistency ───────────────────────────

  it('detects name mismatch in object', async () => {
    const reader = createReader({
      objects: new Map([
        ['Sprite', { name: 'WrongName', 'plugin-id': 'Sprite', sid: 100 }],
      ]),
      eventSheets: new Map([
        ['MainSheet', { name: 'MainSheet', events: [], sid: 200 }],
      ]),
      layouts: new Map([
        ['Layout 1', { name: 'Layout 1', sid: 300, layers: [{ name: 'Main', sid: 301, instances: [] }] }],
      ]),
    });
    const result = await validateProjectIntegrity(reader);
    expect(result.valid).toBe(false);
    const err = result.errors.find(e => e.check === 'name-consistency');
    expect(err).toBeDefined();
    expect(err!.message).toContain('WrongName');
    expect(err!.message).toContain('Sprite');
  });

  it('detects name mismatch in event sheet', async () => {
    const reader = createReader({
      objects: new Map(),
      eventSheets: new Map([
        ['MainSheet', { name: 'OtherName', events: [], sid: 200 }],
      ]),
      layouts: new Map([
        ['Layout 1', { name: 'Layout 1', sid: 300, layers: [{ name: 'Main', sid: 301, instances: [] }] }],
      ]),
    });
    const result = await validateProjectIntegrity(reader);
    const err = result.errors.find(e => e.check === 'name-consistency' && e.entity.includes('MainSheet'));
    expect(err).toBeDefined();
    expect(err!.message).toContain('OtherName');
  });

  // ─── Check 3c: legacy-behavior-key (issue #16) ───────────

  function projectWithSheet(events: unknown[]) {
    return createReader({
      objects: new Map([
        ['Car', {
          name: 'Car', 'plugin-id': 'Sprite', sid: 100,
          behaviorTypes: [{ behaviorId: 'Car', name: 'Car', sid: 101 }, { behaviorId: 'Flash', name: 'Flash', sid: 102 }],
        }],
      ]),
      eventSheets: new Map([['MainSheet', { name: 'MainSheet', sid: 200, events }]]),
      layouts: new Map([['Layout 1', { name: 'Layout 1', sid: 300, layers: [{ name: 'Main', sid: 301, instances: [] }] }]]),
    });
  }

  it('reports legacy "behavior-type" keys as an error', async () => {
    const reader = projectWithSheet([{
      eventType: 'group', title: 'G', sid: 210, children: [{
        eventType: 'block', sid: 211,
        conditions: [{ id: 'is-moving', objectClass: 'Car', sid: 212, 'behavior-type': 'Car' }],
        actions: [{ id: 'flash', objectClass: 'Car', sid: 213, 'behavior-type': 'Flash' }],
      }],
    }]);
    const result = await validateProjectIntegrity(reader);
    expect(result.valid).toBe(false);
    const errs = result.errors.filter(e => e.check === 'legacy-behavior-key');
    expect(errs).toHaveLength(1); // one entry per sheet
    expect(errs[0].entity).toBe('eventSheets/MainSheet');
    expect(errs[0].message).toContain('2 condition(s)/action(s)');
    expect(errs[0].message).toContain('action "flash" on "Car" (SID 213)');
    expect(errs[0].message).not.toContain('cannot be renamed');
    expect(errs[0].suggestion).toContain('fix_legacy_behavior_keys');
  });

  it('reports a legacy key next to an identical behaviorType as a warning, not an error', async () => {
    const reader = projectWithSheet([{
      eventType: 'block', sid: 211,
      conditions: [{ id: 'is-moving', objectClass: 'Car', sid: 212, behaviorType: 'Car', 'behavior-type': 'Car' }],
      actions: [],
    }]);
    const result = await validateProjectIntegrity(reader);
    expect(result.valid).toBe(true);
    expect(result.errors.filter(e => e.check === 'legacy-behavior-key')).toHaveLength(0);
    const warn = result.warnings.find(e => e.check === 'legacy-behavior-key');
    expect(warn!.message).toContain('condition "is-moving" on "Car" (SID 212): same value as "behaviorType"');
    expect(warn!.message).not.toContain('fails to open');
    expect(warn!.suggestion).toContain('fix_legacy_behavior_keys');
  });

  it('describes conflicts by their reason and does not point them to the fix tool', async () => {
    const reader = projectWithSheet([{
      eventType: 'block', sid: 211,
      conditions: [{ id: 'is-moving', objectClass: 'Car', sid: 6, 'behavior-type': null }],
      actions: [{ id: 'flash', objectClass: 'Car', sid: 7, behaviorType: 'Flash', 'behavior-type': 'Car' }],
    }]);
    const result = await validateProjectIntegrity(reader);
    expect(result.valid).toBe(true);
    const warn = result.warnings.find(e => e.check === 'legacy-behavior-key')!;
    expect(warn.message).toContain('condition "is-moving" on "Car" (SID 6): "behavior-type" holds null, not a behavior name');
    expect(warn.message).toContain('"behaviorType" "Flash" and "behavior-type" "Car" disagree');
    expect(warn.message).not.toContain('also carry a conflicting');
    expect(warn.suggestion).not.toContain('fix_legacy_behavior_keys');
    expect(warn.suggestion).toContain('by hand');
  });

  it('calls out legacy names that match no behavior, which renaming alone cannot fix', async () => {
    const reader = projectWithSheet([{
      eventType: 'block', sid: 211,
      conditions: [{ id: 'is-moving', objectClass: 'Car', sid: 212, 'behavior-type': 'Car' }],
      actions: [{ id: 'flash', objectClass: 'Car', sid: 213, 'behavior-type': 'flash' }],
    }]);
    const result = await validateProjectIntegrity(reader);
    expect(result.valid).toBe(false);
    const err = result.errors.find(e => e.check === 'legacy-behavior-key')!;
    expect(err.message).toContain('2 condition(s)/action(s)');
    expect(err.message).toContain('1 of them cannot be renamed automatically');
    expect(err.message).toContain('Did you mean "Flash"?');
    expect(err.suggestion).toContain('fix_legacy_behavior_keys');
    expect(err.suggestion).toContain('on 1 of them');
    expect(err.suggestion).toContain('by hand');
  });

  it('does not suggest the fix tool when no legacy name can be renamed', async () => {
    const reader = projectWithSheet([{
      eventType: 'block', sid: 211,
      conditions: [],
      actions: [{ id: 'flash', objectClass: 'Car', sid: 213, 'behavior-type': 'Blink' }],
    }]);
    const result = await validateProjectIntegrity(reader);
    const err = result.errors.find(e => e.check === 'legacy-behavior-key')!;
    expect(err.message).toContain('available: Car, Flash');
    expect(err.suggestion).not.toContain('fix_legacy_behavior_keys');
  });

  it('warns when the legacy-key scan hits its depth limit', async () => {
    let deepest: Record<string, unknown> = { eventType: 'block', sid: 9000, conditions: [], actions: [] };
    for (let i = 0; i < 55; i++) {
      deepest = { eventType: 'group', title: `G${i}`, sid: 8000 + i, children: [deepest] };
    }
    const result = await validateProjectIntegrity(projectWithSheet([deepest]));
    const warn = result.warnings.find(e => e.check === 'legacy-behavior-key');
    expect(warn!.message).toContain('size limit');
  });

  it('does not report behaviorType keys', async () => {
    const reader = projectWithSheet([{
      eventType: 'block', sid: 211,
      conditions: [{ id: 'is-moving', objectClass: 'Car', sid: 212, behaviorType: 'Car' }],
      actions: [
        { id: 'flash', objectClass: 'Car', sid: 213, behaviorType: 'Flash' },
        { type: 'script', script: ['const a = 1;', 'const b = 2;'] },
      ],
    }]);
    const result = await validateProjectIntegrity(reader);
    expect(result.errors.filter(e => e.check === 'legacy-behavior-key')).toHaveLength(0);
  });

  // ─── Check 3d: legacy-event-shape ────────────────────────

  it('warns about isElse, isOr and old-shape function calls left by older versions', async () => {
    const reader = projectWithSheet([
      { eventType: 'block', sid: 210, conditions: [{ id: 'every-tick', objectClass: 'System', sid: 211 }], actions: [] },
      { eventType: 'block', sid: 212, conditions: [], actions: [], isElse: true },
      {
        eventType: 'block', sid: 213,
        conditions: [
          { id: 'compare-two-values', objectClass: 'System', sid: 214 },
          { id: 'compare-two-values', objectClass: 'System', sid: 215, isOr: true },
        ],
        actions: [{ id: 'call-function', objectClass: 'System', sid: 216, parameters: { 0: '1' }, callFunction: 'fn1' }],
      },
      { eventType: 'block', sid: 217, conditions: [{ id: 'every-tick', objectClass: 'System', sid: 218 }], actions: [], isElse: true },
    ]);
    const result = await validateProjectIntegrity(reader);
    expect(result.valid).toBe(true);
    const warns = result.warnings.filter(e => e.check === 'legacy-event-shape');
    expect(warns).toHaveLength(1); // one entry per sheet
    expect(warns[0].entity).toMatch(/^eventSheets\//);
    expect(warns[0].message).toContain('4 event(s)/call(s)');
    expect(warns[0].message).toContain('block-level "isElse" at events[1] (SID 212)');
    expect(warns[0].message).toContain('per-condition "isOr" at events[2] (SID 213)');
    expect(warns[0].message).toContain('System "else" first condition');
    expect(warns[0].suggestion).toContain('fix_legacy_event_shapes');
    expect(warns[0].suggestion).toContain('convert 3 of them');
    expect(warns[0].suggestion).toContain('1 need a decision by hand');
    expect(warns[0].suggestion).toContain('else-if');
    expect(warns[0].suggestion).toContain('2 of the conversions (else and OR blocks) can change how the event runs');
  });

  it('warns about script actions stored as one string without language', async () => {
    const reader = projectWithSheet([
      {
        eventType: 'block', sid: 210, conditions: [{ id: 'every-tick', objectClass: 'System', sid: 211 }],
        actions: [{ type: 'script', script: 'a();\nb();' }],
      },
    ]);
    const result = await validateProjectIntegrity(reader);
    const warns = result.warnings.filter(e => e.check === 'legacy-event-shape');
    expect(warns).toHaveLength(1);
    expect(warns[0].message).toContain('script in the old shape at events[0].actions[0]');
    expect(warns[0].message).toContain('script: [lines]');
    expect(warns[0].suggestion).toContain('convert 1 of them');
    expect(warns[0].suggestion).not.toContain('can change how the event runs');
  });

  it('attributes one-string scripts to older Construct 3 releases, not only to this server, and does not call them risky', async () => {
    const scriptOnly = projectWithSheet([
      {
        eventType: 'block', sid: 210, conditions: [{ id: 'every-tick', objectClass: 'System', sid: 211 }],
        actions: [{ type: 'script', script: 'a();' }],
      },
    ]);
    const [scriptWarning] = (await validateProjectIntegrity(scriptOnly)).warnings.filter(e => e.check === 'legacy-event-shape');
    expect(scriptWarning.message).toContain('1 script(s) are stored as one string or without "language"');
    expect(scriptWarning.message).toContain('older Construct 3 releases');
    expect(scriptWarning.message).toContain('harmless');
    expect(scriptWarning.message).not.toContain('never writes');
    expect(scriptWarning.message).not.toContain('may not run as intended');
    expect(scriptWarning.message).not.toContain('event(s)/call(s)');

    const elseOnly = projectWithSheet([
      { eventType: 'block', sid: 210, conditions: [{ id: 'every-tick', objectClass: 'System', sid: 211 }], actions: [] },
      { eventType: 'block', sid: 212, conditions: [], actions: [], isElse: true },
    ]);
    const [elseWarning] = (await validateProjectIntegrity(elseOnly)).warnings.filter(e => e.check === 'legacy-event-shape');
    expect(elseWarning.message).toContain('1 event(s)/call(s) use shapes written by construct3-mcp 1.8.1 and earlier that Construct 3 itself never writes');
    expect(elseWarning.message).toContain('may not run as intended');
    expect(elseWarning.message).not.toContain('older Construct 3 releases');

    const both = projectWithSheet([
      { eventType: 'block', sid: 210, conditions: [{ id: 'every-tick', objectClass: 'System', sid: 211 }], actions: [] },
      { eventType: 'block', sid: 212, conditions: [], actions: [{ type: 'script', script: ['a();'] }], isElse: true },
    ]);
    const bothWarnings = (await validateProjectIntegrity(both)).warnings.filter(e => e.check === 'legacy-event-shape');
    expect(bothWarnings).toHaveLength(1);
    expect(bothWarnings[0].message).toContain('1 event(s)/call(s) use shapes written by construct3-mcp 1.8.1 and earlier');
    expect(bothWarnings[0].message).toContain('block-level "isElse" at events[1] (SID 212)');
    expect(bothWarnings[0].message).toContain('1 script(s) are stored as one string or without "language"');
    expect(bothWarnings[0].message).toContain('script in the old shape at events[1].actions[0]');
    expect(bothWarnings[0].suggestion).toContain('convert 2 of them');
  });

  // ─── else-placement ──────────────────────────────────────

  it('warns about else blocks that do not follow a non-triggered block', async () => {
    const elseCond = (sid: number) => ({ id: 'else', objectClass: 'System', sid });
    const reader = projectWithSheet([
      { eventType: 'block', sid: 220, conditions: [elseCond(221)], actions: [] },
      { eventType: 'block', sid: 222, conditions: [{ id: 'on-start-of-layout', objectClass: 'System', sid: 223 }], actions: [] },
      { eventType: 'block', sid: 224, conditions: [elseCond(225)], actions: [] },
      { eventType: 'block', sid: 226, conditions: [{ id: 'every-tick', objectClass: 'System', sid: 227 }], actions: [] },
      { eventType: 'block', sid: 228, conditions: [elseCond(229), { id: 'on-layout-end', objectClass: 'System', sid: 230 }], actions: [] },
      { eventType: 'block', sid: 231, conditions: [{ id: 'every-tick', objectClass: 'System', sid: 232 }], actions: [] },
      { eventType: 'block', sid: 233, conditions: [elseCond(234), { id: 'compare-two-values', objectClass: 'System', sid: 235 }], actions: [] },
      { eventType: 'block', sid: 236, conditions: [elseCond(237)], actions: [] },
    ]);
    const result = await validateProjectIntegrity(reader);
    expect(result.errors.filter(e => e.check === 'else-placement')).toEqual([]);
    const warns = result.warnings.filter(w => w.check === 'else-placement');
    expect(warns.map(w => w.entity.match(/sid (\d+)/)![1])).toEqual(['220', '224', '228']);
    expect(warns[0].message).toContain('no event comes before it');
    expect(warns[1].message).toContain('triggered by "on-start-of-layout"');
    expect(warns[1].message).toContain('not verified');
    expect(warns[1].suggestion).toContain('sub-events');
    expect(warns[2].message).toContain('holds the trigger "on-layout-end"');
    // The trigger after "else" is reported once, by else-placement, not as "put the trigger first"
    expect(result.warnings.filter(w => w.check === 'trigger-placement')).toEqual([]);
  });

  it('does not warn about the shapes Construct 3 writes', async () => {
    const reader = projectWithSheet([
      { eventType: 'function-block', functionName: 'fn1', functionParameters: [], sid: 205, conditions: [], actions: [] },
      { eventType: 'block', sid: 210, conditions: [{ id: 'every-tick', objectClass: 'System', sid: 211 }], actions: [] },
      {
        eventType: 'block', sid: 212, isOrBlock: true,
        conditions: [{ id: 'else', objectClass: 'System', sid: 213 }],
        actions: [{ callFunction: 'fn1', sid: 214 }, { type: 'script', language: 'javascript', script: ['x();'] }],
      },
    ]);
    const result = await validateProjectIntegrity(reader);
    expect(result.warnings.filter(e => e.check === 'legacy-event-shape')).toEqual([]);
  });

  it('produces no errors on the editor-verified c3-loadable-minimal fixture', async () => {
    const fixture = join(__dirname, '..', 'fixtures', 'c3-loadable-minimal', 'project.c3proj');
    const reader = new Construct3ProjectReader(fixture);
    await reader.loadProject();
    const result = await validateProjectIntegrity(reader);
    expect(result.errors).toEqual([]);
  });

  // ─── Check 4: duplicate-sid ──────────────────────────────

  it('reports duplicate object type SIDs as errors (object class sid already in use)', async () => {
    const reader = createReader({
      objects: new Map([
        ['Obj1', { name: 'Obj1', 'plugin-id': 'Sprite', sid: 999 }],
        ['Obj2', { name: 'Obj2', 'plugin-id': 'Sprite', sid: 999 }],
      ]),
      eventSheets: new Map([
        ['MainSheet', { name: 'MainSheet', events: [], sid: 200 }],
      ]),
      layouts: new Map([
        ['Layout 1', { name: 'Layout 1', sid: 300, layers: [{ name: 'Main', sid: 301, instances: [] }] }],
      ]),
    });
    const result = await validateProjectIntegrity(reader);
    expect(result.valid).toBe(false);
    const err = result.errors.find(e => e.check === 'duplicate-sid');
    expect(err).toBeDefined();
    expect(err!.message).toContain('999');
    expect(err!.message).toContain('2 times');
    expect(err!.message).toContain('"object class sid already in use"');
    expect(err!.message).not.toContain('wrong plugin');
    expect(result.warnings.find(w => w.check === 'duplicate-sid')).toBeUndefined();
  });

  it('reports duplicate SIDs in behavior types as warnings (no load failure on record)', async () => {
    const reader = createReader({
      objects: new Map([
        ['Sprite', {
          name: 'Sprite', 'plugin-id': 'Sprite', sid: 100,
          behaviorTypes: [
            { behaviorId: 'solid', name: 'Solid', sid: 500 },
            { behaviorId: 'jumpthru', name: 'Jump', sid: 500 },
          ],
        }],
      ]),
      eventSheets: new Map([['MainSheet', { name: 'MainSheet', events: [], sid: 200 }]]),
      layouts: new Map([['Layout 1', { name: 'Layout 1', sid: 300, layers: [{ name: 'Main', sid: 301, instances: [] }] }]]),
      usedAddons: [
        { type: 'plugin', id: 'Sprite', name: 'Sprite', author: 'Scirra', bundled: false },
        { type: 'behavior', id: 'solid', name: 'Solid', author: 'Scirra', bundled: false },
        { type: 'behavior', id: 'jumpthru', name: 'JumpThru', author: 'Scirra', bundled: false },
      ],
    });
    const result = await validateProjectIntegrity(reader);
    // The editor's loader checks only object class SIDs; the "wrong plugin"
    // failure once blamed on such clashes came from family plugins.
    expect(result.valid).toBe(true);
    expect(result.errors.find(e => e.check === 'duplicate-sid')).toBeUndefined();
    const warn = result.warnings.find(w => w.check === 'duplicate-sid' && w.message.includes('500'));
    expect(warn).toBeDefined();
    expect(warn!.message).toContain('No load failure is on record');
    expect(warn!.message).not.toContain('wrong plugin');
    expect(warn!.message).not.toContain('fail to open');
  });

  it('reports duplicate SIDs between an instance variable and a family variable as warnings', async () => {
    const reader = createReader({
      objects: new Map([
        ['Enemy', {
          name: 'Enemy', 'plugin-id': 'Sprite', sid: 100,
          instanceVariables: [{ name: 'hp', type: 'number', sid: 777 }],
        }],
      ]),
      families: new Map([
        ['Enemies', {
          name: 'Enemies', 'plugin-id': 'Sprite', sid: 400, members: ['Enemy'],
          instanceVariables: [{ name: 'speed', type: 'number', sid: 777 }],
        }],
      ]),
      eventSheets: new Map([['MainSheet', { name: 'MainSheet', events: [], sid: 200 }]]),
      layouts: new Map([['Layout 1', { name: 'Layout 1', sid: 300, layers: [{ name: 'Main', sid: 301, instances: [] }] }]]),
    });
    const result = await validateProjectIntegrity(reader);
    expect(result.valid).toBe(true);
    expect(result.errors.find(e => e.check === 'duplicate-sid')).toBeUndefined();
    const warn = result.warnings.find(w => w.check === 'duplicate-sid' && w.message.includes('777'));
    expect(warn).toBeDefined();
    expect(warn!.message).toContain('families/Enemies/var:speed');
    expect(warn!.message).toContain('No load failure is on record');
  });

  it('reports an object type SID reused by a family behavior as a warning', async () => {
    const reader = createReader({
      objects: new Map([['Enemy', { name: 'Enemy', 'plugin-id': 'Sprite', sid: 100 }]]),
      families: new Map([
        ['Enemies', {
          name: 'Enemies', 'plugin-id': 'Sprite', sid: 400, members: ['Enemy'],
          behaviorTypes: [{ behaviorId: 'solid', name: 'Solid', sid: 100 }],
        }],
      ]),
      eventSheets: new Map([['MainSheet', { name: 'MainSheet', events: [], sid: 200 }]]),
      layouts: new Map([['Layout 1', { name: 'Layout 1', sid: 300, layers: [{ name: 'Main', sid: 301, instances: [] }] }]]),
    });
    const result = await validateProjectIntegrity(reader);
    expect(result.errors.find(e => e.check === 'duplicate-sid')).toBeUndefined();
    const warn = result.warnings.find(w => w.check === 'duplicate-sid' && w.message.includes('SID 100 '));
    expect(warn).toBeDefined();
    expect(warn!.message).toContain('families/Enemies/behavior:Solid');
  });

  it('keeps duplicate SIDs outside object type files as warnings', async () => {
    const reader = createReader({
      objects: new Map([['Sprite', { name: 'Sprite', 'plugin-id': 'Sprite', sid: 100 }]]),
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 200,
        events: [{ eventType: 'block', sid: 100, conditions: [], actions: [] }],
      }]]),
      layouts: new Map([['Layout 1', { name: 'Layout 1', sid: 300, layers: [{ name: 'Main', sid: 301, instances: [] }] }]]),
    });
    const result = await validateProjectIntegrity(reader);
    expect(result.errors.find(e => e.check === 'duplicate-sid')).toBeUndefined();
    const warn = result.warnings.find(w => w.check === 'duplicate-sid' && w.message.includes('100'));
    expect(warn).toBeDefined();
    expect(warn!.message).toContain('eventSheets/MainSheet > block (sid 100)');
    expect(warn!.message).toContain('No load failure is on record');
    expect(warn!.suggestion).not.toMatch(/regenerate|Re-save the project/);
  });

  it('names the JSON path of events that share a SID and points to eventPath (issue #30)', async () => {
    const block = (sid: number) => ({ eventType: 'block', sid, conditions: [], actions: [] });
    const reader = createReader({
      objects: new Map([['Sprite', { name: 'Sprite', 'plugin-id': 'Sprite', sid: 100 }]]),
      eventSheets: new Map([
        ['Sheet1', {
          name: 'Sheet1', sid: 200,
          events: [block(700), { eventType: 'group', sid: 710, title: 'Combat', children: [block(701)] }, block(700)],
        }],
        ['Sheet2', { name: 'Sheet2', sid: 201, events: [block(701)] }],
      ]),
      layouts: new Map([['Layout 1', { name: 'Layout 1', sid: 300, layers: [{ name: 'Main', sid: 301, instances: [] }] }]]),
    });
    const result = await validateProjectIntegrity(reader);

    // Two top-level blocks in one sheet: same breadcrumb, told apart by their paths
    const inSheet = result.warnings.find(w => w.check === 'duplicate-sid' && w.message.includes('SID 700 '));
    expect(inSheet!.message).toContain('eventSheets/Sheet1 > block (sid 700) at events[0]; eventSheets/Sheet1 > block (sid 700) at events[2]');
    expect(inSheet!.suggestion).toContain(
      'update_event_block, update_event_block_action, update_event_variable and delete_event_from_sheet ' +
      'refuse this SID in a sheet where several events have it, unless eventPath names one of them',
    );
    expect(inSheet!.suggestion).toContain('from the refused call, or from locate_event');

    // One event per sheet: the tools resolve each sheet on its own, so no tool note
    const acrossSheets = result.warnings.find(w => w.check === 'duplicate-sid' && w.message.includes('SID 701 '));
    expect(acrossSheets!.message).toContain('eventSheets/Sheet1 > group "Combat" (sid 710) > block (sid 701) at events[1].children[0]');
    expect(acrossSheets!.message).toContain('eventSheets/Sheet2 > block (sid 701) at events[0]');
    expect(acrossSheets!.suggestion).not.toContain('eventPath');
  });

  it('adds the eventPath note when a non-event node also uses the SID that two events in one sheet share (issue #30)', async () => {
    const block = (sid: number) => ({ eventType: 'block', sid, conditions: [], actions: [] });
    const fn = (sid: number, paramSid: number) => ({
      eventType: 'function-block', sid, functionName: `Func${sid}`, functionReturnType: 'none',
      functionParameters: [{ name: 'a', type: 'number', initialValue: '0', sid: paramSid }],
      conditions: [], actions: [],
    });
    const reader = createReader({
      objects: new Map([['Sprite', { name: 'Sprite', 'plugin-id': 'Sprite', sid: 100 }]]),
      eventSheets: new Map([
        ['Sheet1', {
          name: 'Sheet1', sid: 200,
          // SID 800: two blocks and a layer; SID 810: two blocks and a function parameter; SID 820: one block and a layer
          events: [block(800), block(800), block(810), fn(830, 810), block(810), block(820)],
        }],
      ]),
      layouts: new Map([['Layout 1', {
        name: 'Layout 1', sid: 300,
        layers: [{ name: 'Main', sid: 800, instances: [] }, { name: 'Top', sid: 820, instances: [] }],
      }]]),
    });
    const result = await validateProjectIntegrity(reader);
    const note = 'refuse this SID in a sheet where several events have it, unless eventPath names one of them';

    const withLayer = result.warnings.find(w => w.check === 'duplicate-sid' && w.message.includes('SID 800 '));
    expect(withLayer!.message).toContain('SIDs should be unique across the project');
    expect(withLayer!.suggestion).toContain(note);

    const withParameter = result.warnings.find(w => w.check === 'duplicate-sid' && w.message.includes('SID 810 '));
    expect(withParameter!.message).toContain('may stop the project from opening');
    expect(withParameter!.suggestion).toContain(note);

    // One event with the SID in the sheet: the tools are not affected
    const oneEvent = result.warnings.find(w => w.check === 'duplicate-sid' && w.message.includes('SID 820 '));
    expect(oneEvent!.suggestion).not.toContain('eventPath');
  });

  it('keeps duplicate animation SIDs across object types as warnings (as in Scirra\'s persistent-layouts example)', async () => {
    const anim = (sid: number) => ({ items: [{ name: 'Default', sid, frames: [] }], subfolders: [] });
    const reader = createReader({
      objects: new Map([
        ['NonPersistPickup', { name: 'NonPersistPickup', 'plugin-id': 'Sprite', sid: 16, animations: anim(17) }],
        ['PersistPickup', { name: 'PersistPickup', 'plugin-id': 'Sprite', sid: 36, animations: anim(17) }],
      ]),
      eventSheets: new Map([['MainSheet', { name: 'MainSheet', events: [], sid: 200 }]]),
      layouts: new Map([['Layout 1', { name: 'Layout 1', sid: 300, layers: [{ name: 'Main', sid: 301, instances: [] }] }]]),
    });
    const result = await validateProjectIntegrity(reader);
    expect(result.errors.find(e => e.check === 'duplicate-sid')).toBeUndefined();
    expect(result.warnings.find(w => w.check === 'duplicate-sid' && w.message.includes('17'))).toBeDefined();
  });

  it('does not flag layout instanceFolderItem SIDs that repeat the instance SID', async () => {
    const reader = createReader({
      objects: new Map([['Sprite', { name: 'Sprite', 'plugin-id': 'Sprite', sid: 100 }]]),
      eventSheets: new Map([['MainSheet', { name: 'MainSheet', events: [], sid: 200 }]]),
      layouts: new Map([['Layout 1', {
        name: 'Layout 1', sid: 300,
        layers: [{
          name: 'Main', sid: 301,
          instances: [{ type: 'Sprite', uid: 0, sid: 302, properties: {}, instanceFolderItem: { sid: 302 } }],
        }],
      }]]),
    });
    const result = await validateProjectIntegrity(reader);
    expect(result.errors.find(e => e.check === 'duplicate-sid')).toBeUndefined();
    expect(result.warnings.find(w => w.check === 'duplicate-sid')).toBeUndefined();
  });

  // Editor-saved projects carry duplicate action/condition/event and layout
  // instance SIDs across many saves and still open: the warning must say so,
  // must not advise re-saving, and must say where each duplicate is.
  const sheetProject = (events: unknown[], extra: Record<string, unknown> = {}) => createReader({
    objects: new Map([['Sprite1', { name: 'Sprite1', 'plugin-id': 'Sprite', sid: 100 }]]),
    eventSheets: new Map([['Sheet1', { name: 'Sheet1', sid: 200, events }]]),
    layouts: new Map([['Layout1', { name: 'Layout1', sid: 300, layers: [{ name: 'Layer1', sid: 301, instances: [] }] }]]),
    usedAddons: [{ type: 'plugin', id: 'Sprite', name: 'Sprite', author: 'Scirra', bundled: false }],
    ...extra,
  });
  const wait = (sid: number) => ({ id: 'wait', objectClass: 'System', sid, parameters: { seconds: '1' } });

  it('locates duplicate action SIDs in the sheet and does not advise re-saving', async () => {
    const reader = sheetProject([
      { eventType: 'block', sid: 400000000000001, conditions: [], actions: [wait(400000000000002)] },
      { eventType: 'block', sid: 400000000000003, conditions: [], actions: [wait(400000000000002)] },
    ]);
    const result = await validateProjectIntegrity(reader);
    expect(result.errors.find(e => e.check === 'duplicate-sid')).toBeUndefined();
    const dupes = result.warnings.filter(w => w.check === 'duplicate-sid');
    expect(dupes).toHaveLength(1);
    const warn = dupes[0];
    expect(warn.entity).toBe('eventSheets/Sheet1 > block (sid 400000000000001) > action 0 "wait" (System)');
    expect(warn.message).toContain('SID 400000000000002 is used 2 times');
    expect(warn.message).toContain('eventSheets/Sheet1 > block (sid 400000000000003) > action 0 "wait" (System)');
    expect(warn.message).toContain('No load failure is on record');
    expect(warn.message).toContain('the editor keeps them when it saves');
    expect(warn.suggestion).toContain('new project-unique SID');
    expect(warn.suggestion).not.toMatch(/regenerate|Re-save the project/);
  });

  it('names the enclosing group and the condition index of a duplicate condition SID', async () => {
    const onStart = (sid: number) => ({ id: 'on-start-of-layout', objectClass: 'System', sid });
    const reader = sheetProject([
      { eventType: 'group', sid: 410, title: 'Group1', children: [
        { eventType: 'block', sid: 411, conditions: [onStart(412)], actions: [] },
      ] },
      { eventType: 'block', sid: 413, conditions: [onStart(412)], actions: [] },
    ]);
    const result = await validateProjectIntegrity(reader);
    const warn = result.warnings.find(w => w.check === 'duplicate-sid');
    expect(warn!.message).toContain('eventSheets/Sheet1 > group "Group1" (sid 410) > block (sid 411) > condition 0 "on-start-of-layout" (System)');
    expect(warn!.message).toContain('eventSheets/Sheet1 > block (sid 413) > condition 0');
  });

  it('collapses a SID repeated many times into a bounded message with a summary', async () => {
    const events = Array.from({ length: 41 }, (_, i) => (
      { eventType: 'block', sid: 5000 + i, conditions: [], actions: [wait(900)] }
    ));
    const result = await validateProjectIntegrity(sheetProject(events));
    const dupes = result.warnings.filter(w => w.check === 'duplicate-sid');
    expect(dupes).toHaveLength(1);
    const msg = dupes[0].message;
    expect(msg).toContain('SID 900 is used 41 times (41 actions in eventSheets/Sheet1)');
    expect(msg).toContain('and 36 more');
    expect(msg.split('action 0 "wait"')).toHaveLength(6); // five locations listed
    expect(msg.length).toBeLessThan(1000);
    expect(dupes[0].entity).toBe('eventSheets/Sheet1 > block (sid 5000) > action 0 "wait" (System)');
  });

  it('reports two layout instances sharing a SID once, not counting their instanceFolderItem copies', async () => {
    const inst = (uid: number) => ({ type: 'Sprite1', uid, sid: 302, properties: {}, instanceFolderItem: { sid: 302 } });
    const reader = sheetProject([], {
      layouts: new Map([['Layout1', {
        name: 'Layout1', sid: 300,
        layers: [{ name: 'Layer1', sid: 301, instances: [inst(1), inst(2)] }],
      }]]),
    });
    const result = await validateProjectIntegrity(reader);
    const dupes = result.warnings.filter(w => w.check === 'duplicate-sid');
    expect(dupes).toHaveLength(1);
    expect(dupes[0].message).toContain('SID 302 is used 2 times');
    expect(dupes[0].message).toContain('layouts/Layout1/layer:Layer1/inst:Sprite1:1');
    expect(dupes[0].message).toContain('layouts/Layout1/layer:Layer1/inst:Sprite1:2');
    expect(dupes[0].message).toContain('No load failure is on record');
    expect(dupes[0].suggestion).not.toMatch(/regenerate|Re-save the project/);
  });

  it('does not call duplicate function parameter SIDs harmless (the loader checks them)', async () => {
    const reader = sheetProject([{
      eventType: 'function-block', sid: 600, functionName: 'Func1', functionReturnType: 'none',
      functionParameters: [
        { name: 'a', type: 'number', initialValue: '0', sid: 601 },
        { name: 'b', type: 'number', initialValue: '0', sid: 601 },
      ],
      conditions: [], actions: [],
    }]);
    const result = await validateProjectIntegrity(reader);
    const warn = result.warnings.find(w => w.check === 'duplicate-sid');
    expect(warn).toBeDefined();
    expect(warn!.message).toContain('eventSheets/Sheet1 > function "Func1" (sid 600) > parameter 0 "a"');
    expect(warn!.message).toContain('parameter 1 "b"');
    expect(warn!.message).not.toContain('No load failure');
    expect(warn!.message).toContain('may stop the project from opening');
    expect(warn!.suggestion).not.toMatch(/regenerate|Re-save the project/);
  });

  // ─── Check 5: duplicate-uid ──────────────────────────────

  it('detects duplicate UIDs', async () => {
    const reader = createReader({
      objects: new Map([
        ['Sprite', { name: 'Sprite', 'plugin-id': 'Sprite', sid: 100 }],
      ]),
      eventSheets: new Map([['MainSheet', { name: 'MainSheet', events: [], sid: 200 }]]),
      layouts: new Map([
        ['Layout 1', {
          name: 'Layout 1', sid: 300,
          layers: [{
            name: 'Main', sid: 301,
            instances: [
              { type: 'Sprite', uid: 5, sid: 302, properties: {} },
              { type: 'Sprite', uid: 5, sid: 303, properties: {} },
            ],
          }],
        }],
      ]),
    });
    const result = await validateProjectIntegrity(reader);
    const warn = result.warnings.find(w => w.check === 'duplicate-uid');
    expect(warn).toBeDefined();
    expect(warn!.message).toContain('5');
  });

  it('does not claim that re-saving in Construct 3 fixes duplicate UIDs', async () => {
    const reader = createReader({
      objects: new Map([
        ['Sprite1', { name: 'Sprite1', 'plugin-id': 'Sprite', sid: 100 }],
        ['Array1', { name: 'Array1', 'plugin-id': 'Arr', sid: 101 }],
      ]),
      layouts: new Map([
        ['Layout1', {
          name: 'Layout1', sid: 300,
          layers: [{ name: 'Layer1', sid: 301, instances: [{ type: 'Sprite1', uid: 7, sid: 302, properties: {} }] }],
          'nonworld-instances': [{ type: 'Array1', uid: 7, sid: 303, properties: {} }],
        }],
      ]),
    });
    const result = await validateProjectIntegrity(reader);
    const warn = result.warnings.find(w => w.check === 'duplicate-uid');
    expect(warn!.message).toContain('layouts/Layout1/nonworld:Array1');
    expect(warn!.message).toMatch(/reassign/);
    expect(warn!.suggestion).not.toMatch(/Re-save the project/);
    expect(warn!.suggestion).toContain('new unused UID');
    expect(warn!.suggestion).toContain('UID numbering');
  });

  // ─── Check 6: broken-object-reference ────────────────────

  it('detects broken object references in events', async () => {
    const reader = createReader({
      objects: new Map([
        ['Sprite', { name: 'Sprite', 'plugin-id': 'Sprite', sid: 100 }],
      ]),
      eventSheets: new Map([
        ['MainSheet', {
          name: 'MainSheet', sid: 200,
          events: [{
            eventType: 'block',
            conditions: [{ id: 'test', objectClass: 'DeletedObject', sid: 201 }],
            actions: [],
          }],
        }],
      ]),
      layouts: new Map([
        ['Layout 1', { name: 'Layout 1', sid: 300, layers: [{ name: 'Main', sid: 301, instances: [] }] }],
      ]),
    });
    const result = await validateProjectIntegrity(reader);
    const warn = result.warnings.find(w => w.check === 'broken-object-reference');
    expect(warn).toBeDefined();
    expect(warn!.message).toContain('DeletedObject');
  });

  it('allows "System" object references without warning', async () => {
    const reader = createReader({
      objects: new Map([
        ['Sprite', { name: 'Sprite', 'plugin-id': 'Sprite', sid: 100 }],
      ]),
      eventSheets: new Map([
        ['MainSheet', {
          name: 'MainSheet', sid: 200,
          events: [{
            eventType: 'block',
            conditions: [{ id: 'test', objectClass: 'System', sid: 201 }],
            actions: [],
          }],
        }],
      ]),
      layouts: new Map([
        ['Layout 1', { name: 'Layout 1', sid: 300, layers: [{ name: 'Main', sid: 301, instances: [] }] }],
      ]),
    });
    const result = await validateProjectIntegrity(reader);
    const warn = result.warnings.find(w => w.check === 'broken-object-reference' && w.message.includes('System'));
    expect(warn).toBeUndefined();
  });

  it('allows family name references without warning', async () => {
    const reader = createReader({
      objects: new Map([
        ['Sprite', { name: 'Sprite', 'plugin-id': 'Sprite', sid: 100 }],
      ]),
      families: new Map([
        ['Enemies', { name: 'Enemies', members: ['Sprite'], sid: 400 }],
      ]),
      eventSheets: new Map([
        ['MainSheet', {
          name: 'MainSheet', sid: 200,
          events: [{
            eventType: 'block',
            conditions: [{ id: 'test', objectClass: 'Enemies', sid: 201 }],
            actions: [],
          }],
        }],
      ]),
      layouts: new Map([
        ['Layout 1', { name: 'Layout 1', sid: 300, layers: [{ name: 'Main', sid: 301, instances: [] }] }],
      ]),
    });
    const result = await validateProjectIntegrity(reader);
    const warn = result.warnings.find(w => w.check === 'broken-object-reference' && w.message.includes('Enemies'));
    expect(warn).toBeUndefined();
  });

  /** A function block that returns a value, with the actions the editor saves on the built-in Functions object. */
  function functionsObjectProject(objectClass: string, functionsName?: string) {
    const reader = createReader({
      eventSheets: new Map([
        ['MainSheet', {
          name: 'MainSheet', sid: 200,
          events: [{
            eventType: 'function-block', functionName: 'Double', functionReturnType: 'number',
            functionParameters: [{ name: 'n', type: 'number', initialValue: '0', comment: '', sid: 210 }],
            sid: 201, conditions: [],
            actions: [
              { id: 'set-function-return-value', objectClass, sid: 202, parameters: { value: 'n * 2' } },
            ],
            children: [{
              eventType: 'block', sid: 203, conditions: [],
              actions: [{ id: 'map-function', objectClass, sid: 204, parameters: { name: '"ops"', string: '"double"', function: 'Double' } }],
            }],
          }],
        }],
      ]),
      layouts: new Map([
        ['Layout 1', { name: 'Layout 1', sid: 300, layers: [{ name: 'Main', sid: 301, instances: [] }] }],
      ]),
    });
    if (functionsName !== undefined) {
      const base = reader.getProject.bind(reader);
      reader.getProject = () => ({ ...base(), functionsName });
    }
    return reader;
  }

  it('allows the built-in Functions object without warning', async () => {
    const result = await validateProjectIntegrity(functionsObjectProject('Functions'));
    expect(result.warnings.filter(w => w.check === 'broken-object-reference')).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('takes the Functions object name from functionsName in project.c3proj', async () => {
    const renamed = await validateProjectIntegrity(functionsObjectProject('Fn', 'Fn'));
    expect(renamed.warnings.filter(w => w.check === 'broken-object-reference')).toEqual([]);

    resetProjectIndex();
    const stale = await validateProjectIntegrity(functionsObjectProject('Functions', 'Fn'));
    const warn = stale.warnings.find(w => w.check === 'broken-object-reference');
    expect(warn?.message).toContain('Object "Functions" is referenced in events');
    expect(warn?.message).toContain('the Functions object ("Fn")');
  });

  // ─── Check 7: broken-eventsheet-reference ────────────────

  it('detects layout referencing non-existent event sheet', async () => {
    const reader = createReader({
      objects: new Map(),
      eventSheets: new Map([
        ['MainSheet', { name: 'MainSheet', events: [], sid: 200 }],
      ]),
      layouts: new Map([
        ['Layout 1', {
          name: 'Layout 1', sid: 300,
          eventSheet: 'NonExistentSheet',
          layers: [{ name: 'Main', sid: 301, instances: [] }],
        }],
      ]),
    });
    const result = await validateProjectIntegrity(reader);
    const warn = result.warnings.find(w => w.check === 'broken-eventsheet-reference');
    expect(warn).toBeDefined();
    expect(warn!.message).toContain('NonExistentSheet');
  });

  // ─── Check 8: broken-include ─────────────────────────────

  it('detects include of non-existent event sheet', async () => {
    const reader = createReader({
      objects: new Map(),
      eventSheets: new Map([
        ['MainSheet', {
          name: 'MainSheet', sid: 200,
          events: [{ eventType: 'include', includeSheet: 'MissingSheet' }],
        }],
      ]),
      layouts: new Map([
        ['Layout 1', { name: 'Layout 1', sid: 300, layers: [{ name: 'Main', sid: 301, instances: [] }] }],
      ]),
    });
    const result = await validateProjectIntegrity(reader);
    const warn = result.warnings.find(w => w.check === 'broken-include');
    expect(warn).toBeDefined();
    expect(warn!.message).toContain('MissingSheet');
  });

  // ─── Check 9: missing-addon ──────────────────────────────

  it('detects object plugin not in usedAddons', async () => {
    const reader = createReader({
      objects: new Map([
        ['MyObj', { name: 'MyObj', 'plugin-id': 'UnknownPlugin', sid: 100 }],
      ]),
      eventSheets: new Map([['MainSheet', { name: 'MainSheet', events: [], sid: 200 }]]),
      layouts: new Map([['Layout 1', { name: 'Layout 1', sid: 300, layers: [{ name: 'Main', sid: 301, instances: [] }] }]]),
      usedAddons: [],
    });
    const result = await validateProjectIntegrity(reader);
    const warn = result.warnings.find(w => w.check === 'missing-addon');
    expect(warn).toBeDefined();
    expect(warn!.message).toContain('UnknownPlugin');
  });

  it('detects behavior not in usedAddons', async () => {
    const reader = createReader({
      objects: new Map([
        ['Sprite', {
          name: 'Sprite', 'plugin-id': 'Sprite', sid: 100,
          behaviorTypes: [{ behaviorId: 'MissingBehavior', name: 'MB', sid: 101 }],
        }],
      ]),
      eventSheets: new Map([['MainSheet', { name: 'MainSheet', events: [], sid: 200 }]]),
      layouts: new Map([['Layout 1', { name: 'Layout 1', sid: 300, layers: [{ name: 'Main', sid: 301, instances: [] }] }]]),
      usedAddons: [
        { type: 'plugin', id: 'Sprite', name: 'Sprite', author: 'Scirra', bundled: false },
      ],
    });
    const result = await validateProjectIntegrity(reader);
    const warn = result.warnings.find(w => w.check === 'missing-addon' && w.message.includes('MissingBehavior'));
    expect(warn).toBeDefined();
  });

  // ─── missing-behavior-entry ──────────────────────────────

  describe('missing-behavior-entry', () => {
    /** Hero (Tween) in family Movers (Sine), with the given instances on layer Main and a sub-layer */
    function projectWithInstances(main: unknown[], sub: unknown[] = []) {
      return createReader({
        objects: new Map([
          ['Hero', {
            name: 'Hero', 'plugin-id': 'Sprite', sid: 100,
            behaviorTypes: [{ behaviorId: 'Tween', name: 'Tween', sid: 101 }],
          }],
        ]),
        families: new Map([
          ['Movers', {
            name: 'Movers', 'plugin-id': 'Sprite', sid: 400, members: ['Hero'],
            behaviorTypes: [{ behaviorId: 'Sin', name: 'Sine', sid: 401 }],
          }],
        ]),
        eventSheets: new Map([['MainSheet', { name: 'MainSheet', events: [], sid: 200 }]]),
        layouts: new Map([
          ['Layout 1', {
            name: 'Layout 1', sid: 300, eventSheet: 'MainSheet',
            layers: [{
              name: 'Main', sid: 301, instances: main,
              subLayers: [{ name: 'Inner', sid: 302, instances: sub }],
            }],
          }],
        ]),
        usedAddons: [
          { type: 'plugin', id: 'Sprite', name: 'Sprite', author: 'Scirra', bundled: false },
          { type: 'behavior', id: 'Tween', name: 'Tween', author: 'Scirra', bundled: false },
          { type: 'behavior', id: 'Sin', name: 'Sine', author: 'Scirra', bundled: false },
        ],
      });
    }
    const complete = (uid: number) => ({
      type: 'Hero', uid, sid: 500 + uid, properties: {}, instanceVariables: {},
      behaviors: { Sine: { properties: {} }, Tween: { properties: { enabled: true } } },
    });

    it('warns once per layout and object type, naming the instances and the missing behaviors', async () => {
      const reader = projectWithInstances(
        [
          { type: 'Hero', uid: 1, sid: 501, properties: {}, instanceVariables: {}, behaviors: {} },
          complete(2),
        ],
        [{ type: 'Hero', uid: 3, sid: 503, properties: {}, instanceVariables: {}, behaviors: { Tween: { properties: { enabled: false } } } }],
      );
      const result = await validateProjectIntegrity(reader);
      const warns = result.warnings.filter(w => w.check === 'missing-behavior-entry');
      expect(warns).toHaveLength(1);
      expect(warns[0].entity).toBe('layouts/Layout 1/inst:Hero');
      expect(warns[0].message).toBe('2 instance(s) of "Hero" (uid 1, 3) have no entry for behavior(s) "Sine", "Tween"');
      expect(warns[0].suggestion).toContain('update_object_properties adds the missing entries');
      expect(result.valid).toBe(true);
    });

    it('counts an instance without a behaviors dict as lacking every entry', async () => {
      const reader = projectWithInstances([{ type: 'Hero', uid: 4, sid: 504, properties: {} }]);
      const result = await validateProjectIntegrity(reader);
      const warns = result.warnings.filter(w => w.check === 'missing-behavior-entry');
      expect(warns.map(w => w.message)).toEqual(['1 instance(s) of "Hero" (uid 4) have no entry for behavior(s) "Sine", "Tween"']);
    });

    it('does not warn for instances with every entry, or for objects without behaviors', async () => {
      const reader = projectWithInstances([complete(1)], [complete(2)]);
      expect((await validateProjectIntegrity(reader)).warnings.filter(w => w.check === 'missing-behavior-entry')).toEqual([]);
      expect((await validateProjectIntegrity(validProject())).warnings.filter(w => w.check === 'missing-behavior-entry')).toEqual([]);
    });
  });

  // ─── Check 3b: subfolder-structure ────────────────────────

  /** validProject() with its project.c3proj containers patched */
  function withContainers(containers: Record<string, unknown>) {
    const reader = validProject();
    const origGetProject = reader.getProject.bind(reader);
    reader.getProject = () => ({ ...origGetProject(), ...containers });
    return reader;
  }

  const subfolderErrors = (result: Awaited<ReturnType<typeof validateProjectIntegrity>>) =>
    result.errors.filter(e => e.check === 'subfolder-structure');

  it('detects subfolder missing name field', async () => {
    const reader = withContainers({
      families: { items: [], subfolders: [{ items: [], subfolders: [] }] }, // no name!
    });
    const result = await validateProjectIntegrity(reader);
    expect(result.valid).toBe(false);
    const err = result.errors.find((e: any) => e.check === 'subfolder-structure');
    expect(err).toBeDefined();
    expect(err!.entity).toBe('families/subfolders[0]');
    expect(err!.message).toContain('missing required "name" field');
    expect(err!.suggestion).toContain('Add a "name" field');
  });

  it('passes subfolder check when all subfolders have names', async () => {
    const reader = validProject();
    const result = await validateProjectIntegrity(reader);
    const err = result.errors.find((e: any) => e.check === 'subfolder-structure');
    expect(err).toBeUndefined();
  });

  it('accepts the editor\'s unnamed Transitions folder under timelines', async () => {
    // Construct 3 writes the first timelines subfolder without a name key
    for (const items of [['Transition1'], []]) {
      const reader = withContainers({
        timelines: { items: ['Timeline1'], subfolders: [{ items, subfolders: [] }] },
      });
      const result = await validateProjectIntegrity(reader);
      expect(subfolderErrors(result), `items ${JSON.stringify(items)}`).toEqual([]);
      expect(result.valid).toBe(true);
    }
  });

  it('accepts the Transitions folder next to named timelines folders, in any position', async () => {
    const reader = withContainers({
      timelines: {
        items: [],
        subfolders: [
          { items: ['Timeline1'], subfolders: [], name: 'Folder1' },
          { items: ['Transition1'], subfolders: [] },
        ],
      },
    });
    const result = await validateProjectIntegrity(reader);
    expect(subfolderErrors(result)).toEqual([]);
  });

  it('reports a second unnamed first-level timelines folder, without advising to name the Transitions folder', async () => {
    const reader = withContainers({
      timelines: {
        items: [],
        subfolders: [{ items: ['Transition1'], subfolders: [] }, { items: ['Timeline2'], subfolders: [] }],
      },
    });
    const result = await validateProjectIntegrity(reader);
    expect(result.valid).toBe(false);
    const errors = subfolderErrors(result);
    expect(errors).toHaveLength(1);
    expect(errors[0].entity).toBe('timelines/subfolders[1]');
    expect(errors[0].suggestion).toContain('Transitions folder');
  });

  it('reports an unnamed folder nested in a timelines folder', async () => {
    const reader = withContainers({
      timelines: {
        items: [],
        subfolders: [{ name: 'Folder1', items: [], subfolders: [{ items: ['Transition1'], subfolders: [] }] }],
      },
    });
    const result = await validateProjectIntegrity(reader);
    const errors = subfolderErrors(result);
    expect(errors).toHaveLength(1);
    expect(errors[0].entity).toBe('timelines/Folder1/subfolders[0]');
  });

  it('still requires an items array on the Transitions folder and checks folders inside it', async () => {
    const reader = withContainers({
      timelines: { items: [], subfolders: [{ subfolders: [{ items: [], subfolders: [] }] }] },
    });
    const result = await validateProjectIntegrity(reader);
    expect(subfolderErrors(result).map(e => e.entity)).toEqual([
      'timelines/(Transitions)',
      'timelines/(Transitions)/subfolders[0]',
    ]);
  });

  it('does not treat an unnamed folder outside timelines as a Transitions folder', async () => {
    const reader = withContainers({
      layouts: { items: ['Layout 1'], subfolders: [{ items: [], subfolders: [] }] },
    });
    const result = await validateProjectIntegrity(reader);
    expect(subfolderErrors(result).map(e => e.entity)).toEqual(['layouts/subfolders[0]']);
  });

  // ─── Summary counts ──────────────────────────────────────

  it('summary counts match actual arrays', async () => {
    // A project with multiple issues
    const reader = createReader({
      objects: new Map([
        ['Obj1', { name: 'Obj1', 'plugin-id': 'Sprite', sid: 100 }],
        ['Obj2', { name: 'Obj2', 'plugin-id': 'Sprite', sid: 100 }], // dupe SID
      ]),
      eventSheets: new Map([
        ['MainSheet', {
          name: 'WrongName', events: [], sid: 200, // name mismatch
        }],
      ]),
      layouts: new Map([
        ['Layout 1', { name: 'Layout 1', sid: 300, layers: [{ name: 'Main', sid: 301, instances: [] }] }],
      ]),
    });
    const result = await validateProjectIntegrity(reader);
    expect(result.summary.errors).toBe(result.errors.length);
    expect(result.summary.warnings).toBe(result.warnings.length);
    expect(result.summary.info).toBe(result.info.length);
  });

  // ─── Check 12: orphaned-object ───────────────────────────

  it('reports orphaned objects as info', async () => {
    const reader = createReader({
      objects: new Map([
        ['UsedSprite', { name: 'UsedSprite', 'plugin-id': 'Sprite', sid: 100 }],
        ['UnusedSprite', { name: 'UnusedSprite', 'plugin-id': 'Sprite', sid: 101 }],
      ]),
      eventSheets: new Map([
        ['MainSheet', {
          name: 'MainSheet', sid: 200,
          events: [{
            eventType: 'block',
            conditions: [{ id: 'test', objectClass: 'UsedSprite', sid: 202 }],
            actions: [],
          }],
        }],
      ]),
      layouts: new Map([
        ['Layout 1', {
          name: 'Layout 1', sid: 300,
          layers: [{ name: 'Main', sid: 301, instances: [{ type: 'UsedSprite', uid: 0, sid: 302, properties: {} }] }],
        }],
      ]),
    });
    const result = await validateProjectIntegrity(reader);
    const orphanInfo = result.info.find(i => i.check === 'orphaned-object' && i.entity.includes('UnusedSprite'));
    expect(orphanInfo).toBeDefined();
    expect(orphanInfo!.message).toContain('non-world instances');
    expect(orphanInfo!.suggestion).toContain('project script files');
  });

  /** Objects used only in the less obvious ways, plus unused controls. */
  function projectWithIndirectUses() {
    const sprite = (name: string, sid: number) => [name, { name, 'plugin-id': 'Sprite', sid }] as [string, Record<string, unknown>];
    return createReader({
      objects: new Map([
        sprite('Sprite1', 101), sprite('Sprite2', 102), sprite('Sprite3', 103), sprite('Sprite4', 104),
        sprite('Sprite5', 105), sprite('Sprite6', 106), sprite('Sprite7', 107), sprite('Sprite8', 108),
        sprite('Count', 109),
        ['Array1', { name: 'Array1', 'plugin-id': 'Arr', sid: 110 }],
      ]),
      families: new Map([['Family1', { name: 'Family1', 'plugin-id': 'Sprite', sid: 120, members: ['Sprite5'] }]]),
      eventSheets: new Map([['Sheet1', {
        name: 'Sheet1', sid: 200,
        events: [
          {
            eventType: 'block', sid: 201,
            conditions: [{ id: 'on-start-of-layout', objectClass: 'System', sid: 202 }],
            actions: [
              // Object parameter (whole value is an object name)
              { id: 'spawn-another-object', objectClass: 'Sprite1', sid: 203, parameters: { object: ' Sprite2 ', layer: '0', 'image-point': '0' } },
              // runtime.objects in a script action (array of lines, as the editor saves it)
              { type: 'script', language: 'javascript', script: ['const inst = runtime.objects.Sprite3.getFirstInstance();'] },
              // Expression; ".Count" is a member, not the object Count
              { id: 'set-x', objectClass: 'Sprite1', sid: 204, parameters: { x: 'Sprite4.X + Sprite1.Count' } },
              // String literals are not references
              { id: 'wait', objectClass: 'System', sid: 205, parameters: { seconds: 'len("Sprite6.X") + len("Sprite6")' } },
              // Function call arguments, IID-indexed expression
              { callFunction: 'Func1', sid: 206, parameters: ['Sprite7(0).X'] },
            ],
          },
          {
            eventType: 'block', sid: 207,
            // Family used only as an object parameter
            conditions: [{ id: 'is-overlapping-another-object', objectClass: 'Sprite1', sid: 208, parameters: { object: 'Family1' } }],
            actions: [],
          },
          { eventType: 'script', language: 'javascript', script: ['globalThis.a = runtime.objects["Sprite8"];'] },
        ],
      }]]),
      layouts: new Map([['Layout1', {
        name: 'Layout1', sid: 300, eventSheet: 'Sheet1',
        layers: [{ name: 'Layer1', sid: 301, instances: [{ type: 'Sprite1', uid: 1, sid: 302, properties: {} }] }],
        'nonworld-instances': [{ type: 'Array1', uid: 2, sid: 303, properties: {} }],
      }]]),
      usedAddons: [
        { type: 'plugin', id: 'Sprite', name: 'Sprite', author: 'Scirra', bundled: false },
        { type: 'plugin', id: 'Arr', name: 'Array', author: 'Scirra', bundled: false },
      ],
    });
  }

  it('counts non-world instances, object parameters, expressions and script actions as uses', async () => {
    const result = await validateProjectIntegrity(projectWithIndirectUses());
    const orphans = result.info.filter(i => i.check === 'orphaned-object').map(i => i.entity);
    expect(orphans).toEqual(['objectTypes/Sprite6', 'objectTypes/Count']);
    // Only existing names are recorded, so nothing turns into a broken reference
    expect(result.warnings.filter(w => w.check === 'broken-object-reference')).toEqual([]);
  });

  it('records how each object is referenced in the project index', async () => {
    const reader = projectWithIndirectUses();
    const index = await getProjectIndex(reader);
    const contexts = (name: string) => (index.objectToEventSheets.get(name) ?? []).map(r => r.context);
    expect(contexts('Sprite2')).toEqual(['parameter']);
    expect(contexts('Sprite3')).toEqual(['script']);
    expect(contexts('Sprite4')).toEqual(['expression']);
    expect(contexts('Sprite7')).toEqual(['expression']);
    expect(contexts('Sprite8')).toEqual(['script']);
    expect(contexts('Family1')).toEqual(['parameter']);
    // An object's own condition/action is not repeated by its parameters (Sprite1.Count)
    expect(contexts('Sprite1')).toEqual(['action', 'action', 'condition']);
    expect(index.objectToLayouts.get('Array1')).toEqual(['Layout1']);
    expect(index.isObjectUsed('Sprite5')).toBe(true); // through Family1
    expect(index.isObjectUsed('Sprite6')).toBe(false);
  });

  it('does not count variables, sounds, instance variables or layouts that share an object\'s name', async () => {
    const sprite = (name: string, sid: number) => [name, { name, 'plugin-id': 'Sprite', sid }] as [string, Record<string, unknown>];
    const reader = createReader({
      objects: new Map([
        sprite('Sprite1', 101), sprite('Sprite12', 112), sprite('Sprite13', 113), sprite('Sprite14', 114),
        sprite('Sprite15', 115), sprite('Sprite16', 116), sprite('Sprite17', 117), sprite('Sprite18', 118),
      ]),
      eventSheets: new Map([['Sheet1', {
        name: 'Sheet1', sid: 200,
        events: [
          // Global event variables named like objects (Construct 3 allows this)
          { eventType: 'variable', name: 'Sprite16', type: 'number', initialValue: '0', sid: 201 },
          { eventType: 'variable', name: 'Sprite14', type: 'number', initialValue: '0', sid: 202 },
          {
            eventType: 'function-block', functionName: 'Func1', sid: 203,
            functionParameters: [{ name: 'Sprite13', type: 'number', initialValue: '0', sid: 204 }],
            conditions: [], actions: [],
          },
          {
            eventType: 'block', sid: 205,
            // A bare name in an expression parameter is the variable
            conditions: [{ id: 'compare-two-values', objectClass: 'System', sid: 206, parameters: { 'first-value': 'Sprite16', comparison: 0, 'second-value': '1' } }],
            actions: [
              { id: 'play', objectClass: 'Audio', sid: 207, parameters: { 'audio-file': 'Sprite17', loop: 'not-looping', volume: '0', tag: '""' } },
              { id: 'set-instvar-value', objectClass: 'Sprite1', sid: 208, parameters: { 'instance-variable': 'Sprite18', value: '1' } },
              { id: 'go-to-layout', objectClass: 'System', sid: 209, parameters: { layout: 'Sprite12' } },
              { callFunction: 'Func1', sid: 210, parameters: ['Sprite13'] },
              // An object parameter counts even when a variable has the name
              { id: 'create-object', objectClass: 'System', sid: 211, parameters: { 'object-to-create': 'Sprite14', layer: '0', x: '0', y: '0' } },
              // Unknown key, no variable of that name: still counted (conservative)
              { id: 'custom-action', objectClass: 'Sprite1', sid: 212, parameters: { target: 'Sprite15' } },
            ],
          },
        ],
      }]]),
      layouts: new Map([['Layout1', {
        name: 'Layout1', sid: 300, eventSheet: 'Sheet1',
        layers: [{ name: 'Layer1', sid: 301, instances: [{ type: 'Sprite1', uid: 1, sid: 302, properties: {} }] }],
      }]]),
    });
    const result = await validateProjectIntegrity(reader);
    const orphans = result.info.filter(i => i.check === 'orphaned-object').map(i => i.entity);
    expect(orphans).toEqual(['objectTypes/Sprite12', 'objectTypes/Sprite13', 'objectTypes/Sprite16', 'objectTypes/Sprite17', 'objectTypes/Sprite18']);
    const index = await getProjectIndex(reader);
    expect(index.objectToEventSheets.get('Sprite14')?.map(r => r.context)).toEqual(['parameter']);
    expect(index.objectToEventSheets.get('Sprite15')?.map(r => r.context)).toEqual(['parameter']);
    expect(index.objectToEventSheets.has('Sprite16')).toBe(false);
  });

  it('gives the same orphans in find_orphaned_objects, get_object_dependencies and analyze_performance', async () => {
    const reader = projectWithIndirectUses();
    const orphans = await findOrphanedObjects(reader);
    expect(orphans.orphanedObjects.map(o => o.name)).toEqual(['Sprite6', 'Count']);

    const deps = await getObjectDependencies(reader);
    expect(deps.projectWide!.orphanedObjects).toEqual(['Sprite6', 'Count']);
    // Sprite5 (used only through Family1) counts as referenced: the totals add up
    expect(deps.projectWide!.totalObjects).toBe(10);
    expect(deps.projectWide!.totalReferenced).toBe(8);

    const perf = await analyzePerformance(reader);
    const cleanup = perf.issues.find(i => i.category === 'cleanup' && i.location === 'project' && i.message.includes('object(s)'))!;
    expect(cleanup.message).toMatch(/^2 object\(s\) not used by any event/);
    expect(cleanup.suggestion).toContain('project script files');
  });

  it('counts only conditions and actions, not their parameter, expression or script references, as events', async () => {
    const flow = await getEventSheetFlow(projectWithIndirectUses(), { format: 'json' });
    const sheet = flow.nodes!.find(n => n.name === 'Sheet1')!;
    // Conditions: System, Sprite1; actions: Sprite1, Sprite1, System (script and function call have no objectClass)
    expect(sheet.eventCount).toBe(5);
  });

  it('counts an object\'s sprite asset as used when the object is used through a family', async () => {
    // get_asset_usage reads sprite images from an `animations` array
    const frames = { frames: [{}] };
    const reader = createReader({
      objects: new Map([
        ['Sprite1', { name: 'Sprite1', 'plugin-id': 'Sprite', sid: 101, animations: [frames] }],
        ['Sprite2', { name: 'Sprite2', 'plugin-id': 'Sprite', sid: 102, animations: [frames] }],
      ]),
      families: new Map([['Family1', { name: 'Family1', 'plugin-id': 'Sprite', sid: 120, members: ['Sprite1'] }]]),
      eventSheets: new Map([['Sheet1', {
        name: 'Sheet1', sid: 200,
        events: [{ eventType: 'block', sid: 201, conditions: [], actions: [{ id: 'destroy', objectClass: 'Family1', sid: 202 }] }],
      }]]),
    });
    const usage = await getAssetUsage(reader, { type: 'image' });
    expect(usage.summary.totalAssets).toBe(2);
    expect(usage.summary.unusedCount).toBe(1); // Sprite2 only
  });

  // ─── Editor load-time rules ──────────────────────────────

  /** Project with Keyboard + Sprite objects and one event sheet holding `events`. */
  function projectWithEvents(events: unknown[], extra: Partial<ConstructorParameters<typeof MockReader>[0]> = {}) {
    return createReader({
      objects: new Map([
        ['Keyboard', { name: 'Keyboard', 'plugin-id': 'Keyboard', sid: 100 }],
        ['Player', { name: 'Player', 'plugin-id': 'Sprite', sid: 101 }],
      ]),
      eventSheets: new Map([['MainSheet', { name: 'MainSheet', sid: 200, events }]]),
      layouts: new Map([['Layout 1', { name: 'Layout 1', sid: 300, layers: [{ name: 'Main', sid: 301, instances: [] }] }]]),
      usedAddons: [
        { type: 'plugin', id: 'Keyboard', name: 'Keyboard', author: 'Scirra', bundled: false },
        { type: 'plugin', id: 'Sprite', name: 'Sprite', author: 'Scirra', bundled: false },
      ],
      ...extra,
    });
  }

  it('reports a nested trigger as a trigger-placement error', async () => {
    const reader = projectWithEvents([{
      eventType: 'block', sid: 400,
      conditions: [{ id: 'on-start-of-layout', objectClass: 'System', sid: 401 }],
      actions: [],
      children: [{
        eventType: 'block', sid: 402,
        conditions: [{ id: 'on-key-pressed', objectClass: 'Keyboard', sid: 403, parameters: { key: 32 } }],
        actions: [],
      }],
    }]);
    const result = await validateProjectIntegrity(reader);
    expect(result.valid).toBe(false);
    const err = result.errors.find(e => e.check === 'trigger-placement');
    expect(err).toBeDefined();
    expect(err!.entity).toContain('eventSheets/MainSheet');
    expect(err!.message).toContain('cannot add another trigger to event branch');
  });

  it('accepts several triggers in an OR block', async () => {
    const reader = projectWithEvents([{
      eventType: 'block', sid: 400, isOrBlock: true,
      conditions: [
        { id: 'on-key-pressed', objectClass: 'Keyboard', sid: 401, parameters: { key: 32 } },
        { id: 'on-start-of-layout', objectClass: 'System', sid: 402 },
      ],
      actions: [],
    }]);
    const result = await validateProjectIntegrity(reader);
    expect(result.errors.filter(e => e.check === 'trigger-placement')).toEqual([]);
    expect(result.warnings.filter(w => w.check === 'trigger-placement')).toEqual([]);
  });

  it('reports third-party trigger problems as warnings only', async () => {
    const reader = projectWithEvents([{
      eventType: 'block', sid: 400,
      conditions: [
        { id: 'compare-eventvar', objectClass: 'System', sid: 401 },
        { id: 'on-login-success', objectClass: 'NGIO', sid: 402 },
      ],
      actions: [],
    }], {
      objects: new Map([['NGIO', { name: 'NGIO', 'plugin-id': 'ppstudio_ngio', sid: 100 }]]),
      usedAddons: [{ type: 'plugin', id: 'ppstudio_ngio', name: 'NGIO', author: 'Pixel Perfect Studio', bundled: false }],
    });
    const result = await validateProjectIntegrity(reader);
    expect(result.errors.find(e => e.check === 'trigger-placement')).toBeUndefined();
    expect(result.warnings.find(w => w.check === 'trigger-placement')).toBeDefined();
  });

  it('reports expression problems as errors and accepts backslashes inside strings', async () => {
    const reader = projectWithEvents([{
      eventType: 'block', sid: 400,
      conditions: [{ id: 'every-tick', objectClass: 'System', sid: 401 }],
      actions: [
        { id: 'set-text', objectClass: 'Player', sid: 402, parameters: { text: '"{\\"a\\":1}"' } },
        { id: 'set-text', objectClass: 'Player', sid: 403, parameters: { text: '' } },
        { id: 'set-text', objectClass: 'Player', sid: 404, parameters: { text: '"C:\\folder\\" & Player.UID' } },
      ],
    }]);
    const result = await validateProjectIntegrity(reader);
    const syntax = result.errors.filter(e => e.check === 'expression-syntax');
    const empty = result.errors.filter(e => e.check === 'empty-expression');
    expect(syntax).toHaveLength(1);
    expect(syntax[0].entity).toContain('action 0');
    expect(empty).toHaveLength(1);
    expect(empty[0].entity).toContain('action 1');
  });

  it('reports duplicate object type names in the c3proj tree as errors', async () => {
    const reader = validProject();
    const origGetProject = reader.getProject.bind(reader);
    reader.getProject = () => {
      const proj = origGetProject();
      proj.objectTypes = {
        items: ['Sprite'],
        subfolders: [{ name: 'Moved', items: ['Sprite'], subfolders: [] }],
      };
      return proj;
    };
    const result = await validateProjectIntegrity(reader);
    expect(result.valid).toBe(false);
    const err = result.errors.find(e => e.check === 'duplicate-object-name');
    expect(err).toBeDefined();
    expect(err!.message).toContain("object class name 'Sprite' already used");
  });

  it('reports a family named like an object type (ignoring case) as an error', async () => {
    const reader = createReader({
      objects: new Map([['Enemy', { name: 'Enemy', 'plugin-id': 'Sprite', sid: 100 }]]),
      families: new Map([['enemy', { name: 'enemy', 'plugin-id': 'Sprite', sid: 400, members: ['Enemy'] }]]),
      eventSheets: new Map([['MainSheet', { name: 'MainSheet', events: [], sid: 200 }]]),
      layouts: new Map([['Layout 1', { name: 'Layout 1', sid: 300, layers: [{ name: 'Main', sid: 301, instances: [] }] }]]),
    });
    const result = await validateProjectIntegrity(reader);
    const err = result.errors.find(e => e.check === 'duplicate-object-name');
    expect(err).toBeDefined();
    expect(err!.entity).toContain('object type "Enemy"');
    expect(err!.entity).toContain('family "enemy"');
  });

  it('reports an object type named like the built-in Functions object as an error', async () => {
    const reader = validProject();
    const origGetProject = reader.getProject.bind(reader);
    reader.getProject = () => ({ ...origGetProject(), objectTypes: { items: ['Sprite', 'functions'], subfolders: [] } });
    const result = await validateProjectIntegrity(reader);
    const err = result.errors.find(e => e.check === 'duplicate-object-name');
    expect(err).toBeDefined();
    expect(err!.message).toContain('has the name of the built-in Functions object');
  });

  it('reports a family member with a different plugin as an error', async () => {
    const reader = createReader({
      objects: new Map([
        ['Hero', { name: 'Hero', 'plugin-id': 'Sprite', sid: 100 }],
        ['Label', { name: 'Label', 'plugin-id': 'Text', sid: 101 }],
      ]),
      families: new Map([
        ['Actors', { name: 'Actors', 'plugin-id': 'Sprite', sid: 400, members: ['Hero', 'Label'] }],
      ]),
      eventSheets: new Map([['MainSheet', { name: 'MainSheet', events: [], sid: 200 }]]),
      layouts: new Map([['Layout 1', { name: 'Layout 1', sid: 300, layers: [{ name: 'Main', sid: 301, instances: [] }] }]]),
    });
    const result = await validateProjectIntegrity(reader);
    const err = result.errors.find(e => e.check === 'family-plugin-mismatch');
    expect(err).toBeDefined();
    expect(err!.message).toContain('"Label"');
    expect(err!.message).toContain('"Text"');
    expect(err!.message).toContain('"wrong plugin"');
  });

  it('accepts a family whose members share its plugin', async () => {
    const reader = createReader({
      objects: new Map([
        ['Hero', { name: 'Hero', 'plugin-id': 'Sprite', sid: 100 }],
        ['Villain', { name: 'Villain', 'plugin-id': 'Sprite', sid: 101 }],
      ]),
      families: new Map([
        ['Actors', { name: 'Actors', 'plugin-id': 'Sprite', sid: 400, members: ['Hero', 'Villain'] }],
      ]),
      eventSheets: new Map([['MainSheet', { name: 'MainSheet', events: [], sid: 200 }]]),
      layouts: new Map([['Layout 1', { name: 'Layout 1', sid: 300, layers: [{ name: 'Main', sid: 301, instances: [] }] }]]),
    });
    const result = await validateProjectIntegrity(reader);
    expect(result.errors.find(e => e.check === 'family-plugin-mismatch')).toBeUndefined();
  });
});

// ─── Files on disk: orphaned-file, file-name-case-mismatch, backup-file ───

describe('validateProjectIntegrity file scans', () => {
  let dir: string;

  beforeEach(async () => {
    resetProjectIndex();
    dir = await mkdtemp(join(tmpdir(), 'c3-integrity-files-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeFiles(paths: string[]): Promise<void> {
    for (const rel of paths) {
      const file = join(dir, ...rel.split('/'));
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, '{}', 'utf-8');
    }
  }

  type Folder = { items: string[]; subfolders: Array<Folder & { name: string }> };

  /** project.c3proj container for "Name" / "Folder/Sub/Name" entries (project-bar folders). */
  function containerFor(paths: string[] = []): Folder {
    const root: Folder = { items: [], subfolders: [] };
    for (const path of paths) {
      const parts = path.split('/');
      const name = parts.pop()!;
      let folder = root;
      for (const part of parts) {
        let sub = folder.subfolders.find(s => s.name === part);
        if (!sub) {
          sub = { name: part, items: [], subfolders: [] };
          folder.subfolders.push(sub);
        }
        folder = sub;
      }
      folder.items.push(name);
    }
    return root;
  }

  /**
   * MockReader (all registered entities loadable) that scans `dir` on disk.
   * Names may carry project-bar folders: "Sub/Layout2" is Layout2 in folder Sub.
   */
  function readerFor(names: { objects?: string[]; eventSheets?: string[]; layouts?: string[] }) {
    const entries = (list: string[] = [], extra: (n: string, i: number) => Record<string, unknown>) =>
      new Map(list.map(p => p.split('/').pop()!).map((n, i) => [n, { name: n, sid: 500 + i, ...extra(n, i) }]));
    const reader = createReader({
      objects: entries(names.objects, () => ({ 'plugin-id': 'Sprite' })),
      eventSheets: entries(names.eventSheets, () => ({ events: [] })),
      layouts: entries(names.layouts, () => ({ layers: [] })),
    });
    const project = reader.getProject();
    project.objectTypes = containerFor(names.objects);
    project.eventSheets = containerFor(names.eventSheets);
    project.layouts = containerFor(names.layouts);
    reader.getProject = () => project;
    reader.getProjectDir = () => dir;
    return reader;
  }

  const byCheck = (list: Array<{ check: string; entity: string }>, check: string) =>
    list.filter(i => i.check === check).map(i => i.entity).sort();

  it('skips the editor\'s *.uistate.json files and scans nested folders', async () => {
    await writeFiles([
      'layouts/Layout1.json', 'layouts/Layout1.uistate.json',
      'layouts/Sub/Layout2.json', 'layouts/Sub/Layout2.uistate.json',
      'layouts/Sub/Deeper/Layout3.json', 'layouts/Sub/Deeper/Unused2.json',
      'eventSheets/Sheet1.json', 'eventSheets/Sheet1.uistate.json',
      'objectTypes/Sprite1.json', 'objectTypes/Stale.uistate.json', 'objectTypes/Unused1.json',
    ]);
    const result = await validateProjectIntegrity(readerFor({
      objects: ['Sprite1'], eventSheets: ['Sheet1'], layouts: ['Layout1', 'Sub/Layout2', 'Sub/Deeper/Layout3'],
    }));
    expect(byCheck(result.info, 'orphaned-file')).toEqual(['layouts/Sub/Deeper/Unused2.json', 'objectTypes/Unused1.json']);
    expect(byCheck(result.warnings, 'file-name-case-mismatch')).toEqual([]);
  });

  it('warns about file paths that differ from the expected path only in case, without delete advice', async () => {
    await writeFiles([
      'layouts/Layout1.json', 'layouts/Sub/Layout2.json', 'layouts/menus/Layout3.json',
      'objectTypes/sprite1.json', 'objectTypes/Unused1.json',
      'eventSheets/SHEET1.json',
    ]);
    const result = await validateProjectIntegrity(readerFor({
      objects: ['Sprite1'], eventSheets: ['Sheet1'], layouts: ['layout1', 'Sub/layout2', 'Menus/Layout3'],
    }));
    const warnings = result.warnings.filter(w => w.check === 'file-name-case-mismatch');
    expect(warnings.map(w => w.entity).sort()).toEqual([
      'eventSheets/SHEET1.json', 'layouts/Layout1.json', 'layouts/Sub/Layout2.json', 'layouts/menus/Layout3.json', 'objectTypes/sprite1.json',
    ]);
    const layout1 = warnings.find(w => w.entity === 'layouts/Layout1.json')!;
    expect(layout1.message).toContain('"layout1" is read from layouts/layout1.json');
    expect(layout1.suggestion).toContain('Rename the file to "layouts/layout1.json"');
    // A folder name in different case is a case mismatch too
    const layout3 = warnings.find(w => w.entity === 'layouts/menus/Layout3.json')!;
    expect(layout3.suggestion).toContain('Rename the file to "layouts/Menus/Layout3.json"');
    for (const w of warnings) expect(w.suggestion).not.toMatch(/^Delete|delete the file/i);
    // The genuine orphan is still reported
    expect(byCheck(result.info, 'orphaned-file')).toEqual(['objectTypes/Unused1.json']);
  });

  it('keeps reporting a differently cased file as orphaned when the correctly named file exists too', async () => {
    // Different folders, so both names can exist on case-insensitive file systems
    await writeFiles(['layouts/layout1.json', 'layouts/Sub/Layout1.json']);
    const result = await validateProjectIntegrity(readerFor({ layouts: ['layout1'] }));
    const orphans = result.info.filter(i => i.check === 'orphaned-file');
    expect(orphans.map(i => i.entity)).toEqual(['layouts/Sub/Layout1.json']);
    expect(orphans[0].message).toContain('"layout1" is read from layouts/layout1.json');
    expect(byCheck(result.warnings, 'file-name-case-mismatch')).toEqual([]);
  });

  it('never gives delete advice for the loaded file when an exactly named copy sits in another folder', async () => {
    // layout1 is registered at the root: the reader reads layouts/layout1.json, i.e. Layout1.json on
    // case-insensitive file systems. Old/layout1.json has the exact name but is never read.
    await writeFiles(['layouts/Layout1.json', 'layouts/Old/layout1.json']);
    const result = await validateProjectIntegrity(readerFor({ layouts: ['layout1'] }));
    expect(byCheck(result.warnings, 'file-name-case-mismatch')).toEqual(['layouts/Layout1.json']);
    const orphans = result.info.filter(i => i.check === 'orphaned-file');
    expect(orphans.map(i => i.entity)).toEqual(['layouts/Old/layout1.json']);
    expect(orphans[0].suggestion).toContain('Compare it with layouts/layout1.json');
  });

  it('classifies by the project-bar folder the entity is registered in', async () => {
    // "Layout 1" is registered in folder Sub: Sub/layout 1.json is its file, the root copy is not read
    await writeFiles(['layouts/Sub/layout 1.json', 'layouts/Layout 1.json']);
    const result = await validateProjectIntegrity(readerFor({ layouts: ['Sub/Layout 1'] }));
    const mismatch = result.warnings.filter(w => w.check === 'file-name-case-mismatch');
    expect(mismatch.map(w => w.entity)).toEqual(['layouts/Sub/layout 1.json']);
    expect(mismatch[0].suggestion).toContain('Rename the file to "layouts/Sub/Layout 1.json"');
    const orphans = result.info.filter(i => i.check === 'orphaned-file');
    expect(orphans.map(i => i.entity)).toEqual(['layouts/Layout 1.json']);
    expect(orphans[0].message).toContain('"Layout 1" is read from layouts/Sub/Layout 1.json');
  });

  it('does not claim a case-variant file in another folder loads, and points to the expected path', async () => {
    // Only a case variant in the wrong folder: it is not read (the entity's file is missing)
    await writeFiles(['layouts/Old/Layout1.json']);
    const result = await validateProjectIntegrity(readerFor({ layouts: ['layout1'] }));
    expect(byCheck(result.warnings, 'file-name-case-mismatch')).toEqual([]);
    const orphans = result.info.filter(i => i.check === 'orphaned-file');
    expect(orphans.map(i => i.entity)).toEqual(['layouts/Old/Layout1.json']);
    expect(orphans[0].message).toContain('layouts/layout1.json');
    expect(orphans[0].message).toContain('that file is missing');
    expect(orphans[0].suggestion).toContain('move it to layouts/layout1.json');
  });

  it('lists .bak files in timelines (with subfolders) and next to project.c3proj, but not elsewhere in the root', async () => {
    await writeFiles([
      'project.c3proj.bak',
      'timelines/Timeline1.json.bak',
      'timelines/Folder1/Timeline2.json.bak',
      'timelines/transitions/Transition1.json.bak',
      'eventSheets/Sheet1.json.bak',
      'files/data.bak',
      'scripts/main.js.bak',
    ]);
    const result = await validateProjectIntegrity(readerFor({}));
    expect(byCheck(result.info, 'backup-file')).toEqual([
      'eventSheets/Sheet1.json.bak',
      'project.c3proj.bak',
      'timelines/Folder1/Timeline2.json.bak',
      'timelines/Timeline1.json.bak',
      'timelines/transitions/Transition1.json.bak',
    ]);
    const bak = result.info.find(i => i.check === 'backup-file')!;
    expect(bak.message).not.toContain('failed write');
  });
});

// ─── Real fixtures ─────────────────────────────────────────

describe('validateProjectIntegrity on real fixtures', () => {
  beforeEach(() => {
    resetProjectIndex();
  });

  it('stays clean on the editor-verified c3-loadable-minimal fixture', async () => {
    const reader = new Construct3ProjectReader(join(__dirname, '..', 'fixtures', 'c3-loadable-minimal', 'project.c3proj'));
    await reader.loadProject();
    const result = await validateProjectIntegrity(reader);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    const loadRuleChecks = ['expression-syntax', 'empty-expression', 'trigger-placement', 'else-placement', 'duplicate-object-name', 'family-plugin-mismatch', 'duplicate-sid'];
    expect(result.warnings.filter(w => loadRuleChecks.includes(w.check))).toEqual([]);
  });

  it('finds no load-time errors in the minimal-project fixture', async () => {
    const reader = new Construct3ProjectReader(join(__dirname, '..', 'fixtures', 'minimal-project', 'project.c3proj'));
    await reader.loadProject();
    const result = await validateProjectIntegrity(reader);
    expect(result.errors).toEqual([]);
  });

  it('reports the copy the reader does not load as orphaned, not the one it loads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'c3-integrity-folders-'));
    try {
      await cp(join(__dirname, '..', 'fixtures', 'minimal-project'), dir, { recursive: true });
      const projectPath = join(dir, 'project.c3proj');
      const project = JSON.parse(await readFile(projectPath, 'utf-8'));
      // Move "Layout 1" into project-bar folder Sub; layouts/Layout 1.json stays as a stale copy
      project.layouts = { items: [], subfolders: [{ items: ['Layout 1'], subfolders: [], name: 'Sub' }] };
      await writeFile(projectPath, JSON.stringify(project, null, '\t'), 'utf-8');
      const layout = JSON.parse(await readFile(join(dir, 'layouts', 'Layout 1.json'), 'utf-8'));
      await mkdir(join(dir, 'layouts', 'Sub'), { recursive: true });
      await writeFile(join(dir, 'layouts', 'Sub', 'Layout 1.json'), JSON.stringify({ ...layout, width: 4242 }), 'utf-8');

      const reader = new Construct3ProjectReader(projectPath);
      await reader.loadProject();
      expect((await reader.readLayout('Layout 1')).width).toBe(4242);
      const result = await validateProjectIntegrity(reader);
      expect(result.errors.filter(e => e.check === 'file-existence')).toEqual([]);
      expect(result.warnings.filter(w => w.check === 'file-name-case-mismatch')).toEqual([]);
      const orphans = result.info.filter(i => i.check === 'orphaned-file');
      expect(orphans.map(i => i.entity)).toEqual(['layouts/Layout 1.json']);
      expect(orphans[0].message).toContain('read from layouts/Sub/Layout 1.json');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('validate_project reports a project with the editor\'s Transitions folder as valid', async () => {
    // Timelines container as the editor saves it: the Transitions folder has no name key
    const dir = await mkdtemp(join(tmpdir(), 'c3-integrity-transitions-'));
    try {
      await cp(join(__dirname, '..', 'fixtures', 'minimal-project'), dir, { recursive: true });
      const projectPath = join(dir, 'project.c3proj');
      const project = JSON.parse(await readFile(projectPath, 'utf-8'));
      project.timelines = { items: ['Timeline1'], subfolders: [{ items: ['Transition1'], subfolders: [] }] };
      await writeFile(projectPath, JSON.stringify(project, null, '\t'), 'utf-8');
      await mkdir(join(dir, 'timelines', 'transitions'), { recursive: true });
      await writeFile(join(dir, 'timelines', 'Timeline1.json'), JSON.stringify({ name: 'Timeline1', tracks: [] }), 'utf-8');
      await writeFile(join(dir, 'timelines', 'transitions', 'Transition1.json'), JSON.stringify({ name: 'Transition1' }), 'utf-8');

      const reader = new Construct3ProjectReader(projectPath);
      await reader.loadProject();
      const server = new MockServer();
      registerAnalysisTools(server as any, reader);
      const result = await server.callTool('validate_project', {});
      const data = JSON.parse(result.content[0].text);
      expect(data.valid).toBe(true);
      expect(data.errors).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
