/**
 * The possible-use search over files the bulk reads skipped (issue #55):
 * which files count as skipped, how rules decide a possible use, and what a
 * file that cannot be searched, or no longer exists, does.
 */

import { describe, it, expect } from 'vitest';
import { MockReader } from '../mocks/mock-reader.js';
import {
  blocksWithoutForce,
  checkUnscannedFiles,
  unscannedFilesOf,
  unscannedRefusal,
  unscannedWarnings,
  type UnscannedFile,
} from '../../src/construct3/analyzers/unscanned-uses.js';
import { nameTerm } from '../../src/construct3/raw-text-search.js';
import type { ReadFailure } from '../../src/construct3/project-reader.js';

describe('unscannedFilesOf', () => {
  it('lists registered names the bulk read skipped, with the reason, but not files that do not exist', () => {
    const failures = new Map<string, ReadFailure>([
      ['Big', { code: 'E_FILE_TOO_LARGE', message: 'File too large' }],
      ['Broken', { code: 'E_INVALID_JSON', message: 'Unexpected token' }],
      ['Denied', { code: 'E_READ_ERROR', message: 'EACCES' }],
      ['Ghost', { code: 'E_FILE_NOT_FOUND', message: 'ENOENT' }],
    ]);
    const files = unscannedFilesOf('layouts', ['Ok', 'Big', 'Broken', 'Denied', 'Ghost', 'Unknown'], new Map([['Ok', {}]]), failures);
    expect(files.map(f => [f.file, f.reason])).toEqual([
      ['layouts/Big', 'over the 10MB read limit'],
      ['layouts/Broken', 'not valid JSON'],
      ['layouts/Denied', 'could not be read'],
      ['layouts/Unknown', 'not read'],
    ]);
  });
});

describe('checkUnscannedFiles', () => {
  const file = (category: UnscannedFile['category'], name: string): UnscannedFile =>
    ({ category, name, file: `${category}/${name}`, reason: 'not valid JSON' });

  function readerWith(texts: Record<string, string>): MockReader {
    const reader = new MockReader();
    for (const [key, text] of Object.entries(texts)) {
      const [category, name] = key.split('/') as ['layouts' | 'objectTypes', string];
      reader.registerUnreadableEntity(category, name, { code: 'E_INVALID_JSON', message: 'bad' }, text);
    }
    return reader;
  }

  it('reports a possible use only when every group of a rule is in the file', async () => {
    const reader = readerWith({ 'layouts/A': '"Enemy.hp"', 'layouts/B': '"Player.hp"' });
    const reports = await checkUnscannedFiles(reader as never, [file('layouts', 'A'), file('layouts', 'B')], [
      { categories: ['layouts'], allOf: [[nameTerm('hp')], [nameTerm('Enemy')]] },
    ]);
    expect(reports).toEqual([
      { file: 'layouts/A', reason: 'not valid JSON', textSearch: 'possible-use', names: ['hp', 'Enemy'] },
      { file: 'layouts/B', reason: 'not valid JSON', textSearch: 'no-match' },
    ]);
    expect(blocksWithoutForce(reports)).toBe(true);
  });

  it('searches only the files of the rules\' categories, and nothing for rules with an empty group', async () => {
    const reader = readerWith({ 'layouts/A': '"Enemy"' });
    reader.failRawScanWith('objectTypes', 'X', new Error('must not be read'));
    expect(await checkUnscannedFiles(reader as never, [file('objectTypes', 'X')], [
      { categories: ['layouts'], allOf: [[nameTerm('Enemy')]] },
    ])).toEqual([]);
    expect(await checkUnscannedFiles(reader as never, [file('layouts', 'A')], [
      { categories: ['layouts'], allOf: [[nameTerm('Enemy')], []] },
    ])).toEqual([]);
  });

  it('a file that cannot be searched blocks; one that no longer exists is left out', async () => {
    const reader = readerWith({});
    reader.failRawScanWith('layouts', 'Denied', Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));
    reader.failRawScanWith('layouts', 'Gone', Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }));
    const reports = await checkUnscannedFiles(reader as never, [file('layouts', 'Denied'), file('layouts', 'Gone')], [
      { categories: ['layouts'], allOf: [[nameTerm('Enemy')]] },
    ]);
    expect(reports).toEqual([{ file: 'layouts/Denied', reason: 'not valid JSON', textSearch: 'unreadable' }]);
    expect(blocksWithoutForce(reports)).toBe(true);
    expect(unscannedRefusal(reports)).toBe(
      'Files that could not be parsed could not be searched for uses either: layouts/Denied (not valid JSON, not even as text).');
  });

  it('no match does not block, and is reported as searched as text only', async () => {
    const reports = [{ file: 'layouts/Big', reason: 'over the 10MB read limit', textSearch: 'no-match' as const }];
    expect(blocksWithoutForce(reports)).toBe(false);
    expect(unscannedRefusal(reports)).toBe('');
    expect(unscannedWarnings(reports, 'Deleted')).toEqual([
      'layouts/Big (over the 10MB read limit) could not be parsed and was only searched as text; the search found no possible use.',
    ]);
  });

  it('names possible uses as possible, in the refusal and in the forced warning', () => {
    const reports = [
      { file: 'layouts/Big', reason: 'over the 10MB read limit', textSearch: 'possible-use' as const, names: ['Enemy'] },
    ];
    expect(unscannedRefusal(reports)).toBe(
      'There are possible uses in files that could not be parsed: layouts/Big (over the 10MB read limit), whose text names "Enemy". ' +
      'They were found by a text search, which cannot tell a use from the same name in another string.');
    expect(unscannedWarnings(reports, 'Deleted')[0]).toMatch(/^Deleted with force=true: There are possible uses .* NOT changed\.$/);
  });
});
