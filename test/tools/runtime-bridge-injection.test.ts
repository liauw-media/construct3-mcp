/**
 * inject_runtime_bridge registers the bridge so Construct loads it. The
 * manual ("Script files"): Construct loads only the main script on its own;
 * other scripts must be imported by it and have the purpose "(none)". So the
 * bridge is imported by an existing main script, or becomes the main script
 * of a project that has none. Script entries use "script-info", as the editor
 * saves them. Real reader, fixture copies.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { registerRuntimeTools } from '../../src/tools/runtime-tools.js';
import { MockServer } from '../mocks/mock-server.js';

const FIXTURES = join(__dirname, '..', 'fixtures');
const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function copyFixture(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'c3-bridge-inject-'));
  dirs.push(dir);
  await cp(join(FIXTURES, name), dir, { recursive: true });
  return dir;
}

async function tools(dir: string): Promise<MockServer> {
  const reader = new Construct3ProjectReader(join(dir, 'project.c3proj'));
  await reader.loadProject();
  const server = new MockServer();
  registerRuntimeTools({ server, reader, writer: new Construct3ProjectWriter(reader, new IdGenerator()) } as never);
  return server;
}

async function readProject(dir: string): Promise<any> {
  return JSON.parse((await readFile(join(dir, 'project.c3proj'), 'utf8')).replace(/^﻿/u, ''));
}

function bridgeEntries(project: any): any[] {
  const found: any[] = [];
  const walk = (folder: any) => {
    for (const item of folder?.items ?? []) if (item.name === 'c3-runtime-bridge.js') found.push(item);
    for (const sub of folder?.subfolders ?? []) walk(sub);
  };
  walk(project.rootFileFolders?.script);
  return found;
}

function payload(result: { content: Array<{ text: string }>; isError?: boolean }): any {
  expect(result.isError, result.content[0].text).toBeUndefined();
  return JSON.parse(result.content[0].text);
}

/** Give the project a main script at scripts/<folder>/main.js, with CRLF line ends. */
async function addMainScript(dir: string, folder: string, source: string): Promise<string> {
  const project = await readProject(dir);
  project.rootFileFolders.script.subfolders.push({
    items: [{ name: 'main.js', type: 'application/javascript', sid: 402118576391204, 'script-info': { purpose: 'main' } }],
    subfolders: [],
    name: folder,
  });
  await writeFile(join(dir, 'project.c3proj'), JSON.stringify(project, null, '\t'), 'utf8');
  await mkdir(join(dir, 'scripts', folder), { recursive: true });
  const path = join(dir, 'scripts', folder, 'main.js');
  await writeFile(path, source, 'utf8');
  return path;
}

describe('inject_runtime_bridge', () => {
  it('makes the bridge the main script of a project that has none, and remove_runtime_bridge undoes it', async () => {
    const dir = await copyFixture('minimal-project');
    const server = await tools(dir);

    const injected = payload(await server.callTool('inject_runtime_bridge', {}));
    expect(injected).toMatchObject({ success: true, loadedAs: 'main' });
    const entries = bridgeEntries(await readProject(dir));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: 'application/javascript', 'script-info': { purpose: 'main' } });
    expect(entries[0]['file-info']).toBeUndefined();
    expect(existsSync(join(dir, 'scripts', 'c3-runtime-bridge.js'))).toBe(true);

    payload(await server.callTool('inject_runtime_bridge', {}));
    expect(bridgeEntries(await readProject(dir))).toHaveLength(1);

    payload(await server.callTool('remove_runtime_bridge', {}));
    expect(bridgeEntries(await readProject(dir))).toEqual([]);
    expect(existsSync(join(dir, 'scripts', 'c3-runtime-bridge.js'))).toBe(false);
  });

  it('imports the bridge from an existing main script, once, and removal restores the script byte for byte', async () => {
    const dir = await copyFixture('minimal-project');
    const original = '// Game entry\r\nrunOnStartup(async (runtime) => {\r\n  console.log("start");\r\n});\r\n';
    const mainPath = await addMainScript(dir, 'game', original);
    const server = await tools(dir);

    const injected = payload(await server.callTool('inject_runtime_bridge', {}));
    expect(injected).toMatchObject({ success: true, loadedAs: 'import', mainScript: 'game/main.js' });
    const entries = bridgeEntries(await readProject(dir));
    expect(entries).toHaveLength(1);
    expect(entries[0]['script-info']).toEqual({ purpose: 'none' });
    const main = await readFile(mainPath, 'utf8');
    expect(main.startsWith('import "../c3-runtime-bridge.js"; // construct3-mcp runtime bridge (remove_runtime_bridge removes this line)\r\n')).toBe(true);
    expect(main.endsWith(original)).toBe(true);

    payload(await server.callTool('inject_runtime_bridge', {}));
    expect((await readFile(mainPath, 'utf8')).match(/c3-runtime-bridge\.js/gu)).toHaveLength(1);

    payload(await server.callTool('remove_runtime_bridge', {}));
    expect(await readFile(mainPath, 'utf8')).toBe(original);
    expect(bridgeEntries(await readProject(dir))).toEqual([]);
  });

  it('repairs a registration an earlier version wrote ("file-info", purpose none, loaded by nothing)', async () => {
    const dir = await copyFixture('c3-loadable-minimal');
    const before = bridgeEntries(await readProject(dir));
    expect(before).toEqual([expect.objectContaining({ 'file-info': { purpose: 'none' } })]);
    const server = await tools(dir);

    payload(await server.callTool('inject_runtime_bridge', {}));
    const after = bridgeEntries(await readProject(dir));
    expect(after).toHaveLength(1);
    expect(after[0]['script-info']).toEqual({ purpose: 'main' });
    expect(after[0]['file-info']).toBeUndefined();
  });

  it('registers the bridge in a clone the same way', async () => {
    const dir = await copyFixture('minimal-project');
    const server = await tools(dir);
    const clone = join(dir, '..', `${dir.split(/[\\/]/u).pop()}-clone`);
    dirs.push(clone);
    payload(await server.callTool('clone_project', { targetDir: clone, includeBridge: true }));
    expect(bridgeEntries(await readProject(clone))).toEqual([expect.objectContaining({ 'script-info': { purpose: 'main' } })]);
    expect(bridgeEntries(await readProject(dir))).toEqual([]);
  });
});

describe('inject_runtime_bridge and remove_runtime_bridge on script files as users have them', () => {
  /** Give the project a main script at scripts/main.js with `source`. */
  async function addRootMainScript(dir: string, source: string, scriptsType?: string): Promise<string> {
    const project = await readProject(dir);
    project.rootFileFolders.script.items.push({ name: 'main.js', type: 'application/javascript', sid: 402118576391205, 'script-info': { purpose: 'main' } });
    if (scriptsType) project.properties.scriptsType = scriptsType;
    await writeFile(join(dir, 'project.c3proj'), JSON.stringify(project, null, '\t'), 'utf8');
    await mkdir(join(dir, 'scripts'), { recursive: true });
    const path = join(dir, 'scripts', 'main.js');
    await writeFile(path, source, 'utf8');
    return path;
  }

  it('leaves the main script of a project with classic scripts alone, where an import would not parse', async () => {
    const dir = await copyFixture('minimal-project');
    const original = 'runOnStartup(function (runtime) {\n  console.log("classic");\n});\n';
    const mainPath = await addRootMainScript(dir, original, 'classic');
    const server = await tools(dir);

    const injected = payload(await server.callTool('inject_runtime_bridge', {}));
    expect(injected).toMatchObject({ success: true, loadedAs: 'classic' });
    expect(injected.importAdded).toBeUndefined();
    expect(await readFile(mainPath, 'utf8')).toBe(original);
    expect(bridgeEntries(await readProject(dir))).toEqual([expect.objectContaining({ 'script-info': { purpose: 'none' } })]);

    const prepared = payload(await server.callTool('export_for_preview', { injectBridge: true }));
    expect(prepared.checks.find((c: { check: string }) => c.check === 'runtimeBridge').status).toBe('warning');
    expect(await readFile(mainPath, 'utf8')).toBe(original);
  });

  it('restores a main script with a byte order mark byte for byte', async () => {
    const dir = await copyFixture('minimal-project');
    const original = '\uFEFF// game\r\nrunOnStartup(async (runtime) => {});\r\n';
    const mainPath = await addRootMainScript(dir, original);
    const server = await tools(dir);

    expect(payload(await server.callTool('inject_runtime_bridge', {}))).toMatchObject({ loadedAs: 'import', importAdded: true });
    const injected = await readFile(mainPath, 'utf8');
    expect(injected.startsWith('\uFEFFimport "./c3-runtime-bridge.js"; //')).toBe(true);

    const removed = payload(await server.callTool('remove_runtime_bridge', {}));
    expect(removed).toMatchObject({ entriesRemoved: 1, importRemoved: true });
    expect(await readFile(mainPath, 'utf8')).toBe(original);
    expect(existsSync(join(dir, 'scripts', 'c3-runtime-bridge.js'))).toBe(false);
  });

  it('removes the import line v1.9.2 had users type into the main script, with the file it imports', async () => {
    const dir = await copyFixture('minimal-project');
    const rest = 'runOnStartup(async (runtime) => {});\n';
    const mainPath = await addRootMainScript(dir, `import "./c3-runtime-bridge.js";\n${rest}`);
    const server = await tools(dir);

    expect(payload(await server.callTool('inject_runtime_bridge', {}))).toMatchObject({ loadedAs: 'import', importAdded: false });
    const removed = payload(await server.callTool('remove_runtime_bridge', {}));
    expect(removed).toMatchObject({ entriesRemoved: 1, importRemoved: true, scriptsChanged: ['main.js'] });
    expect(await readFile(mainPath, 'utf8')).toBe(rest);
    expect(existsSync(join(dir, 'scripts', 'c3-runtime-bridge.js'))).toBe(false);
  });

  it('refuses, changing nothing, while a script uses the bridge in a way it cannot take out', async () => {
    const dir = await copyFixture('minimal-project');
    const mainPath = await addRootMainScript(dir, 'runOnStartup(async (runtime) => {});\n');
    const server = await tools(dir);
    payload(await server.callTool('inject_runtime_bridge', {}));
    await writeFile(join(dir, 'scripts', 'helper.js'), 'import * as bridge from "./c3-runtime-bridge.js";\nexport const b = bridge;\n', 'utf8');
    const mainBefore = await readFile(mainPath, 'utf8');
    const projectBefore = await readFile(join(dir, 'project.c3proj'), 'utf8');

    const refused = await server.callTool('remove_runtime_bridge', {});
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('helper.js');
    expect(await readFile(mainPath, 'utf8')).toBe(mainBefore);
    expect(await readFile(join(dir, 'project.c3proj'), 'utf8')).toBe(projectBefore);
    expect(existsSync(join(dir, 'scripts', 'c3-runtime-bridge.js'))).toBe(true);
  });

  it('writes nothing when the bridge is registered already, wherever its entry sits', async () => {
    const dir = await copyFixture('minimal-project');
    await addRootMainScript(dir, 'runOnStartup(async (runtime) => {});\n');
    const server = await tools(dir);
    payload(await server.callTool('inject_runtime_bridge', {}));
    // Another script added after the bridge, as the editor would list it.
    const project = await readProject(dir);
    project.rootFileFolders.script.items.push({ name: 'zzz-helper.js', type: 'application/javascript', sid: 402118576391206, 'script-info': { purpose: 'none' } });
    await writeFile(join(dir, 'project.c3proj'), JSON.stringify(project, null, '\t'), 'utf8');
    const before = await readFile(join(dir, 'project.c3proj'), 'utf8');

    const again = payload(await server.callTool('inject_runtime_bridge', {}));
    expect(again).toMatchObject({ registered: false, importAdded: false });
    expect(await readFile(join(dir, 'project.c3proj'), 'utf8')).toBe(before);
  });
});

describe('pack_project', () => {
  it('says, like export_for_preview, that the packed project carries an active bridge and that the main script got an import line', async () => {
    const dir = await copyFixture('minimal-project');
    const project = await readProject(dir);
    project.rootFileFolders.script.items.push({ name: 'main.js', type: 'application/javascript', sid: 402118576391205, 'script-info': { purpose: 'main' } });
    await writeFile(join(dir, 'project.c3proj'), JSON.stringify(project, null, '\t'), 'utf8');
    await mkdir(join(dir, 'scripts'), { recursive: true });
    await writeFile(join(dir, 'scripts', 'main.js'), 'runOnStartup(async (runtime) => {});\n', 'utf8');
    const server = await tools(dir);
    const out = join(dir, '..', `${dir.split(/[\\/]/u).pop()}.c3p`);
    dirs.push(out);

    const packed = payload(await server.callTool('pack_project', { outputPath: out }));
    expect(packed).toMatchObject({ bridgeInjected: true, loadedAs: 'import', mainScript: 'main.js', importAdded: true });
    expect(packed.warning).toMatch(/remove_runtime_bridge/u);

    expect(payload(await server.callTool('export_for_preview', {}))).toMatchObject({ loadedAs: 'import', mainScript: 'main.js', importAdded: false });

    const plain = payload(await server.callTool('pack_project', { outputPath: out, injectBridge: false }));
    expect(plain.loadedAs).toBeUndefined();
    expect(plain.warning).toBeUndefined();
  });
});

describe('export_for_preview', () => {
  async function withUseWorker(value: string | boolean): Promise<string> {
    const dir = await copyFixture('minimal-project');
    const project = await readProject(dir);
    project.useWorker = value;
    await writeFile(join(dir, 'project.c3proj'), JSON.stringify(project, null, '\t'), 'utf8');
    return dir;
  }

  it('does not warn about "Use worker": auto runs on the page with the bridge, worker is reached there', async () => {
    for (const [useWorker, detail] of [['auto', /scripts/u], ['dom', /page/u], ['worker', /worker/u], [false, /run on the page/u], [true, /in a worker/u]] as const) {
      const server = await tools(await withUseWorker(useWorker));
      const result = payload(await server.callTool('export_for_preview', { injectBridge: true }));
      const check = result.checks.find((c: { check: string }) => c.check === 'workerMode');
      expect(check.status, String(useWorker)).toBe('ok');
      expect(check.detail, String(useWorker)).toMatch(detail);
      if (typeof useWorker === 'boolean') expect(check.detail).not.toMatch(/would run in a worker/u);
      expect(result.nextSteps.join(' ')).toContain('serve_preview');
    }
  });
});
