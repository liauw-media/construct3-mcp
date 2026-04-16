/**
 * M1 End-to-End Acceptance Test (VAL-02)
 *
 * Proves that the MCP primitive surface built in Phases 1-6 is sufficient to
 * build a minimal playable Construct 3 project from scratch using ONLY the
 * registered tool handlers — no direct JSON manipulation.
 *
 * Flow:
 *   1. create_object      — Sprite with default animation
 *   2. create_event_sheet — new event sheet
 *   3. create_layout      — new layout with a layer
 *   4. add_instance_to_layout — place the Sprite on the layout
 *   5. add_event_block    — condition + action event block on the sheet
 *   6. pack_project       — produce a .c3p ZIP archive
 *
 * Assertions:
 *   (a) .c3p file exists on disk
 *   (b) ZIP contains project.c3proj (can be unpacked without error)
 *   (c) Event sheet referenced by layout exists in the project
 *   (d) Object placed in layout exists in the project
 *   (e) Structure is internally consistent (no orphaned references)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, cp, readFile, rm, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';

import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { MockServer } from '../mocks/mock-server.js';

import { registerObjectTools } from '../../src/tools/object-tools.js';
import { registerEventTools } from '../../src/tools/event-tools.js';
import { registerLayoutTools } from '../../src/tools/layout-tools.js';
import { registerRuntimeTools } from '../../src/tools/runtime-tools.js';

// ZIP reading (used to verify the .c3p can be unpacked)
import { createUnzip } from 'zlib';
import { createReadStream } from 'fs';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

// ── helpers ────────────────────────────────────────────────────────────────

function parseResult(result: { content: Array<{ type: string; text: string }>; isError?: boolean }) {
  if (result.isError) {
    throw new Error(`Tool returned error: ${result.content[0]?.text ?? '(no message)'}`);
  }
  return JSON.parse(result.content[0].text);
}

async function createTempProject(): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), 'c3-e2e-'));
  await cp(FIXTURE_DIR, tmp, { recursive: true });
  return tmp;
}

/**
 * Read the ZIP directory: return the set of entry names.
 * We parse a ZIP by scanning for local file headers (PK\x03\x04).
 * This is intentionally minimal — it just proves the file is a valid ZIP
 * and lists what's inside, without pulling in any dependency.
 */
async function listZipEntries(zipPath: string): Promise<string[]> {
  const buf = await readFile(zipPath);
  const names: string[] = [];
  let i = 0;
  while (i < buf.length - 30) {
    // Local file header signature: 50 4B 03 04
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x03 && buf[i + 3] === 0x04) {
      const fnLen = buf.readUInt16LE(i + 26);
      const extraLen = buf.readUInt16LE(i + 28);
      const name = buf.subarray(i + 30, i + 30 + fnLen).toString('utf-8');
      names.push(name);
      const compressedSize = buf.readUInt32LE(i + 18);
      i += 30 + fnLen + extraLen + compressedSize;
    } else {
      i++;
    }
  }
  return names;
}

// ── test suite ─────────────────────────────────────────────────────────────

describe('M1 End-to-End Acceptance (VAL-02)', () => {
  let tmpDir: string;
  let reader: Construct3ProjectReader;
  let writer: Construct3ProjectWriter;
  let idGen: IdGenerator;
  let server: MockServer;
  let outputC3p: string;

  beforeEach(async () => {
    tmpDir = await createTempProject();

    reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
    await reader.loadProject();

    idGen = new IdGenerator();
    await idGen.initialize(reader);

    writer = new Construct3ProjectWriter(reader, idGen);

    server = new MockServer();
    const deps = { server, reader, writer, idGen } as any;

    // Register all tool domains needed for the acceptance flow
    registerObjectTools(deps);
    registerEventTools(deps);
    registerLayoutTools(deps);
    registerRuntimeTools(deps);

    outputC3p = join(tmpDir, 'acceptance-output.c3p');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('builds a minimal playable project end-to-end through MCP tool calls', async () => {

    // ── Step 1: create_object (Sprite) ─────────────────────────────────────
    const createObjResult = parseResult(
      await server.callTool('create_object', {
        name: 'Hero',
        pluginId: 'Sprite',
      }),
    );
    expect(createObjResult.success).toBe(true);
    expect(createObjResult.entity).toBe('Hero');

    // ── Step 2: create_event_sheet ──────────────────────────────────────────
    const createSheetResult = parseResult(
      await server.callTool('create_event_sheet', {
        name: 'GameSheet',
      }),
    );
    expect(createSheetResult.success).toBe(true);
    expect(createSheetResult.entity).toBe('GameSheet');

    // ── Step 3: create_layout ───────────────────────────────────────────────
    const createLayoutResult = parseResult(
      await server.callTool('create_layout', {
        name: 'GameLevel',
        eventSheet: 'GameSheet',
        layers: ['Game'],
      }),
    );
    expect(createLayoutResult.success).toBe(true);
    expect(createLayoutResult.entity).toBe('GameLevel');

    // ── Step 4: add_instance_to_layout ─────────────────────────────────────
    const addInstanceResult = parseResult(
      await server.callTool('add_instance_to_layout', {
        layoutName: 'GameLevel',
        layerName: 'Game',
        objectType: 'Hero',
        x: 100,
        y: 200,
      }),
    );
    expect(addInstanceResult.success).toBe(true);

    // ── Step 5: add_event_block ─────────────────────────────────────────────
    const addEventResult = parseResult(
      await server.callTool('add_event_block', {
        sheetName: 'GameSheet',
        conditions: [
          {
            id: 'on-start-of-layout',
            objectClass: 'System',
          },
        ],
        actions: [
          {
            id: 'set-x',
            objectClass: 'Hero',
          },
        ],
      }),
    );
    expect(addEventResult.success).toBe(true);

    // ── Step 6: pack_project ────────────────────────────────────────────────
    const packResult = parseResult(
      await server.callTool('pack_project', {
        outputPath: outputC3p,
        injectBridge: false,
      }),
    );
    expect(packResult.packed).toBe(true);
    expect(packResult.outputPath).toBe(outputC3p);

    // ── Assertion (a): .c3p file exists ────────────────────────────────────
    expect(existsSync(outputC3p)).toBe(true);
    const stat = await import('fs/promises').then(m => m.stat(outputC3p));
    expect(stat.size).toBeGreaterThan(100);

    // ── Assertion (b): ZIP is valid and contains project.c3proj ────────────
    const zipEntries = await listZipEntries(outputC3p);
    expect(zipEntries.length).toBeGreaterThan(0);
    const hasC3proj = zipEntries.some(e => e.endsWith('.c3proj'));
    expect(hasC3proj).toBe(true);

    // ── Assertion (c): Event sheet referenced by layout exists ─────────────
    // Re-read project after all mutations to get fresh state
    await reader.loadProject();
    const layouts = await reader.listLayouts();
    expect(layouts).toContain('GameLevel');

    const layoutData = await reader.readLayout('GameLevel');
    const boundSheet = (layoutData as any).eventSheet ?? (layoutData as any)['event-sheet'];
    expect(boundSheet).toBe('GameSheet');

    const eventSheets = await reader.listEventSheets();
    expect(eventSheets).toContain('GameSheet');

    // ── Assertion (d): Object placed in layout exists in project ───────────
    const objectTypes = await reader.listObjectTypes();
    expect(objectTypes).toContain('Hero');

    // Verify the layout instance references the object
    // Layout layers is a direct array (not .items); instances is also a direct array
    const layerData = (layoutData as any);
    const layers: Array<{ name: string; instances: Array<{ type: string }> }> =
      Array.isArray(layerData.layers) ? layerData.layers : (layerData.layers?.items ?? []);
    const gameLayer = layers.find(l => l.name === 'Game');
    expect(gameLayer).toBeDefined();
    const instances: Array<{ type: string }> = Array.isArray(gameLayer?.instances)
      ? gameLayer.instances
      : (gameLayer?.instances as any)?.items ?? [];
    const heroInstance = instances.find(inst => inst.type === 'Hero');
    expect(heroInstance).toBeDefined();

    // ── Assertion (e): Internal consistency ────────────────────────────────
    // The event sheet that GameLevel references must be in the project index
    const c3projRaw = await readFile(join(tmpDir, 'project.c3proj'), 'utf-8');
    const c3proj = JSON.parse(c3projRaw);
    const sheetItems: string[] = c3proj.eventSheets?.items ?? [];
    expect(sheetItems).toContain('GameSheet');

    const objectItems: string[] = c3proj.objectTypes?.items ?? [];
    expect(objectItems).toContain('Hero');

    const layoutItems: string[] = c3proj.layouts?.items ?? [];
    expect(layoutItems).toContain('GameLevel');
  });

  it('pack_project produces a non-empty ZIP with correct structure', async () => {
    // Simpler smoke: pack the vanilla fixture (no mutations)
    const packResult = parseResult(
      await server.callTool('pack_project', {
        outputPath: outputC3p,
        injectBridge: false,
      }),
    );
    expect(packResult.packed).toBe(true);
    expect(packResult.fileCount).toBeGreaterThan(0);

    const zipEntries = await listZipEntries(outputC3p);
    expect(zipEntries).toContain('project.c3proj');
  });
});
