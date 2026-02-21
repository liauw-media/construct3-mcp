import { describe, it, expect } from 'vitest';
import { validateName, validateSubfolder, toolResult, toolError } from '../../src/tools/shared.js';

describe('validateName', () => {
  it('accepts valid names', () => {
    expect(() => validateName('Player')).not.toThrow();
    expect(() => validateName('Enemy_1')).not.toThrow();
    expect(() => validateName('_private')).not.toThrow();
    expect(() => validateName('My Sprite')).not.toThrow();
  });

  it('rejects empty name', () => {
    expect(() => validateName('')).toThrow('Name cannot be empty');
  });

  it('rejects names over 200 characters', () => {
    expect(() => validateName('a'.repeat(201))).toThrow('Name too long');
  });

  it('rejects names starting with a number', () => {
    expect(() => validateName('1Player')).toThrow('must start with a letter');
  });

  it('rejects names with special characters', () => {
    expect(() => validateName('Player@1')).toThrow('must start with a letter');
    expect(() => validateName('foo-bar')).toThrow('must start with a letter');
  });

  it('rejects names containing dots (path traversal characters)', () => {
    // Dots fail the alphanumeric regex check before reaching the explicit path traversal check
    expect(() => validateName('a..b')).toThrow('must start with a letter');
    expect(() => validateName('foo/bar')).toThrow('must start with a letter');
  });

  it('rejects reserved names', () => {
    expect(() => validateName('System')).toThrow('reserved name');
    expect(() => validateName('system')).toThrow('reserved name');
  });
});

describe('validateSubfolder', () => {
  it('accepts valid subfolder paths', () => {
    expect(() => validateSubfolder('UI')).not.toThrow();
    expect(() => validateSubfolder('UI/Buttons')).not.toThrow();
    expect(() => validateSubfolder('Enemies/Boss/Phase1')).not.toThrow();
  });

  it('rejects path traversal', () => {
    expect(() => validateSubfolder('../escape')).toThrow();
    expect(() => validateSubfolder('foo/../bar')).toThrow();
  });

  it('rejects backslashes', () => {
    expect(() => validateSubfolder('UI\\Buttons')).toThrow();
  });

  it('rejects leading slash', () => {
    expect(() => validateSubfolder('/absolute')).toThrow();
  });

  it('rejects empty segments', () => {
    expect(() => validateSubfolder('UI//Buttons')).toThrow();
  });
});

describe('toolResult', () => {
  it('wraps data as MCP text content', () => {
    const result = toolResult({ success: true });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(JSON.parse(result.content[0].text)).toEqual({ success: true });
  });
});

describe('toolError', () => {
  it('wraps message as MCP error content', () => {
    const result = toolError('Something failed');
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toBe('Something failed');
    expect(result.isError).toBe(true);
  });
});
