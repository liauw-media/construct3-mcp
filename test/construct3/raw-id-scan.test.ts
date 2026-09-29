/**
 * The UID/SID text scan of layouts and object types the reader skips
 * (issue #49), streamed since issue #59:
 * - the streamed scan finds exactly what a scan of the whole text finds,
 *   wherever the pieces are cut;
 * - it never holds the file as one string, so a file larger than a
 *   JavaScript string can hold (about 512MB) no longer refuses new UIDs.
 *   Writing such a file in a test is too slow, so this file lowers the
 *   string limit: `readFile` with an encoding throws what it throws for a
 *   608MB file on Node 22 (RangeError "Invalid string length") for files
 *   over LOWERED_STRING_LIMIT bytes;
 * - it reads a file with a UTF-16LE byte order mark as UTF-16LE, and counts
 *   a file it cannot read as text (UTF-16BE, NUL characters) as unscannable,
 *   as the text search of the reference checks does (issue #55).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, cp, rm, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { RawIdScan } from '../../src/construct3/raw-text-search.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { registerMutationTools } from '../../src/tools/mutations.js';
import { MockServer } from '../mocks/mock-server.js';

const stringLimit = vi.hoisted(() => ({ bytes: Infinity }));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const [path, options] = args;
      const encoding = typeof options === 'string' ? options : options?.encoding;
      if (encoding && typeof path === 'string' && (await actual.stat(path)).size > stringLimit.bytes) {
        throw new RangeError('Invalid string length');
      }
      return actual.readFile(...args);
    },
  };
});

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');
/** Must match MAX_FILE_SIZE in src/construct3/project-reader.ts */
const READER_SIZE_CAP = 10 * 1024 * 1024;
/** Stands in for the ~512MB a JavaScript string can hold */
const LOWERED_STRING_LIMIT = READER_SIZE_CAP + 64 * 1024;

let tmpDir: string;

/** The scan of #49: two regular expressions over the whole text. */
function wholeTextScan(content: string): { highestUid: number; sids: number[] } {
  let highestUid = 0;
  for (const match of content.matchAll(/"uid"\s*:\s*(\d+)/g)) highestUid = Math.max(highestUid, Number(match[1]));
  const sids = [...content.matchAll(/"sid"\s*:\s*(\d+)/g)].map(match => Number(match[1]));
  return { highestUid, sids };
}

function streamedScan(pieces: string[]): { highestUid: number; sids: number[] } {
  const scan = new RawIdScan();
  for (const piece of pieces) scan.push(piece);
  return scan.finish();
}

/** Deterministic pseudo-random numbers (mulberry32), so a failure can be reproduced. */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Text made of entry fragments and characters that can start, continue or break an entry. */
function randomText(next: () => number): string {
  const parts = ['"uid"', '"sid"', '"uid": ', '"sid":', ' : ', ':', '"', 'u', 's', 'id', 'd"', ' ', '\n\t\t', '\u00a0', ',', 'x',
    '0', '7', '42', '000', '123456789012345', '999999999999999', '"uid":\t\n 31', '"sid" \n:\n 510000000000001'];
  let text = '';
  const length = Math.floor(next() * 40);
  for (let i = 0; i < length; i++) text += parts[Math.floor(next() * parts.length)];
  return text;
}

/** `text` cut into pieces of random length (1 to maxPiece characters). */
function cut(text: string, next: () => number, maxPiece: number): string[] {
  const pieces: string[] = [];
  for (let i = 0; i < text.length;) {
    const size = 1 + Math.floor(next() * maxPiece);
    pieces.push(text.slice(i, i + size));
    i += size;
  }
  return pieces;
}

async function registerLayout(name: string): Promise<void> {
  const c3projPath = join(tmpDir, 'project.c3proj');
  const project = JSON.parse(await readFile(c3projPath, 'utf-8'));
  project.layouts.items.push(name);
  await writeFile(c3projPath, JSON.stringify(project, null, '\t'));
}

/** A layout over the read cap: its highest UID comes after a string of spaces that pushes it past the cap. */
function bigLayoutText(name: string, highUid: number): string {
  return `{"name":${JSON.stringify(name)},"layers":[{"name":"Main","sid":610000000000001,"instances":[` +
    `{"type":"Sprite","uid":7,"sid":610000000000002,"properties":{},"tags":"${' '.repeat(READER_SIZE_CAP + 128 * 1024)}"},` +
    `{"type":"Sprite","uid":${highUid},"sid":610000000000003,"properties":{}}]}],"sid":610000000000004,` +
    `"eventSheet":"MainSheet","width":1920,"height":1080}`;
}

async function openReader(): Promise<Construct3ProjectReader> {
  const reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  return reader;
}

beforeEach(async () => {
  resetProjectIndex();
  stringLimit.bytes = Infinity;
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-idscan-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
});

afterEach(async () => {
  stringLimit.bytes = Infinity;
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
});

describe('RawIdScan', () => {
  it('finds what a scan of the whole text finds, wherever the pieces are cut', () => {
    const next = random(59);
    for (let round = 0; round < 3000; round++) {
      const text = randomText(next);
      const expected = wholeTextScan(text);
      expect(streamedScan([text]), text).toEqual(expected);
      expect(streamedScan(cut(text, next, 1 + Math.floor(next() * 12))), JSON.stringify(text)).toEqual(expected);
    }
  });

  it('keeps a number cut by piece boundaries whole, leading zeros and very long digit runs included', () => {
    const cases = [
      ['"uid": 12', '34', '5, "sid": 9'],
      ['"uid"', ' ', ':', ' 0', '0', '7'],
      ['"uid"', 'sid": 5'],
      ['"uid" ', 'sid": 5'],
      ['"ui', 'd"', ':', '1'],
      ['"uid":', ...Array.from({ length: 50 }, () => '9'.repeat(20)), '}'],
      ['"sid":', '0'.repeat(1000), '42'],
    ];
    for (const pieces of cases) expect(streamedScan(pieces), JSON.stringify(pieces)).toEqual(wholeTextScan(pieces.join('')));
  });

  it('holds only the cut-off start of an entry between pieces, however much whitespace follows the key', () => {
    const scan = new RawIdScan();
    scan.push('{"uid"');
    for (let i = 0; i < 1000; i++) scan.push(' '.repeat(1024));
    scan.push(':');
    for (let i = 0; i < 1000; i++) scan.push('\n'.repeat(1024));
    scan.push('31}');
    expect(scan.finish()).toEqual({ highestUid: 31, sids: [] });
  });
});

describe('UID allocation next to a layout larger than a string can hold', () => {
  it('generateUid allocates above its UIDs instead of refusing', async () => {
    await registerLayout('Huge');
    await writeFile(join(tmpDir, 'layouts', 'Huge.json'), bigLayoutText('Huge', 40046));
    stringLimit.bytes = LOWERED_STRING_LIMIT;
    // The lowered limit is in force: the whole file cannot be read as one string
    await expect(readFile(join(tmpDir, 'layouts', 'Huge.json'), 'utf-8')).rejects.toThrow('Invalid string length');

    const reader = await openReader();
    const scan = await reader.scanEntityIdsRaw('layouts', 'Huge');
    expect(scan.highestUid).toBe(40046);
    expect(scan.sids).toEqual([610000000000001, 610000000000002, 610000000000003, 610000000000004]);
    expect(await new IdGenerator().generateUid(reader)).toBe(40047);
  });

  it('add_instance_to_layout places the instance above its UIDs', async () => {
    await registerLayout('Huge');
    await writeFile(join(tmpDir, 'layouts', 'Huge.json'), bigLayoutText('Huge', 40046));
    stringLimit.bytes = LOWERED_STRING_LIMIT;
    const reader = await openReader();
    const idGen = new IdGenerator();
    const server = new MockServer();
    registerMutationTools(server as never, reader, new Construct3ProjectWriter(reader, idGen), idGen);

    const result = await server.callTool('add_instance_to_layout',
      { layoutName: 'Layout 1', layerName: 'Main', objectType: 'Sprite', x: 10, y: 20 });
    expect(result.isError, result.content[0].text).toBeUndefined();
    expect(JSON.parse(result.content[0].text).success).toBe(true);
    const layout = JSON.parse(await readFile(join(tmpDir, 'layouts', 'Layout 1.json'), 'utf-8'));
    expect(layout.layers[0].instances.map((i: { uid: number }) => i.uid)).toContain(40047);
  });
});

describe('UID scan of files in other encodings', () => {
  it('reads a layout with a UTF-16LE byte order mark as UTF-16LE', async () => {
    await registerLayout('Wide');
    const text = bigLayoutText('Wide', 50046);
    await writeFile(join(tmpDir, 'layouts', 'Wide.json'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));
    const reader = await openReader();

    expect((await reader.scanEntityIdsRaw('layouts', 'Wide')).highestUid).toBe(50046);
    expect(await new IdGenerator().generateUid(reader)).toBe(50047);
  });

  it('refuses a new UID, naming the file, when a layout holds NUL characters (UTF-16 without a byte order mark)', async () => {
    await registerLayout('NoBom');
    await writeFile(join(tmpDir, 'layouts', 'NoBom.json'), Buffer.from(bigLayoutText('NoBom', 60046), 'utf16le'));
    const reader = await openReader();

    await expect(reader.scanEntityIdsRaw('layouts', 'NoBom')).rejects.toMatchObject({ code: 'E_TEXT_ENCODING' });
    await expect(new IdGenerator().generateUid(reader)).rejects.toThrow(/Cannot generate a safe UID.*layouts\/NoBom/);
  });
});
