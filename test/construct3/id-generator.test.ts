/**
 * Unit tests for IdGenerator's handling of unreadable and missing files.
 *
 * Layouts (and object types) over the reader's size cap are skipped by the
 * bulk readers, but still hold live UIDs. The generator must recover the UID
 * high-water mark via the raw scan, and hard-fail UID minting when even that
 * is impossible — otherwise add_instance_to_layout mints duplicate UIDs. A
 * registered file that does not exist holds no UIDs and must not block.
 *
 * These tests fake the I/O with MockReader; the same behaviour against real
 * files on disk is covered by read-failures.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import type { ReadFailure } from '../../src/construct3/project-reader.js';
import { MockReader } from '../mocks/mock-reader.js';

const TOO_LARGE: ReadFailure = {
  code: 'E_FILE_TOO_LARGE',
  message: 'Failed to read layout "Big": File too large (45.6MB exceeds 10MB limit)',
};

function readerWithSmallLayout() {
  return new MockReader({
    layouts: new Map([
      ['Small', {
        name: 'Small',
        sid: 300,
        layers: [{
          name: 'Main',
          sid: 301,
          instances: [{ type: 'Sprite', uid: 30042, sid: 302, properties: {} }],
        }],
      }],
    ]),
  });
}

describe('IdGenerator — unreadable layouts', () => {
  it('recovers the UID high-water mark from an unreadable layout via raw scan', async () => {
    const reader = readerWithSmallLayout();
    // Raw text carries a higher UID than anything the parsed layouts hold
    reader.registerUnreadableLayout('Big', TOO_LARGE,
      '{"layers":[{"instances":[{"uid": 30046, "sid": 123456789012345}]}]}');

    const idGen = new IdGenerator();
    const uid = await idGen.generateUid(reader as any);
    expect(uid).toBe(30047);
  });

  it('uses the parsed high-water mark when the raw scan finds nothing higher', async () => {
    const reader = readerWithSmallLayout();
    reader.registerUnreadableLayout('Big', TOO_LARGE,
      '{"layers":[{"instances":[{"uid": 7, "sid": 123456789012345}]}]}');

    const idGen = new IdGenerator();
    const uid = await idGen.generateUid(reader as any);
    expect(uid).toBe(30043);
  });

  it('hard-fails generateUid when a layout cannot be scanned at all', async () => {
    const reader = readerWithSmallLayout();
    // No raw text registered — scanEntityIdsRaw will throw
    reader.registerUnreadableLayout('Big', TOO_LARGE);

    const idGen = new IdGenerator();
    await expect(idGen.generateUid(reader as any)).rejects.toThrow(/Cannot generate a safe UID.*Big/);
  });

  it('still generates SIDs when a layout cannot be scanned (random SIDs are collision-safe)', async () => {
    const reader = readerWithSmallLayout();
    reader.registerUnreadableLayout('Big', TOO_LARGE);

    const idGen = new IdGenerator();
    const sid = await idGen.generateSid(reader as any);
    expect(sid).toBeGreaterThanOrEqual(100_000_000_000_000);
  });

  it('recovers after reset() once the layout becomes scannable', async () => {
    const reader = readerWithSmallLayout();
    reader.registerUnreadableLayout('Big', TOO_LARGE);

    const idGen = new IdGenerator();
    await expect(idGen.generateUid(reader as any)).rejects.toThrow(/Cannot generate a safe UID/);

    const healthyReader = readerWithSmallLayout();
    idGen.reset();
    const uid = await idGen.generateUid(healthyReader as any);
    expect(uid).toBe(30043);
  });

  it('skips a registered layout whose file is missing instead of blocking UID minting', async () => {
    const reader = readerWithSmallLayout();
    // No raw text: a scan attempt would throw. The typed record says the file
    // does not exist, so the generator must not even try.
    reader.registerUnreadableLayout('Ghost', {
      code: 'E_FILE_NOT_FOUND',
      message: 'Failed to read layout "Ghost": ENOENT: no such file or directory',
    });

    const idGen = new IdGenerator();
    expect(await idGen.generateUid(reader as any)).toBe(30043);
  });

  it('treats an ENOENT-coded raw-scan error as nothing to recover', async () => {
    const reader = readerWithSmallLayout();
    // The bulk read saw some other failure, but by the time the raw scan runs
    // the file is gone (e.g. a concurrent delete). Nothing left to protect.
    reader.registerUnreadableLayout('Vanished', {
      code: 'E_READ_ERROR',
      message: 'Failed to read layout "Vanished": EBUSY: resource busy or locked',
    });
    reader.failRawScanWith('layouts', 'Vanished',
      Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }));

    const idGen = new IdGenerator();
    expect(await idGen.generateUid(reader as any)).toBe(30043);
  });

  it('recovers singleglobal-inst.uid from an unreadable object type via raw scan', async () => {
    const reader = readerWithSmallLayout();
    reader.registerUnreadableEntity('objectTypes', 'BigGlobal', {
      code: 'E_FILE_TOO_LARGE',
      message: 'Failed to read object type "BigGlobal": File too large (12.0MB exceeds 10MB limit)',
    }, '{"name":"BigGlobal","singleglobal-inst":{"uid": 40000, "sid": 123456789012346}}');

    const idGen = new IdGenerator();
    expect(await idGen.generateUid(reader as any)).toBe(40001);
  });

  it('hard-fails generateUid when an object type cannot be scanned at all', async () => {
    const reader = readerWithSmallLayout();
    reader.registerUnreadableEntity('objectTypes', 'BigGlobal', {
      code: 'E_FILE_TOO_LARGE',
      message: 'Failed to read object type "BigGlobal": File too large (12.0MB exceeds 10MB limit)',
    });

    const idGen = new IdGenerator();
    await expect(idGen.generateUid(reader as any))
      .rejects.toThrow(/Cannot generate a safe UID.*objectTypes\/BigGlobal/);
  });
});
