/**
 * Hierarchy (scene graph) links when instances are deleted (issue #38): the
 * editor stores both sides of a link (the child's sceneGraphData
 * "parent-uid", the parent's "children" entry), children can sit on another
 * layer than their parent, and a new instance can get the UID of a deleted
 * one. delete_instance_from_layout and delete_layer remove the links to the
 * instances they delete, the ID generator never hands out a UID a link still
 * names, and validate_project reports links that do not hold up
 * (hierarchy-link). Checked on a temp copy of the minimal fixture with the
 * real reader and writer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cp, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { registerLayoutTools } from '../../src/tools/layout-tools.js';
import { validateProjectIntegrity } from '../../src/construct3/analyzers/integrity.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { findHierarchyLinkProblems } from '../../src/construct3/hierarchy.js';
import { scanIdsInText } from '../../src/construct3/project-reader.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

// The shape of Scirra's example projects (three-cups): flags and preview as the editor saves them
const FLAGS = { x: true, y: true, z: false, w: true, h: true, a: false, o: false, v: false, d: true, sm: 'normal' };
const PREVIEW = {
  transformX: 0, transformY: 0, transformZElevation: 0, transformW: 0, transformH: 0, transformA: 0,
  transformSX: 0, transformSY: 0, transformO: 0, previewSceneGraph: false,
};

type Json = Record<string, any>;

let tmpDir: string;
let reader: Construct3ProjectReader;
let server: MockServer;

const layoutPath = () => join(tmpDir, 'layouts', 'Layout 1.json');
const readLayout = async (): Promise<Json> => JSON.parse(await readFile(layoutPath(), 'utf8'));

function instance(uid: number, sceneGraphData?: Json): Json {
  return {
    type: 'Sprite', properties: {}, uid, sid: 500000000000100 + uid, tags: '', instanceVariables: {}, behaviors: {},
    ...(sceneGraphData ? { sceneGraphData } : {}),
    world: { x: 10 * uid, y: 0, width: 64, height: 64 },
  };
}

const parentRecord = (uid: number, children: number[]): Json =>
  ({ 'parent-uid': null, uid, children: children.map(c => ({ uid: c, flags: { ...FLAGS } })), flags: { ...FLAGS }, preview: { ...PREVIEW } });
const childRecord = (uid: number, parent: number | null): Json =>
  ({ 'parent-uid': parent, uid, flags: { ...FLAGS }, preview: { ...PREVIEW } });

/**
 * Layout 1: parent UID 0 and child UID 1 on "Main", child UID 2 on a second
 * layer "Top" (children on another layer than their parent are common in
 * editor-saved projects).
 */
async function setupHierarchy(): Promise<void> {
  const layout = await readLayout();
  layout.layers[0].instances = [instance(0, parentRecord(0, [1, 2])), instance(1, childRecord(1, 0))];
  layout.layers.push({
    name: 'Top', sid: 500000000000011, instances: [instance(2, childRecord(2, 0))], subLayers: [],
    isInitiallyVisible: true, isTransparent: true, color: [1, 1, 1, 1], blendMode: 'normal',
  });
  await writeFile(layoutPath(), JSON.stringify(layout, null, '\t'));
  await reader.loadProject();
}

/** uid → [parent-uid, child UIDs] of every instance with a hierarchy record. */
async function links(): Promise<Record<number, [number | null, number[] | undefined]>> {
  const layout = await readLayout();
  const out: Record<number, [number | null, number[] | undefined]> = {};
  for (const layer of layout.layers) {
    for (const inst of layer.instances ?? []) {
      const sg = inst.sceneGraphData;
      if (sg) out[inst.uid] = [sg['parent-uid'], sg.children?.map((c: Json) => c.uid)];
    }
  }
  return out;
}

async function hierarchyWarnings(): Promise<string[]> {
  resetProjectIndex();
  const result = await validateProjectIntegrity(reader);
  return result.warnings.filter(w => w.check === 'hierarchy-link').map(w => w.message);
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-hierarchy-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
  reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  server = new MockServer();
  registerLayoutTools({ server, reader, writer: new Construct3ProjectWriter(reader, idGen), idGen } as never);
  resetProjectIndex();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('delete_instance_from_layout and hierarchy links', () => {
  it('takes a deleted child out of its parent\'s children', async () => {
    await setupHierarchy();
    const result = await server.callTool('delete_instance_from_layout', { layoutName: 'Layout 1', uid: 1 });
    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(true);
    expect(await links()).toEqual({ 0: [null, [2]], 2: [0, undefined] });
    expect(data.warnings.join(' ')).toContain('Removed the hierarchy links from UID 0');
    expect(await hierarchyWarnings()).toEqual([]);
  });

  it('removes the emptied children array, as the editor saves a parent without children', async () => {
    await setupHierarchy();
    await server.callTool('delete_instance_from_layout', { layoutName: 'Layout 1', uid: 1 });
    await server.callTool('delete_instance_from_layout', { layoutName: 'Layout 1', uid: 2 });
    const layout = await readLayout();
    const parent = layout.layers[0].instances[0].sceneGraphData;
    expect(parent).not.toHaveProperty('children');
    expect(parent['parent-uid']).toBeNull();
    expect(await hierarchyWarnings()).toEqual([]);
  });

  it('detaches the children of a deleted parent, on every layer, and keeps them', async () => {
    await setupHierarchy();
    const result = await server.callTool('delete_instance_from_layout', { layoutName: 'Layout 1', uid: 0 });
    const data = JSON.parse(result.content[0].text);
    expect(await links()).toEqual({ 1: [null, undefined], 2: [null, undefined] });
    expect(data.warnings.join(' ')).toContain('Detached hierarchy children of the removed instance(s): UID 1, 2');
    expect(await hierarchyWarnings()).toEqual([]);
  });
});

describe('delete_layer and hierarchy links', () => {
  it('removes the links of instances on other layers to the instances deleted with the layer', async () => {
    await setupHierarchy();
    const result = await server.callTool('delete_layer', { layoutName: 'Layout 1', layerName: 'Top', force: true });
    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(true);
    expect(await links()).toEqual({ 0: [null, [1]], 1: [0, undefined] });
    expect(data.warnings.join(' ')).toContain('Removed the hierarchy links from UID 0');
    expect(await hierarchyWarnings()).toEqual([]);
  });

  it('detaches children on other layers when their parent\'s layer is deleted', async () => {
    await setupHierarchy();
    // Move the parent to its own layer "Back"
    const layout = await readLayout();
    const [parent] = layout.layers[0].instances.splice(0, 1);
    layout.layers.unshift({ name: 'Back', sid: 500000000000012, instances: [parent], subLayers: [], isInitiallyVisible: true });
    await writeFile(layoutPath(), JSON.stringify(layout, null, '\t'));
    await reader.loadProject();

    await server.callTool('delete_layer', { layoutName: 'Layout 1', layerName: 'Back', force: true });
    expect(await links()).toEqual({ 1: [null, undefined], 2: [null, undefined] });
    expect(await hierarchyWarnings()).toEqual([]);
  });
});

describe('UIDs that hierarchy links name', () => {
  it('are not handed out again, so a link left behind never points at a new instance', async () => {
    await setupHierarchy();
    // A link left behind by an older version: UID 7 was deleted, its parent still lists it
    const layout = await readLayout();
    layout.layers[0].instances[0].sceneGraphData.children.push({ uid: 7, flags: { ...FLAGS } });
    await writeFile(layoutPath(), JSON.stringify(layout, null, '\t'));
    await reader.loadProject();

    const result = await server.callTool('add_instance_to_layout', { layoutName: 'Layout 1', layerName: 'Main', objectType: 'Sprite', x: 0, y: 0 });
    expect(JSON.parse(result.content[0].text).generatedUid).toBe(8);
  });

  it('count in the text scan of layouts the reader skips, "parent-uid" included', () => {
    const text = JSON.stringify({ layers: [{ instances: [{ uid: 3, sceneGraphData: { 'parent-uid': 42, uid: 3, flags: FLAGS } }] }] });
    expect(scanIdsInText(text).highestUid).toBe(42);
  });
});

describe('validate_project hierarchy-link', () => {
  it('reports links to missing instances and one-sided links', async () => {
    const layout = await readLayout();
    layout.layers[0].instances = [
      instance(0, parentRecord(0, [1, 5])), // 5: no such instance
      instance(1, childRecord(1, null)), // listed by 0, names no parent
      instance(2, childRecord(2, 9)), // 9: no such instance
      instance(3, childRecord(3, 0)), // names 0, which does not list it
    ];
    await writeFile(layoutPath(), JSON.stringify(layout, null, '\t'));
    await reader.loadProject();

    const messages = await hierarchyWarnings();
    expect(messages).toHaveLength(4);
    expect(messages.some(m => m.includes('UID 0') && m.includes('lists child UID 5, which is no instance'))).toBe(true);
    expect(messages.some(m => m.includes('UID 0') && m.includes('lists child UID 1, which names another parent or none'))).toBe(true);
    expect(messages.some(m => m.includes('UID 2') && m.includes('names parent UID 9, which is no instance'))).toBe(true);
    expect(messages.some(m => m.includes('UID 3') && m.includes('names parent UID 0, which does not list it'))).toBe(true);
  });

  it('accepts intact links, also across layers', async () => {
    await setupHierarchy();
    expect(await hierarchyWarnings()).toEqual([]);
    expect(findHierarchyLinkProblems(await readLayout())).toEqual([]);
  });
});
