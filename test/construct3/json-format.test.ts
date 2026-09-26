/**
 * Unit tests for json-format.ts — detecting and reapplying the on-disk text
 * style (line endings, trailing whitespace, BOM) of Construct 3 JSON files.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  C3_JSON_STYLE,
  applyJsonTextStyle,
  detectJsonTextStyle,
  jsonTextStyleOf,
  parseJsonText,
  projectJsonTextStyle,
  resolveJsonTextStyle,
  serializeJson,
  stripBom,
} from '../../src/construct3/json-format.js';

const BOM = '\uFEFF';
const DATA = { name: 'Sheet', events: [{ eventType: 'comment', text: 'a\nb' }], n: 0.5 };
const C3_TEXT = JSON.stringify(DATA, null, '\t');

describe('detectJsonTextStyle', () => {
  it('detects Construct 3 style (LF, no trailing newline, no BOM)', () => {
    expect(detectJsonTextStyle(C3_TEXT)).toEqual({ eol: '\n', trailing: '', bom: false });
  });

  it('detects CRLF with trailing newline and BOM', () => {
    const text = BOM + C3_TEXT.replace(/\n/g, '\r\n') + '\r\n';
    expect(detectJsonTextStyle(text)).toEqual({ eol: '\r\n', trailing: '\r\n', bom: true });
  });

  it('keeps the exact trailing whitespace (bare LF after CRLF, double newline)', () => {
    const crlfText = C3_TEXT.replace(/\n/g, '\r\n');
    expect(detectJsonTextStyle(crlfText + '\n')).toMatchObject({ eol: '\r\n', trailing: '\n' });
    expect(detectJsonTextStyle(C3_TEXT + '\n\n').trailing).toBe('\n\n');
    expect(detectJsonTextStyle(crlfText + '\r\n\r\n').trailing).toBe('\r\n\r\n');
  });

  it('reports undefined eol for single-line JSON', () => {
    expect(detectJsonTextStyle(JSON.stringify(DATA)).eol).toBeUndefined();
  });

  it('resolves mixed line endings to the majority', () => {
    expect(detectJsonTextStyle('{\r\n\t"a": 1,\r\n\t"b": 2\n}').eol).toBe('\r\n');
    expect(detectJsonTextStyle('{\n\t"a": 1,\n\t"b": 2\r\n}').eol).toBe('\n');
  });
});

describe('jsonTextStyleOf', () => {
  it('falls back to LF for single-line content by default', () => {
    expect(jsonTextStyleOf('{"a":1}')).toEqual({ eol: '\n', trailing: '', bom: false });
  });

  it('uses the given fallback line ending for single-line content', () => {
    expect(jsonTextStyleOf('{"a":1}', '\r\n').eol).toBe('\r\n');
  });
});

describe('applyJsonTextStyle / serializeJson', () => {
  it('default style is exactly JSON.stringify(data, null, "\\t")', () => {
    expect(serializeJson(DATA)).toBe(C3_TEXT);
    expect(serializeJson(DATA, C3_JSON_STYLE)).toBe(C3_TEXT);
  });

  it('writes CRLF + trailing newline + BOM when asked', () => {
    const out = serializeJson(DATA, { eol: '\r\n', trailing: '\r\n', bom: true });
    expect(out.startsWith(BOM + '{\r\n')).toBe(true);
    expect(out.charCodeAt(0)).toBe(0xfeff);
    expect(out.endsWith('}\r\n')).toBe(true);
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('keeps escaped newlines inside strings untouched', () => {
    const out = serializeJson(DATA, { eol: '\r\n', trailing: '', bom: false });
    expect(out).toContain('"a\\nb"');
    expect(parseJsonText(out)).toEqual(DATA);
  });

  it('round-trips bytes for every style combination', () => {
    for (const eol of ['\n', '\r\n'] as const) {
      for (const trailing of ['', '\n', '\r\n', '\n\n', '\r\n\r\n']) {
        for (const bom of [false, true]) {
          const original = applyJsonTextStyle(C3_TEXT, { eol, trailing, bom });
          const again = serializeJson(parseJsonText(original), jsonTextStyleOf(original));
          expect(again).toBe(original);
        }
      }
    }
  });

  it('keeps non-ASCII text literal, as Construct 3 does', () => {
    expect(serializeJson({ text: 'Größe £ °' })).toBe('{\n\t"text": "Größe £ °"\n}');
  });
});

describe('stripBom / parseJsonText', () => {
  it('strips only a leading BOM', () => {
    expect(stripBom(BOM + '{}')).toBe('{}');
    expect(stripBom('{}')).toBe('{}');
  });

  it('parses JSON with a BOM (plain JSON.parse rejects it)', () => {
    expect(BOM.charCodeAt(0)).toBe(0xfeff);
    expect(() => JSON.parse(BOM + '{"a":1}')).toThrow();
    expect(parseJsonText(BOM + '{"a":1}')).toEqual({ a: 1 });
  });
});

describe('projectJsonTextStyle / resolveJsonTextStyle', () => {
  let dir: string;
  const crlf = (text: string) => text.replace(/\n/g, '\r\n');

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'c3-jsonfmt-'));
    await mkdir(join(dir, 'eventSheets'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('existing file keeps its own style, whatever the project uses', async () => {
    await writeFile(join(dir, 'project.c3proj'), crlf(C3_TEXT));
    await writeFile(join(dir, 'eventSheets', 'A.json'), C3_TEXT + '\n');
    const style = await resolveJsonTextStyle(join(dir, 'eventSheets', 'A.json'), join(dir, 'project.c3proj'));
    expect(style).toEqual({ eol: '\n', trailing: '\n', bom: false });
  });

  it('new file follows project.c3proj', async () => {
    await writeFile(join(dir, 'project.c3proj'), BOM + crlf(C3_TEXT) + '\r\n');
    const style = await resolveJsonTextStyle(join(dir, 'eventSheets', 'New.json'), join(dir, 'project.c3proj'));
    expect(style).toEqual({ eol: '\r\n', trailing: '\r\n', bom: true });
  });

  it('falls back to a sibling JSON file when project.c3proj is single-line', async () => {
    await writeFile(join(dir, 'project.c3proj'), JSON.stringify(DATA));
    await writeFile(join(dir, 'eventSheets', 'A.json'), crlf(C3_TEXT));
    const style = await projectJsonTextStyle(join(dir, 'project.c3proj'), join(dir, 'eventSheets'));
    expect(style.eol).toBe('\r\n');
  });

  it("falls back to Construct 3's own style when nothing gives a hint", async () => {
    await writeFile(join(dir, 'project.c3proj'), JSON.stringify(DATA));
    const style = await projectJsonTextStyle(join(dir, 'project.c3proj'), join(dir, 'missing-folder'));
    expect(style).toEqual(C3_JSON_STYLE);
  });

  it('existing single-line file keeps its BOM and trailing whitespace and takes the project line ending', async () => {
    await writeFile(join(dir, 'project.c3proj'), crlf(C3_TEXT));
    await writeFile(join(dir, 'eventSheets', 'Flat.json'), BOM + JSON.stringify(DATA));
    const style = await resolveJsonTextStyle(join(dir, 'eventSheets', 'Flat.json'), join(dir, 'project.c3proj'));
    expect(style).toEqual({ eol: '\r\n', trailing: '', bom: true });
  });
});
