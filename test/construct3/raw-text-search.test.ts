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
  RawTextEncodingError,
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

  it('finds a name outside ASCII also as \\u escapes (Python json.dump), in either case of the hex digits', () => {
    expect(has(String.raw`"objectClass": "Gegnér"`, 'Gegnér')).toBe(true);
    expect(has(String.raw`"x": "GEGNÉR.X"`, 'Gegnér')).toBe(true);
    expect(has(String.raw`"x": "Écran"`, 'Écran')).toBe(true);
    // A character outside the BMP is a surrogate pair of escapes
    expect(has(String.raw`"type": "Boss👾"`, 'Boss\u{1F47E}')).toBe(true);
    expect(has(String.raw`"type": "Gegnérs"`, 'Gegnér')).toBe(false);
  });

  it('treats a \\u escape before or after the name as the character it stands for', () => {
    // A control character (vertical tab) before the name starts a word, a letter does not
    expect(has(String.raw`"script": "const a = 1;\u000bEnemy.getFirstInstance();"`, 'Enemy')).toBe(true);
    expect(has(String.raw`"type": "éEnemy"`, 'Enemy')).toBe(false);
    // A letter written as an escape after the name goes on with the word
    expect(has(String.raw`"type": "Enemyé"`, 'Enemy')).toBe(false);
    expect(has(String.raw`"type": "Enemy "`, 'Enemy')).toBe(true);
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

  it('finds a shorter name where the longer one goes on with a letter outside ASCII', () => {
    expect([...searchText('"x": "EnemyBossé Enemy.X"', [nameTerm('EnemyBoss'), nameTerm('Enemy')])]).toEqual(['Enemy']);
    expect([...searchText('"x": "EnemyBossé EnemyBullet"', [nameTerm('EnemyBoss'), nameTerm('Enemy')])]).toEqual([]);
  });

  it('with many names that start one another, finds each one only as a whole word', () => {
    const names = ['Obj1', 'Obj10', 'Obj100', 'Obj1000', 'Enemy', 'EnemyBoss', 'EnemyBossX'];
    const found = searchText('"Obj100" "EnemyBossY" "Obj10000" "enemyboss.X"', names.map(n => nameTerm(n)));
    expect([...found].sort()).toEqual(['EnemyBoss', 'Obj100']);
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

  it('decides a name next to an escape the same wherever the text is cut', () => {
    const cases: Array<[string, string, boolean]> = [
      [String.raw`"s":"a;\u000bEnemy.x"`, 'Enemy', true],
      [String.raw`"s":"éEnemy"`, 'Enemy', false],
      [String.raw`"s":"Enemyé"`, 'Enemy', false],
      [String.raw`"s":"Enemy👾"`, 'Enemy', true],
      [String.raw`"s":"Gegnér"`, 'Gegnér', true],
    ];
    for (const [text, name, expected] of cases) {
      for (let cut = 0; cut <= text.length; cut++) {
        expect(searchInPieces(text, cut, name), `${text} cut at ${cut}`).toBe(expected);
      }
    }
  });

  it('decides a name the same wherever a long text is cut into many small pieces', () => {
    // Pieces shorter than the context: the carried text is searched again with each piece
    const text = `${'x '.repeat(40)}"\\u00e9Enemy" "EnemyBullet" ${'y '.repeat(40)}"a;\\u000bBoss"`;
    for (let size = 1; size <= 40; size++) {
      const search = new RawTextSearch([nameTerm('Enemy'), nameTerm('Boss')]);
      for (let i = 0; i < text.length; i += size) search.push(text.slice(i, i + size));
      expect([...search.finish()], `pieces of ${size}`).toEqual(['Boss']);
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

  it('reads a UTF-16LE file that starts with its byte order mark (PowerShell 5.1 writes these)', async () => {
    const path = join(dir, 'utf16le.json');
    const text = `{"layers":[{"instances":[{"type":"Enemy","uid":1}]}],"pad":"${'x'.repeat(1024 * 1024)}","b":"Gegnér"}`;
    await writeFile(path, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));
    const found = await searchFileText(path, [nameTerm('Enemy'), nameTerm('Gegnér'), nameTerm('Player')]);
    expect([...found].sort()).toEqual(['Enemy', 'Gegnér']);
  });

  it('rejects a file it cannot read as text: UTF-16BE, or NUL characters (UTF-16 without byte order mark, binary)', async () => {
    const be = join(dir, 'utf16be.json');
    await writeFile(be, Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('{"type":"Enemy"}', 'utf16le').swap16()]));
    await expect(searchFileText(be, [nameTerm('Zombie')])).rejects.toBeInstanceOf(RawTextEncodingError);

    const noBom = join(dir, 'utf16-no-bom.json');
    await writeFile(noBom, Buffer.from('{"type":"Enemy"}', 'utf16le'));
    const error = await searchFileText(noBom, [nameTerm('Zombie')]).catch(e => e);
    expect(error).toBeInstanceOf(RawTextEncodingError);
    expect((error as { code?: string }).code).not.toBe('ENOENT');
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
