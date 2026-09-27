import { describe, it, expect } from 'vitest';
import { findFolderPathClash, findNameClash, nameKey } from '../../src/construct3/names.js';

describe('nameKey', () => {
  it('lowercases and applies Unicode normalization (NFC)', () => {
    expect(nameKey('Level1')).toBe('level1');
    // "é" as e + combining acute (NFD) and as one code point (NFC)
    expect(nameKey('Café')).toBe(nameKey('café'));
  });
});

describe('findNameClash', () => {
  it('returns the existing name that equals the new one ignoring case', () => {
    expect(findNameClash('mainsheet', ['Other', 'MainSheet'])).toBe('MainSheet');
    expect(findNameClash('LEVEL 1', ['Level 1'])).toBe('Level 1');
  });

  it('prefers the exact name when both spellings exist', () => {
    expect(findNameClash('Sheet1', ['SHEET1', 'Sheet1'])).toBe('Sheet1');
  });

  it('returns undefined when no name matches', () => {
    expect(findNameClash('Sheet2', ['Sheet1', 'Sheet 2'])).toBeUndefined();
    expect(findNameClash('Sheet2', [])).toBeUndefined();
  });
});

describe('findFolderPathClash', () => {
  const container = {
    items: [],
    subfolders: [
      { items: ['Ease1'], subfolders: [] }, // nameless (timelines Transitions folder)
      { items: [], subfolders: [{ items: [], subfolders: [], name: 'Menus' }], name: 'Panels' },
      { items: [], subfolders: [], name: 'Levels' },
    ],
  };

  it('returns undefined for existing folders spelled exactly and for new folders', () => {
    expect(findFolderPathClash(container, 'Panels')).toBeUndefined();
    expect(findFolderPathClash(container, 'Panels/Menus')).toBeUndefined();
    expect(findFolderPathClash(container, 'Panels/New/Deeper')).toBeUndefined();
    expect(findFolderPathClash(container, 'Brand New')).toBeUndefined();
    expect(findFolderPathClash(undefined, 'Panels')).toBeUndefined();
  });

  it('returns the path spelled like the existing folders when a folder differs only in case', () => {
    expect(findFolderPathClash(container, 'panels')).toBe('Panels');
    expect(findFolderPathClash(container, 'panels/Menus')).toBe('Panels/Menus');
    expect(findFolderPathClash(container, 'Panels/menus')).toBe('Panels/Menus');
    expect(findFolderPathClash(container, 'LEVELS/Extra')).toBe('Levels/Extra');
  });

  it('skips folders without a name', () => {
    const onlyNameless = { items: [], subfolders: [{ items: ['X'], subfolders: [] }, { items: ['Y'], subfolders: [], name: '' }] };
    expect(findFolderPathClash(onlyNameless, 'transitions')).toBeUndefined();
    expect(findFolderPathClash(onlyNameless, 'x')).toBeUndefined();
  });
});
