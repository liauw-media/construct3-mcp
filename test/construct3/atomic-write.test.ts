/**
 * Tests for atomic-write.ts: resolving a path to the file name on disk, and
 * atomic replacement that keeps that name (issue #29).
 *
 * The resolution logic runs against an injected directory lookup, so it is
 * tested for case-insensitive and case-sensitive file systems on any machine.
 * The file-system tests run only where the temp directory has the matching
 * case behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';
import {
  atomicReplace,
  existingSpelling,
  findFileIgnoringCase,
  type DirectoryLookup,
} from '../../src/construct3/atomic-write.js';
import { isCaseInsensitiveFs } from '../helpers/fs-case.js';

const caseInsensitive = isCaseInsensitiveFs();

function enoent(path: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, '${path}'`), { code: 'ENOENT' });
}

/** Directory listings as a file system that does or does not ignore case would report them. */
function fakeFs(listings: Record<string, string[]>, ignoresCase: boolean): DirectoryLookup {
  const same = (a: string, b: string) =>
    ignoresCase ? a.normalize().toLowerCase() === b.normalize().toLowerCase() : a === b;
  return {
    async stat(path) {
      if (!(listings[dirname(path)] ?? []).some(e => same(e, basename(path)))) throw enoent(path);
      return {};
    },
    async readdir(path) {
      const entries = listings[path];
      if (!entries) throw enoent(path);
      return entries;
    },
  };
}

const dir = join('project', 'layouts');
const at = (name: string) => join(dir, name);

describe('existingSpelling', () => {
  it('resolves a path to the file name on disk when only the case differs (case-insensitive file system)', async () => {
    const fs = fakeFs({ [dir]: ['Layout1.json', 'Other.json'] }, true);
    expect(await existingSpelling(at('layout1.json'), fs)).toBe(at('Layout1.json'));
    expect(await existingSpelling(at('LAYOUT1.JSON'), fs)).toBe(at('Layout1.json'));
  });

  it('keeps a path that is spelled like the file on disk', async () => {
    const fs = fakeFs({ [dir]: ['Layout1.json'] }, true);
    expect(await existingSpelling(at('Layout1.json'), fs)).toBe(at('Layout1.json'));
  });

  it('keeps the path of a new file', async () => {
    const fs = fakeFs({ [dir]: ['Layout1.json'] }, true);
    expect(await existingSpelling(at('Layout2.json'), fs)).toBe(at('Layout2.json'));
    expect(await existingSpelling(join('project', 'missing', 'x.json'), fs)).toBe(join('project', 'missing', 'x.json'));
  });

  it('never picks another file on a case-sensitive file system', async () => {
    // layout1.json does not exist there; writing it creates a separate file
    const fs = fakeFs({ [dir]: ['Layout1.json'] }, false);
    expect(await existingSpelling(at('layout1.json'), fs)).toBe(at('layout1.json'));
  });

  it('keeps the path when several names on disk match ignoring case', async () => {
    const fs = fakeFs({ [dir]: ['Layout1.json', 'LAYOUT1.json'] }, true);
    expect(await existingSpelling(at('layout1.json'), fs)).toBe(at('layout1.json'));
  });

  it('matches names that differ in Unicode normalization', async () => {
    const onDisk = 'Café.json'; // decomposed (NFD), as some macOS volumes store it
    const fs = fakeFs({ [dir]: [onDisk] }, true);
    expect(await existingSpelling(at('café.json'), fs)).toBe(at(onDisk));
  });

  it('keeps the path when the directory cannot be listed', async () => {
    const fs: DirectoryLookup = {
      stat: async () => ({}),
      readdir: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); },
    };
    expect(await existingSpelling(at('layout1.json'), fs)).toBe(at('layout1.json'));
  });
});

describe('findFileIgnoringCase', () => {
  it('finds a file whose name differs only in case, whatever the file system', async () => {
    for (const ignoresCase of [true, false]) {
      const fs = fakeFs({ [dir]: ['Layout1.json'] }, ignoresCase);
      expect(await findFileIgnoringCase(at('layout1.json'), fs)).toBe(at('Layout1.json'));
    }
  });

  it('prefers the exact name', async () => {
    const fs = fakeFs({ [dir]: ['LAYOUT1.json', 'Layout1.json'] }, false);
    expect(await findFileIgnoringCase(at('Layout1.json'), fs)).toBe(at('Layout1.json'));
  });

  it('returns undefined when nothing matches or the directory is missing', async () => {
    const fs = fakeFs({ [dir]: ['Layout1.json'] }, true);
    expect(await findFileIgnoringCase(at('Layout2.json'), fs)).toBeUndefined();
    expect(await findFileIgnoringCase(join('project', 'missing', 'x.json'), fs)).toBeUndefined();
  });
});

describe('atomicReplace on disk', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'c3-atomic-case-'));
    await writeFile(join(tmp, 'Layout1.json'), '{"v":1}', 'utf-8');
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('creates a new file and leaves no temp file', async () => {
    expect(await atomicReplace(join(tmp, 'Layout2.json'), '{"v":2}')).toBe(join(tmp, 'Layout2.json'));
    expect((await readdir(tmp)).sort()).toEqual(['Layout1.json', 'Layout2.json']);
  });

  it.skipIf(!caseInsensitive)('keeps the file name on disk when the path differs only in case', async () => {
    const written = await atomicReplace(join(tmp, 'layout1.json'), '{"v":2}');
    expect(written).toBe(join(tmp, 'Layout1.json'));
    expect(await readdir(tmp)).toEqual(['Layout1.json']);
    expect(await readFile(join(tmp, 'Layout1.json'), 'utf-8')).toBe('{"v":2}');
  });

  it.skipIf(caseInsensitive)('writes a separate file on a case-sensitive file system', async () => {
    await atomicReplace(join(tmp, 'layout1.json'), '{"v":2}');
    expect((await readdir(tmp)).sort()).toEqual(['Layout1.json', 'layout1.json']);
    expect(await readFile(join(tmp, 'Layout1.json'), 'utf-8')).toBe('{"v":1}');
  });
});
