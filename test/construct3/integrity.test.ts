/**
 * Unit tests for project integrity validation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MockReader } from '../mocks/mock-reader.js';
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
    expect(result.complete).toBe(true);
    expect(result.summary.errors).toBe(0);
    expect(result.summary.checksRun).toBe(13);
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

  it('reports oversized layouts as UNSCANNED warnings, not missing-file errors', async () => {
    const reader = validProject();
    reader.registerUnreadableLayout('HugeLayout', {
      code: 'E_FILE_TOO_LARGE',
      message: 'Failed to read layout "HugeLayout": File too large (45.6MB exceeds 10MB limit)',
    });
    const result = await validateProjectIntegrity(reader);

    // No false "missing or invalid JSON" error for a file that merely exceeds the size cap
    const falseError = result.errors.find(e => e.entity.includes('HugeLayout'));
    expect(falseError).toBeUndefined();

    const unscanned = result.warnings.find(w => w.check === 'unscanned-file' && w.entity === 'layouts/HugeLayout');
    expect(unscanned).toBeDefined();
    expect(unscanned!.message).toContain('UNSCANNED');
    expect(result.unscannedFiles).toContain('layouts/HugeLayout');
    expect(result.summary.unscanned).toBe(1);
  });

  it('reports a recorded non-size read failure as an error with the real reason', async () => {
    const reader = validProject();
    reader.registerUnreadableLayout('BrokenLayout', {
      code: 'E_INVALID_JSON',
      message: 'Failed to read layout "BrokenLayout": Unexpected token in JSON at position 12',
    });
    const result = await validateProjectIntegrity(reader);

    const err = result.errors.find(e => e.check === 'file-existence' && e.entity === 'layouts/BrokenLayout');
    expect(err).toBeDefined();
    expect(err!.message).toContain('Unexpected token');
    expect(result.summary.unscanned).toBe(0);
    expect(result.complete).toBe(true);
  });

  it('classifies unscanned files by failure code, not by message text', async () => {
    const reader = validProject();
    // A size-cap record whose message never says "too large" must still be
    // UNSCANNED, and a generic read error that happens to say "too large"
    // must still be an error. Rewording the reader's prose cannot flip either.
    reader.registerUnreadableLayout('Opaque', {
      code: 'E_FILE_TOO_LARGE',
      message: 'Failed to read layout "Opaque": (reason withheld)',
    });
    reader.registerUnreadableLayout('Denied', {
      code: 'E_READ_ERROR',
      message: 'Failed to read layout "Denied": EACCES, too large a permission problem',
    });
    const result = await validateProjectIntegrity(reader);

    expect(result.errors.find(e => e.entity === 'layouts/Opaque')).toBeUndefined();
    expect(result.warnings.find(w => w.check === 'unscanned-file' && w.entity === 'layouts/Opaque')).toBeDefined();
    expect(result.unscannedFiles).toEqual(['layouts/Opaque']);

    const denied = result.errors.find(e => e.check === 'file-existence' && e.entity === 'layouts/Denied');
    expect(denied).toBeDefined();
    expect(denied!.message).toContain('could not be read');
    expect(result.summary.unscanned).toBe(1);
  });

  it('reports complete: false while valid stays true when files were unscanned', async () => {
    const reader = validProject();
    reader.registerUnreadableLayout('HugeLayout', {
      code: 'E_FILE_TOO_LARGE',
      message: 'Failed to read layout "HugeLayout": File too large (45.6MB exceeds 10MB limit)',
    });
    const result = await validateProjectIntegrity(reader);

    // valid only vouches for the files that were scanned; complete says whether that was all of them
    expect(result.valid).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.summary.errors).toBe(0);
  });

  it('reports a missing file without leaking its absolute path', async () => {
    const reader = validProject();
    reader.registerUnreadableLayout('GhostLayout', {
      code: 'E_FILE_NOT_FOUND',
      message: "Failed to read layout \"GhostLayout\": ENOENT: no such file or directory, stat 'C:\\secret\\project\\layouts\\GhostLayout.json'",
    });
    const result = await validateProjectIntegrity(reader);

    expect(result.valid).toBe(false);
    expect(result.complete).toBe(true);
    const err = result.errors.find(e => e.check === 'file-existence' && e.entity === 'layouts/GhostLayout');
    expect(err).toBeDefined();
    expect(err!.message).toContain('no file exists at layouts/GhostLayout.json');
    expect(err!.message).not.toContain('secret');
  });

  it('classifies an unreadable object type the same way as a layout', async () => {
    const reader = validProject();
    reader.registerUnreadableEntity('objectTypes', 'BigGlobal', {
      code: 'E_FILE_TOO_LARGE',
      message: 'Failed to read object type "BigGlobal": File too large (12.0MB exceeds 10MB limit)',
    });
    const result = await validateProjectIntegrity(reader);

    expect(result.errors.find(e => e.entity === 'objectTypes/BigGlobal')).toBeUndefined();
    expect(result.warnings.find(w => w.check === 'unscanned-file' && w.entity === 'objectTypes/BigGlobal')).toBeDefined();
    expect(result.unscannedFiles).toContain('objectTypes/BigGlobal');
    expect(result.complete).toBe(false);
  });

  it('strips the absolute path from a generic read failure message', async () => {
    const reader = validProject();
    reader.registerUnreadableLayout('Locked', {
      code: 'E_READ_ERROR',
      message: "Failed to read layout \"Locked\": EACCES: permission denied, open 'C:\\secret\\project\\layouts\\Locked.json'",
    });
    const result = await validateProjectIntegrity(reader);

    const err = result.errors.find(e => e.check === 'file-existence' && e.entity === 'layouts/Locked');
    expect(err).toBeDefined();
    expect(err!.message).toContain('EACCES: permission denied');
    expect(err!.message).not.toContain('secret');
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
