/**
 * Tests for the C3 runtime bridge script generator and project injection.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateBridgeScript, getBridgeScriptPath, getBridgeProjectEntry } from '../../src/runtime/bridge.js';
import { readFile, writeFile, cp, rm, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

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
