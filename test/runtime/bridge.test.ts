/**
 * Tests for the C3 runtime bridge script generator and project injection.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateBridgeScript, getBridgeScriptPath, getBridgeProjectEntry } from '../../src/runtime/bridge.js';
import { writeZip } from '../../src/runtime/zip-writer.js';
import { readFile, writeFile, cp, rm, mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const FIXTURE_DIR = join(import.meta.dirname, '..', 'fixtures', 'minimal-project');

describe('generateBridgeScript', () => {
  it('returns a non-empty string', () => {
    const script = generateBridgeScript();
    expect(script).toBeTruthy();
    expect(typeof script).toBe('string');
    expect(script.length).toBeGreaterThan(100);
  });

  it('contains runOnStartup', () => {
    const script = generateBridgeScript();
    expect(script).toContain('runOnStartup');
  });

  it('exposes __c3Runtime on globalThis', () => {
    const script = generateBridgeScript();
    expect(script).toContain('globalThis.__c3Runtime');
  });

  it('exposes __c3bridge on globalThis', () => {
    const script = generateBridgeScript();
    expect(script).toContain('globalThis.__c3bridge');
  });

  it('supports all expected command types', () => {
    const script = generateBridgeScript();
    const expectedCommands = [
      'callFunction',
      'getGlobalVar',
      'setGlobalVar',
      'getObjectState',
      'getAllInstances',
      'getLayout',
      'goToLayout',
      'evaluateExpression',
      'listObjects',
      'listGlobalVars',
      'ping',
    ];
    for (const cmd of expectedCommands) {
      expect(script).toContain(`"${cmd}"`);
    }
  });

  it('processes commands on tick event', () => {
    const script = generateBridgeScript();
    expect(script).toContain('addEventListener("tick"');
  });

  it('has a submit and getResult interface', () => {
    const script = generateBridgeScript();
    expect(script).toContain('submit(type, args)');
    expect(script).toContain('getResult(id)');
  });

  it('includes a getState method', () => {
    const script = generateBridgeScript();
    expect(script).toContain('getState()');
    expect(script).toContain('layoutName');
    expect(script).toContain('tickCount');
  });
});

describe('getBridgeScriptPath', () => {
  it('returns a path inside scripts/', () => {
    const path = getBridgeScriptPath();
    expect(path).toMatch(/^scripts\//);
    expect(path).toContain('c3-runtime-bridge.js');
  });
});

describe('getBridgeProjectEntry', () => {
  it('returns correct entry metadata', () => {
    const entry = getBridgeProjectEntry();
    expect(entry.name).toBe('c3-runtime-bridge.js');
    expect(entry.type).toBe('script');
    expect(entry.purpose).toBe('none');
  });
});

describe('bridge injection into c3proj', () => {
  let tempDir: string;

  beforeEach(async () => {
    // Copy minimal-project fixture to a temp directory
    tempDir = join(tmpdir(), `c3-bridge-test-${Date.now()}`);
    await cp(FIXTURE_DIR, tempDir, { recursive: true });
  });

  afterEach(async () => {
    if (tempDir && existsSync(tempDir)) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('can write bridge script to project scripts/ dir', async () => {
    const scriptsDir = join(tempDir, 'scripts');
    await mkdir(scriptsDir, { recursive: true });

    const bridgePath = join(tempDir, getBridgeScriptPath());
    await writeFile(bridgePath, generateBridgeScript(), 'utf-8');

    expect(existsSync(bridgePath)).toBe(true);
    const content = await readFile(bridgePath, 'utf-8');
    expect(content).toContain('runOnStartup');
  });

  it('can register bridge in rootFileFolders.script.items', async () => {
    const c3projPath = join(tempDir, 'project.c3proj');
    const raw = await readFile(c3projPath, 'utf-8');
    const c3proj = JSON.parse(raw);

    // Verify empty initial state
    expect(c3proj.rootFileFolders.script.items).toHaveLength(0);

    // Add bridge entry
    const sid = Math.floor(Math.random() * 900_000_000_000_000) + 100_000_000_000_000;
    c3proj.rootFileFolders.script.items.push({
      name: 'c3-runtime-bridge.js',
      type: 'application/javascript',
      sid,
      'file-info': { purpose: 'none' },
    });

    await writeFile(c3projPath, JSON.stringify(c3proj, null, '\t'), 'utf-8');

    // Verify it's registered
    const reloaded = JSON.parse(await readFile(c3projPath, 'utf-8'));
    const scriptItems = reloaded.rootFileFolders.script.items;
    expect(scriptItems).toHaveLength(1);
    expect(scriptItems[0].name).toBe('c3-runtime-bridge.js');
    expect(scriptItems[0].type).toBe('application/javascript');
    expect(scriptItems[0].sid).toBeGreaterThan(100_000_000_000_000);
  });

  it('can remove bridge from rootFileFolders.script.items', async () => {
    const c3projPath = join(tempDir, 'project.c3proj');
    const raw = await readFile(c3projPath, 'utf-8');
    const c3proj = JSON.parse(raw);

    // Add then remove
    c3proj.rootFileFolders.script.items.push({
      name: 'c3-runtime-bridge.js',
      type: 'application/javascript',
      sid: 999999999999999,
      'file-info': { purpose: 'none' },
    });
    expect(c3proj.rootFileFolders.script.items).toHaveLength(1);

    c3proj.rootFileFolders.script.items = c3proj.rootFileFolders.script.items.filter(
      (s: { name: string }) => s.name !== 'c3-runtime-bridge.js'
    );
    expect(c3proj.rootFileFolders.script.items).toHaveLength(0);

    await writeFile(c3projPath, JSON.stringify(c3proj, null, '\t'), 'utf-8');

    const reloaded = JSON.parse(await readFile(c3projPath, 'utf-8'));
    expect(reloaded.rootFileFolders.script.items).toHaveLength(0);
  });

  it('does not duplicate bridge entry when injecting twice', async () => {
    const c3projPath = join(tempDir, 'project.c3proj');

    for (let i = 0; i < 2; i++) {
      const raw = await readFile(c3projPath, 'utf-8');
      const c3proj = JSON.parse(raw);
      const items = c3proj.rootFileFolders.script.items;
      const exists = items.some((s: { name: string }) => s.name === 'c3-runtime-bridge.js');

      if (!exists) {
        items.push({
          name: 'c3-runtime-bridge.js',
          type: 'application/javascript',
          sid: Math.floor(Math.random() * 900_000_000_000_000) + 100_000_000_000_000,
          'file-info': { purpose: 'none' },
        });
        await writeFile(c3projPath, JSON.stringify(c3proj, null, '\t'), 'utf-8');
      }
    }

    const final = JSON.parse(await readFile(c3projPath, 'utf-8'));
    const bridgeEntries = final.rootFileFolders.script.items.filter(
      (s: { name: string }) => s.name === 'c3-runtime-bridge.js'
    );
    expect(bridgeEntries).toHaveLength(1);
  });

  it('preserves existing c3proj structure after bridge injection', async () => {
    const c3projPath = join(tempDir, 'project.c3proj');
    const originalRaw = await readFile(c3projPath, 'utf-8');
    const original = JSON.parse(originalRaw);

    // Inject bridge
    original.rootFileFolders.script.items.push({
      name: 'c3-runtime-bridge.js',
      type: 'application/javascript',
      sid: 123456789012345,
      'file-info': { purpose: 'none' },
    });
    await writeFile(c3projPath, JSON.stringify(original, null, '\t'), 'utf-8');

    // Verify non-script parts are untouched
    const modified = JSON.parse(await readFile(c3projPath, 'utf-8'));
    expect(modified.name).toBe('TestProject');
    expect(modified.runtime).toBe('c3');
    expect(modified.useWorker).toBe('dom');
    expect(modified.viewportWidth).toBe(1920);
    expect(modified.viewportHeight).toBe(1080);
    expect(modified.rootFileFolders.sound.items).toEqual(original.rootFileFolders.sound.items);
    expect(modified.rootFileFolders.icon.items).toEqual(original.rootFileFolders.icon.items);
  });

  it('fixture useWorker is dom (required for bridge)', async () => {
    const c3projPath = join(tempDir, 'project.c3proj');
    const c3proj = JSON.parse(await readFile(c3projPath, 'utf-8'));
    expect(c3proj.useWorker).toBe('dom');
  });
});

describe('writeZip (c3p packing)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `c3-zip-test-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    if (tempDir && existsSync(tempDir)) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('creates a valid zip file from entries', async () => {
    const outputPath = join(tempDir, 'test.c3p');
    await writeZip([
      { path: 'project.c3proj', data: Buffer.from('{"name":"Test"}') },
      { path: 'scripts/main.js', data: Buffer.from('console.log("hello")') },
    ], outputPath);

    expect(existsSync(outputPath)).toBe(true);
    const zipData = await readFile(outputPath);
    // ZIP magic number: PK\x03\x04
    expect(zipData[0]).toBe(0x50); // P
    expect(zipData[1]).toBe(0x4B); // K
    expect(zipData[2]).toBe(0x03);
    expect(zipData[3]).toBe(0x04);
  });

  it('produces a zip with the correct number of entries', async () => {
    const entries = [
      { path: 'a.txt', data: Buffer.from('aaa') },
      { path: 'b.txt', data: Buffer.from('bbb') },
      { path: 'sub/c.txt', data: Buffer.from('ccc') },
    ];
    const outputPath = join(tempDir, 'multi.c3p');
    await writeZip(entries, outputPath);

    const zipData = await readFile(outputPath);
    // Count local file headers (PK\x03\x04)
    let count = 0;
    for (let i = 0; i < zipData.length - 4; i++) {
      if (zipData[i] === 0x50 && zipData[i+1] === 0x4B &&
          zipData[i+2] === 0x03 && zipData[i+3] === 0x04) {
        count++;
      }
    }
    expect(count).toBe(3);
  });

  it('stores file data that can be read back', async () => {
    const content = 'Hello from Construct 3!';
    const outputPath = join(tempDir, 'readable.c3p');
    await writeZip([
      { path: 'test.txt', data: Buffer.from(content) },
    ], outputPath);

    const zipData = await readFile(outputPath);
    // STORE method means data is uncompressed in the zip
    expect(zipData.includes(Buffer.from(content))).toBe(true);
  });

  it('handles empty entries array', async () => {
    const outputPath = join(tempDir, 'empty.c3p');
    await writeZip([], outputPath);

    expect(existsSync(outputPath)).toBe(true);
    const zipData = await readFile(outputPath);
    // Should at least have EOCD (end of central directory)
    expect(zipData.length).toBeGreaterThan(0);
    // EOCD signature: PK\x05\x06
    const eocdSig = zipData.indexOf(Buffer.from([0x50, 0x4B, 0x05, 0x06]));
    expect(eocdSig).toBeGreaterThanOrEqual(0);
  });

  it('handles binary file data', async () => {
    const binaryData = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) binaryData[i] = i;

    const outputPath = join(tempDir, 'binary.c3p');
    await writeZip([
      { path: 'image.png', data: binaryData },
    ], outputPath);

    const zipData = await readFile(outputPath);
    expect(zipData.includes(binaryData)).toBe(true);
  });

  it('can pack the minimal project fixture', async () => {
    const fixtureDir = FIXTURE_DIR;
    const entries: Array<{ path: string; data: Buffer }> = [];

    // Collect all fixture files
    async function collect(dir: string, prefix = '') {
      const items = await readdir(dir, { withFileTypes: true });
      for (const item of items) {
        const relPath = prefix ? `${prefix}/${item.name}` : item.name;
        if (item.isDirectory()) {
          await collect(join(dir, item.name), relPath);
        } else if (item.isFile()) {
          entries.push({
            path: relPath,
            data: await readFile(join(dir, item.name)),
          });
        }
      }
    }
    await collect(fixtureDir);

    const outputPath = join(tempDir, 'minimal-project.c3p');
    await writeZip(entries, outputPath);

    expect(existsSync(outputPath)).toBe(true);
    const zipStat = await stat(outputPath);
    expect(zipStat.size).toBeGreaterThan(100);
    expect(entries.length).toBeGreaterThan(3); // at least c3proj + some other files
  });
});
