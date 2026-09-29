/**
 * The image lookups of delete_object and of validate_project's orphaned-image
 * check take time in proportion to the files in images/ and the object types,
 * not to their product (issue #38 review: with 1000 object types and 12000
 * image files, delete_object took 17 s instead of under 1 s, and the check
 * several seconds). Counted instead of timed, so the tests do not depend on
 * the machine's load: how often images/ is indexed, and how many names are
 * normalized (nameKey).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as animationRename from '../../src/construct3/animation-rename.js';
import * as names from '../../src/construct3/names.js';
import { namedAfterAnyObject, planObjectImageParking } from '../../src/construct3/object-images.js';

vi.mock('../../src/construct3/animation-rename.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/construct3/animation-rename.js')>();
  return { ...actual, indexImageFiles: vi.fn(actual.indexImageFiles) };
});
vi.mock('../../src/construct3/names.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/construct3/names.js')>();
  return { ...actual, nameKey: vi.fn(actual.nameKey) };
});

/** A Sprite with `animations` animations of `frames` PNG frames. */
function sprite(name: string, animations = 3, frames = 4): Record<string, unknown> {
  return {
    name,
    animations: {
      items: Array.from({ length: animations }, (_, a) => ({
        name: `anim${a}`,
        frames: Array.from({ length: frames }, () => ({ fileType: 'image/png' })),
      })),
      subfolders: [],
    },
  };
}

/** The image files of the sprites `obj0` ... `obj<count - 1>` (sprite()), as the editor names them. */
function spriteFiles(count: number, animations = 3, frames = 4): string[] {
  const files: string[] = [];
  for (let o = 0; o < count; o++) {
    for (let a = 0; a < animations; a++) {
      for (let f = 0; f < frames; f++) files.push(`obj${o}-anim${a}-${String(f).padStart(3, '0')}.png`);
    }
  }
  return files;
}

beforeEach(() => {
  vi.mocked(animationRename.indexImageFiles).mockClear();
  vi.mocked(names.nameKey).mockClear();
});

describe('planObjectImageParking', () => {
  it('indexes images/ once, however many other object types there are', () => {
    const count = 500;
    const files = spriteFiles(count);
    const others = new Map(Array.from({ length: count - 1 }, (_, i) => [`obj${i + 1}`, sprite(`obj${i + 1}`)]));

    const plan = planObjectImageParking('obj0', sprite('obj0'), files, others, []);

    expect(plan.renames).toHaveLength(12);
    expect(plan.shared).toEqual([]);
    expect(animationRename.indexImageFiles).toHaveBeenCalledTimes(1);
    // One normalization per file for the index and the .bak names, and a few per frame looked up
    expect(vi.mocked(names.nameKey).mock.calls.length).toBeLessThan(10 * files.length);
  });

  it('still finds a file another object type uses under the same name', () => {
    // Object "a-b" animation "c" and object "a" animation "b-c" both name frame 0 "a-b-c-000.png"
    const files = ['a-b-c-000.png', 'a-x-000.png'];
    const own = { name: 'a', animations: { items: [{ name: 'b-c', frames: [{}] }, { name: 'x', frames: [{}] }], subfolders: [] } };
    const others = new Map<string, unknown>([['a-b', { name: 'a-b', animations: { items: [{ name: 'c', frames: [{}] }], subfolders: [] } }]]);

    const plan = planObjectImageParking('a', own, files, others, []);

    expect(plan.shared).toEqual(['a-b-c-000.png']);
    expect(plan.renames).toEqual([{ from: 'a-x-000.png', to: 'a-x-000.png.bak' }]);
    expect(animationRename.indexImageFiles).toHaveBeenCalledTimes(1);
  });
});

describe('namedAfterAnyObject (orphaned-image)', () => {
  it('normalizes each name and file once, not once per pair', () => {
    const objectNames = Array.from({ length: 1000 }, (_, i) => `obj${i}`);
    const files = [...spriteFiles(1000, 1, 3), 'gone-anim-000.png', 'gone.png'];

    const named = namedAfterAnyObject(objectNames);
    const orphans = files.filter(file => !named(file));

    expect(orphans).toEqual(['gone-anim-000.png', 'gone.png']);
    expect(vi.mocked(names.nameKey).mock.calls.length).toBe(objectNames.length + files.length);
  });

  it('matches like isNamedAfterObject: a frame "<object>-..." or a single image "<object>.<ext>", ignoring case and normalization', () => {
    const named = namedAfterAnyObject(['Hero', 'a-b', 'Café']);
    expect(named('hero-walk-000.png')).toBe(true);
    expect(named('HERO.png')).toBe(true);
    expect(named('a-b-c-000.png')).toBe(true);
    expect(named('a-c-000.png')).toBe(false);
    expect(named('café.png')).toBe(true);
    expect(named('heroes-walk-000.png')).toBe(false);
    expect(named('hero')).toBe(false);
  });
});
