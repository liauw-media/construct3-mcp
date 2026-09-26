/**
 * Unit tests for project integrity validation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'path';
import { MockReader } from '../mocks/mock-reader.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { validateProjectIntegrity } from '../../src/construct3/analyzers/integrity.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';

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
    expect(result.summary.checksRun).toBe(14);
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

  it('produces no errors on the editor-verified c3-loadable-minimal fixture', async () => {
    const fixture = join(__dirname, '..', 'fixtures', 'c3-loadable-minimal', 'project.c3proj');
    const reader = new Construct3ProjectReader(fixture);
    await reader.loadProject();
    const result = await validateProjectIntegrity(reader);
    expect(result.errors).toEqual([]);
  });

  // ─── Check 4: duplicate-sid ──────────────────────────────

  it('detects duplicate SIDs', async () => {
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
    const warn = result.warnings.find(w => w.check === 'duplicate-sid');
    expect(warn).toBeDefined();
    expect(warn!.message).toContain('999');
    expect(warn!.message).toContain('2 times');
  });

  it('detects duplicate SIDs in behavior types', async () => {
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
    const warn = result.warnings.find(w => w.check === 'duplicate-sid' && w.message.includes('500'));
    expect(warn).toBeDefined();
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

  // ─── Check 3b: subfolder-structure ────────────────────────

  it('detects subfolder missing name field', async () => {
    const reader = validProject();
    // Patch the project to add a nameless subfolder in timelines
    const origGetProject = reader.getProject.bind(reader);
    reader.getProject = () => {
      const proj = origGetProject();
      proj.timelines = {
        items: ['Timeline1'],
        subfolders: [{ items: ['T2'], subfolders: [] }], // no name!
      };
      return proj;
    };
    const result = await validateProjectIntegrity(reader);
    expect(result.valid).toBe(false);
    const err = result.errors.find((e: any) => e.check === 'subfolder-structure');
    expect(err).toBeDefined();
    expect(err!.message).toContain('missing required "name" field');
  });

  it('passes subfolder check when all subfolders have names', async () => {
    const reader = validProject();
    const result = await validateProjectIntegrity(reader);
    const err = result.errors.find((e: any) => e.check === 'subfolder-structure');
    expect(err).toBeUndefined();
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
  });
});
