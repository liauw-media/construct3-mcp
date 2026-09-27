import { describe, it, expect } from 'vitest';
import {
  describeCharacter,
  generatePlaceholderPng,
  getImageFileName,
  invalidImageNameCharacter,
} from '../../src/construct3/png-generator.js';

describe('generatePlaceholderPng', () => {
  it('returns a buffer with valid PNG signature', () => {
    const png = generatePlaceholderPng();
    expect(Buffer.isBuffer(png)).toBe(true);
    // PNG signature: 137 80 78 71 13 10 26 10
    expect(png[0]).toBe(137);
    expect(png[1]).toBe(80);  // P
    expect(png[2]).toBe(78);  // N
    expect(png[3]).toBe(71);  // G
    expect(png[4]).toBe(13);
    expect(png[5]).toBe(10);
    expect(png[6]).toBe(26);
    expect(png[7]).toBe(10);
  });

  it('produces a non-trivial buffer (has IHDR, IDAT, IEND chunks)', () => {
    const png = generatePlaceholderPng(1, 1);
    // Minimum valid PNG is at least 60-70 bytes
    expect(png.length).toBeGreaterThan(50);

    // Check for IHDR chunk type at offset 12 (after 8-byte signature + 4-byte length)
    expect(png.toString('ascii', 12, 16)).toBe('IHDR');
  });

  it('produces default 1x1 image', () => {
    const png = generatePlaceholderPng();
    // IHDR data starts at offset 16 (8 sig + 4 len + 4 type)
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    expect(width).toBe(1);
    expect(height).toBe(1);
  });

  it('respects custom width and height', () => {
    const png = generatePlaceholderPng(64, 32);
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    expect(width).toBe(64);
    expect(height).toBe(32);
  });

  it('uses RGBA color type (6)', () => {
    const png = generatePlaceholderPng();
    // Color type is at IHDR offset + 9 = 16 + 8 + 1 = 25
    // Actually: offset 16 = width(4), offset 20 = height(4), offset 24 = bitDepth(1), offset 25 = colorType(1)
    expect(png[24]).toBe(8);  // bit depth
    expect(png[25]).toBe(6);  // RGBA
  });

  it('ends with IEND chunk', () => {
    const png = generatePlaceholderPng();
    // IEND is the last chunk: 4-byte length (0) + "IEND" + 4-byte CRC
    const iendMarker = png.toString('ascii', png.length - 8, png.length - 4);
    expect(iendMarker).toBe('IEND');
  });
});

describe('getImageFileName', () => {
  it('returns sprite filename, all lowercase, with padded index', () => {
    expect(getImageFileName('Hero', 'Walk', 0)).toBe('hero-walk-000.png');
    expect(getImageFileName('Hero', 'Walk', 5)).toBe('hero-walk-005.png');
    expect(getImageFileName('Hero', 'Walk', 123)).toBe('hero-walk-123.png');
  });

  it('handles Animation 1 default name', () => {
    expect(getImageFileName('Player', 'Animation 1', 0)).toBe('player-animation 1-000.png');
  });

  it('lowercases the animation name but keeps its spaces and punctuation', () => {
    expect(getImageFileName('Sprite1', 'Animation 1', 0)).toBe('sprite1-animation 1-000.png');
    expect(getImageFileName('Sprite1', 'WalkLeft', 12, 'Sprite')).toBe('sprite1-walkleft-012.png');
    expect(getImageFileName('Board', 'Big Sign (EN)', 3, 'Sprite')).toBe('board-big sign (en)-003.png');
  });

  it('lowercases TiledBg names with mixed case', () => {
    expect(getImageFileName('FloorTiles', '', 0, 'TiledBg')).toBe('floortiles.png');
  });

  it('returns TiledBg filename (just lowercase name)', () => {
    expect(getImageFileName('Background', '', 0, 'TiledBg')).toBe('background.png');
  });

  it('lowercases multi-word names', () => {
    expect(getImageFileName('CloseAuto', 'animation 1', 0)).toBe('closeauto-animation 1-000.png');
  });
});

describe('invalidImageNameCharacter', () => {
  it('accepts letters, digits, spaces and punctuation allowed in file names', () => {
    for (const name of ['Walk', 'Animation 1', 'walk_left-2', 'Big Sign (EN)', 'a.b', 'Run!']) {
      expect(invalidImageNameCharacter(name)).toBeUndefined();
    }
  });

  it('returns the first path separator, Windows-reserved or control character', () => {
    expect(invalidImageNameCharacter('Walk/Left')).toBe('/');
    expect(invalidImageNameCharacter('Walk\\Left')).toBe('\\');
    for (const char of [':', '*', '?', '"', '<', '>', '|', '\u0000', '\t', '\u001f']) {
      expect(invalidImageNameCharacter(`Walk${char}Left`)).toBe(char);
    }
    expect(invalidImageNameCharacter('a:b/c')).toBe(':');
  });

  it('describes control characters by code point', () => {
    expect(describeCharacter(':')).toBe('":"');
    expect(describeCharacter('\t')).toBe('control character U+0009');
  });
});
