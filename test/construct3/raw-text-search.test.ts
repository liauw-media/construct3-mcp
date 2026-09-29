/**
 * Text search of files the bulk reads skip (issue #55): whole-word names
 * ignoring case, numbers, bounded patterns, matches across chunk boundaries,
 * and files over the reader's 10MB cap.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  RawTextSearch,
  nameTerm,
  numberTerm,
  patternTerm,
  searchFileText,
  searchText,
} from '../../src/construct3/raw-text-search.js';

const has = (text: string, name: string) => searchText(text, [nameTerm(name)]).has(name);

describe('nameTerm', () => {
  it('matches the name as a whole word, ignoring case', () => {
    expect(has('"type": "Enemy"', 'Enemy')).toBe(true);
    expect(has('"x": "Enemy.X + 1"', 'Enemy')).toBe(true);
    expect(has('"x": "enemy(0).X"', 'Enemy')).toBe(true);
    expect(has('"script": "runtime.objects.ENEMY.getFirstInstance()"', 'Enemy')).toBe(true);
    expect(has('"members": ["Enemy"]', 'Enemy')).toBe(true);
    expect(has('Enemy', 'Enemy')).toBe(true);
  });

  it('does not match a longer name that contains it', () => {
    expect(has('"type": "EnemyBullet"', 'Enemy')).toBe(false);
    expect(has('"type": "BigEnemy"', 'Enemy')).toBe(false);
    expect(has('"x": "Enemy2.X"', 'Enemy')).toBe(false);
    expect(has('"x": "_Enemy"', 'Enemy')).toBe(false);
    expect(has('"type": "Énemy"', 'nemy')).toBe(false);
  });

  it('matches after a JSON escape such as \\n or \\t in script text', () => {
    expect(has(String.raw`"script": "const a = 1;\nEnemy.x = 2;"`, 'Enemy')).toBe(true);
    expect(has(String.raw`"script": "\tEnemy"`, 'Enemy')).toBe(true);
    expect(has(String.raw`"value": "\"Enemy\""`, 'Enemy')).toBe(true);
  });

  it('searches names with spaces and regular expression characters literally', () => {
    expect(has('"layout": "Level (1)"', 'Level (1)')).toBe(true);
    expect(has('"layout": "Level 11"', 'Level (1)')).toBe(false);
    expect(has('"eventSheet": "Event sheet 1"', 'Event sheet 1')).toBe(true);
    expect(has('"a.b": 1', 'a.b')).toBe(true);
    expect(has('"axb": 1', 'a.b')).toBe(false);
  });

  it('searches a name as JSON writes it inside a string', () => {
    expect(has(String.raw`"text": "say \"hi\""`, 'say "hi"')).toBe(true);
  });

  it('reports the key it was given', () => {
    expect([...searchText('"Enemy"', [nameTerm('Enemy', 'the object')])]).toEqual(['the object']);
  });
});

describe('numberTerm and patternTerm', () => {
  it('matches a number as a whole number', () => {
    const term = numberTerm(710000000000001, 'sid');
    expect(searchText('"object": 710000000000001,', [term]).has('sid')).toBe(true);
    expect(searchText('"object": 7100000000000012,', [term]).has('sid')).toBe(false);
    expect(searchText('"object": 1710000000000001,', [term]).has('sid')).toBe(false);
  });

  it('matches a pattern', () => {
    const term = patternTerm('instances', String.raw`"uid"\s{0,64}:\s{0,64}\d`, 140);
    expect(searchText('{"type":"A","uid": 12}', [term]).has('instances')).toBe(true);
    expect(searchText('{"uids": []}', [term]).has('instances')).toBe(false);
  });

  it('finds a shorter name where a longer one that starts with it is not a whole word', () => {
    const found = searchText('"x": "Enemy Bossy"', [nameTerm('Enemy Boss'), nameTerm('Enemy')]);
    expect([...found]).toEqual(['Enemy']);
  });

  it('ignores the case of letters outside ASCII too', () => {
    expect(has('"type": "ÉCRAN"', 'écran')).toBe(true);
  });

  it('finds several terms, each once', () => {
    const found = searchText('Enemy Player Enemy', [nameTerm('Enemy'), nameTerm('Player'), nameTerm('Boss')]);
    expect([...found].sort()).toEqual(['Enemy', 'Player']);
  });
});

describe('RawTextSearch across pieces', () => {
  function searchInPieces(text: string, cut: number, name: string): boolean {
    const search = new RawTextSearch([nameTerm(name)]);
    search.push(text.slice(0, cut));
    search.push(text.slice(cut));
    return search.finish().has(name);
  }

  it('finds a name wherever the text is cut', () => {
    const text = '{"layers":[{"instances":[{"type":"Enemy","uid":1}]}]}';
    for (let cut = 0; cut <= text.length; cut++) {
      expect(searchInPieces(text, cut, 'Enemy'), `cut at ${cut}`).toBe(true);
    }
  });

  it('does not match a longer name wherever the text is cut', () => {
    for (const text of ['"type":"EnemyBullet"', '"type":"BigEnemy"', String.raw`"s":"\\nEnemyX"`]) {
      for (let cut = 0; cut <= text.length; cut++) {
        expect(searchInPieces(text, cut, 'Enemy'), `${text} cut at ${cut}`).toBe(false);
      }
    }
  });

  it('is done once every term was found', () => {
    const search = new RawTextSearch([nameTerm('A'), nameTerm('B')]);
    search.push('"A" and ');
    expect(search.done).toBe(false);
    search.push('"B" and more');
    expect(search.done).toBe(true);
    expect([...search.finish()].sort()).toEqual(['A', 'B']);
  });
});

describe('searchFileText', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'c3-rawsearch-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it('reads a file over the 10MB read cap to the end, and across the 1MB stream chunks', async () => {
    const path = join(dir, 'big.json');
    const chunk = 1024 * 1024;
    // "Enemy" straddles the first chunk boundary; "Boss" is past 10MB
    const head = ' '.repeat(chunk - 3);
    await writeFile(path, Buffer.concat([
      Buffer.from(`${head}"Enemy"`),
      Buffer.alloc(10 * chunk + 100, 0x20),
      Buffer.from('"type": "Boss"'),
    ]));
    const found = await searchFileText(path, [nameTerm('Enemy'), nameTerm('Boss'), nameTerm('Player')]);
    expect([...found].sort()).toEqual(['Boss', 'Enemy']);
  });

  it('reads multi-byte characters split across chunks', async () => {
    const path = join(dir, 'utf8.json');
    await writeFile(path, `${'x'.repeat(1024 * 1024 - 1)} "Ënemy"`);
    expect(await searchFileText(path, [nameTerm('ënemy')])).toEqual(new Set(['ënemy']));
  });

  it('rejects with the fs error: ENOENT for a missing file, another code for a directory', async () => {
    await expect(searchFileText(join(dir, 'missing.json'), [nameTerm('A')])).rejects.toMatchObject({ code: 'ENOENT' });
    await mkdir(join(dir, 'folder.json'));
    const error = await searchFileText(join(dir, 'folder.json'), [nameTerm('A')]).catch(e => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as { code?: string }).code).not.toBe('ENOENT');
  });

  it('does not open the file when there is nothing to search for', async () => {
    expect(await searchFileText(join(dir, 'missing.json'), [])).toEqual(new Set());
  });
});
