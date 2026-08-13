/**
 * Unit tests for IdGenerator's handling of unreadable layouts.
 *
 * Layouts over the reader's size cap are skipped by readAllLayouts(), but
 * still hold live UIDs. The generator must recover the UID high-water mark
 * via the raw scan, and hard-fail UID minting when even that is impossible —
 * otherwise add_instance_to_layout mints duplicate UIDs.
 */

import { describe, it, expect } from 'vitest';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { MockReader } from '../mocks/mock-reader.js';

const TOO_LARGE = 'Failed to read layout "Big": File too large (45.6MB exceeds 10MB limit)';

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
    // No raw text registered — scanLayoutIdsRaw will throw
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
});
