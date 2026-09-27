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
    expect(result.summary.checksRun).toBe(19);
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
    const loadRuleChecks = ['expression-syntax', 'empty-expression', 'trigger-placement', 'duplicate-object-name', 'family-plugin-mismatch', 'duplicate-sid'];
    expect(result.warnings.filter(w => loadRuleChecks.includes(w.check))).toEqual([]);
  });

  it('finds no load-time errors in the minimal-project fixture', async () => {
    const reader = new Construct3ProjectReader(join(__dirname, '..', 'fixtures', 'minimal-project', 'project.c3proj'));
    await reader.loadProject();
    const result = await validateProjectIntegrity(reader);
    expect(result.errors).toEqual([]);
  });
});
