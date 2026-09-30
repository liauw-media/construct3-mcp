/**
 * inject_runtime_bridge registers the bridge so Construct loads it. The
 * manual ("Script files"): Construct loads only the main script on its own;
 * other scripts must be imported by it and have the purpose "(none)". So the
 * bridge is imported by an existing main script, or becomes the main script
 * of a project that has none. Script entries use "script-info", as the editor
 * saves them. Real reader, fixture copies.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { access, chmod, cp, mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { getProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { runInToolCall } from '../../src/construct3/disk-state.js';
import { registerRuntimeTools } from '../../src/tools/runtime-tools.js';
import { MockServer } from '../mocks/mock-server.js';

const FIXTURES = join(__dirname, '..', 'fixtures');
const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function copyFixture(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'c3-bridge-inject-'));
  dirs.push(dir);
  await cp(join(FIXTURES, name), dir, { recursive: true });
  return dir;
}

async function tools(dir: string): Promise<MockServer> {
  return (await runtimeSetup(dir)).server;
}

/** The runtime tools on the project in `dir`, with the real reader, writer and ID generator they use. */
async function runtimeSetup(dir: string): Promise<{ server: MockServer; reader: Construct3ProjectReader; writer: Construct3ProjectWriter; idGen: IdGenerator }> {
  const reader = new Construct3ProjectReader(join(dir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  const writer = new Construct3ProjectWriter(reader, idGen);
  const server = new MockServer();
  registerRuntimeTools({ server, reader, writer } as never);
  return { server, reader, writer, idGen };
}

/** A value for Math.random that makes the ID generator's formula produce `sid` (15 digits). */
function randomForSid(sid: number): number {
  return (sid - 100_000_000_000_000 + 0.5) / 900_000_000_000_000;
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

  it('refuses, changing nothing, when scripts/c3-runtime-bridge.js is a folder', async () => {
    const dir = await copyFixture('minimal-project');
    const folder = join(dir, 'scripts', 'c3-runtime-bridge.js');
    await mkdir(folder, { recursive: true });
    const projectBefore = await readFile(join(dir, 'project.c3proj'), 'utf8');
    const server = await tools(dir);

    const refused = await server.callTool('inject_runtime_bridge', {});
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('nothing was changed: scripts/c3-runtime-bridge.js is a folder');
    expect(refused.content[0].text).not.toContain('could not be put back');
    expect(await readFile(join(dir, 'project.c3proj'), 'utf8')).toBe(projectBefore);
    expect((await stat(folder)).isDirectory()).toBe(true);
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

  it('refuses, changing nothing, when project.c3proj names a main script that is not there', async () => {
    const dir = await copyFixture('minimal-project');
    await rm(await addRootMainScript(dir, 'runOnStartup(async (runtime) => {});\n'));
    const projectBefore = await readFile(join(dir, 'project.c3proj'), 'utf8');
    const server = await tools(dir);
    const out = join(dir, '..', `${dir.split(/[\\/]/u).pop()}.c3p`);
    dirs.push(out);

    // All three add the bridge by default; none may leave the bridge file or its entry behind.
    for (const [tool, args] of [['inject_runtime_bridge', {}], ['export_for_preview', {}], ['pack_project', { outputPath: out }]] as const) {
      const refused = await server.callTool(tool, args);
      expect(refused.isError, tool).toBe(true);
      expect(refused.content[0].text, tool).toContain('nothing was changed');
      expect(refused.content[0].text, tool).toContain('scripts/main.js');
      expect(await readFile(join(dir, 'project.c3proj'), 'utf8'), tool).toBe(projectBefore);
      expect(await readdir(join(dir, 'scripts')), tool).toEqual([]);
    }
    expect(existsSync(out)).toBe(false);
  });

  it('puts back what it wrote when the import line cannot be written into the main script', async (context) => {
    const dir = await copyFixture('minimal-project');
    const original = 'runOnStartup(async (runtime) => {});\n';
    const mainPath = await addRootMainScript(dir, original);
    const projectBefore = await readFile(join(dir, 'project.c3proj'), 'utf8');
    await chmod(mainPath, 0o444);
    try {
      // Where a read-only file stays writable (root on Linux), the failing write cannot be staged.
      if (await access(mainPath, constants.W_OK).then(() => true, () => false)) context.skip('read-only files are writable for this user');
      const server = await tools(dir);

      const refused = await server.callTool('inject_runtime_bridge', {});
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toContain('back as they were');
      expect(await readFile(join(dir, 'project.c3proj'), 'utf8')).toBe(projectBefore);
      expect(await readFile(mainPath, 'utf8')).toBe(original);
      expect(existsSync(join(dir, 'scripts', 'c3-runtime-bridge.js'))).toBe(false);
    } finally {
      await chmod(mainPath, 0o644);
    }
  });

  it('puts back what remove_runtime_bridge wrote when project.c3proj cannot be written', async (context) => {
    const dir = await copyFixture('minimal-project');
    const mainPath = await addRootMainScript(dir, 'runOnStartup(async (runtime) => {});\n');
    const server = await tools(dir);
    payload(await server.callTool('inject_runtime_bridge', {}));
    const mainBefore = await readFile(mainPath, 'utf8');
    const projectPath = join(dir, 'project.c3proj');
    const projectBefore = await readFile(projectPath, 'utf8');
    await chmod(projectPath, 0o444);
    try {
      // Where a read-only file stays writable (root on Linux), the failing write cannot be staged.
      if (await access(projectPath, constants.W_OK).then(() => true, () => false)) context.skip('read-only files are writable for this user');

      // The import line goes first, then the entry: the second write fails
      const refused = await server.callTool('remove_runtime_bridge', {});
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toContain('The bridge was not removed: the files this call had written are back as they were.');
      expect(await readFile(mainPath, 'utf8')).toBe(mainBefore);
      expect(await readFile(projectPath, 'utf8')).toBe(projectBefore);
      expect(existsSync(join(dir, 'scripts', 'c3-runtime-bridge.js'))).toBe(true);
    } finally {
      await chmod(projectPath, 0o644);
    }
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

/**
 * The bridge tools write project.c3proj and the script files themselves, not
 * through the writer. The bridge entry's SID comes from the project's ID
 * generator, and after the writes the reader, the project index and the ID
 * generator are brought in line as after a write of the writer's own: in a
 * project without a main script no file the reader knows changes, so nothing
 * else would tell them.
 */
describe('the bridge entry and the server state after the bridge is added', () => {
  it('gives the bridge entry a SID that no other entry of the project has', async () => {
    const dir = await copyFixture('minimal-project');
    const taken = (await readProject(dir)).rootFileFolders.icon.items[0].sid;
    const server = await tools(dir);

    vi.spyOn(Math, 'random').mockReturnValueOnce(randomForSid(taken));
    payload(await server.callTool('inject_runtime_bridge', {}));
    const [entry] = bridgeEntries(await readProject(dir));
    expect(entry.sid).toBeGreaterThanOrEqual(100_000_000_000_000);
    expect(entry.sid).not.toBe(taken);
  });

  it.each(['inject_runtime_bridge', 'export_for_preview', 'pack_project'])(
    '%s: the next call sees the bridge in the script list, and its SID is never handed out again',
    async (tool) => {
      const dir = await copyFixture('minimal-project');
      const { server, reader, idGen } = await runtimeSetup(dir);
      // Built before the bridge exists: the index with its script list, and the ID generator's scan
      await runInToolCall(async () => {
        await reader.checkProjectFile();
        await (await getProjectIndex(reader)).getScriptMemberReads(reader);
        await idGen.initialize(reader);
      });
      const out = join(dir, '..', `${dir.split(/[\\/]/u).pop()}.c3p`);
      dirs.push(out);

      expect(payload(await server.callTool(tool, tool === 'pack_project' ? { outputPath: out } : {})).loadedAs).toBe('main');
      const [entry] = bridgeEntries(await readProject(dir));

      const readScript = vi.spyOn(reader, 'readScriptFile');
      const sid = await runInToolCall(async () => {
        await reader.checkProjectFile();
        await (await getProjectIndex(reader)).getScriptMemberReads(reader);
        vi.spyOn(Math, 'random').mockReturnValueOnce(randomForSid(entry.sid));
        return idGen.generateSid(reader);
      });
      expect(readScript).toHaveBeenCalledWith('c3-runtime-bridge.js');
      expect(sid).not.toBe(entry.sid);
    },
  );
});

/**
 * The bridge tools write project.c3proj themselves, from the text they read
 * at the start. A save of project.c3proj in the editor during the call
 * (#51) must not be written over: the call refuses, changing nothing, and
 * the next call adds the bridge to the saved file.
 */
describe('project.c3proj saved in the editor while a bridge tool runs', () => {
  const ARGS: Record<string, (dir: string) => Record<string, unknown>> = {
    inject_runtime_bridge: () => ({}),
    remove_runtime_bridge: () => ({}),
    export_for_preview: () => ({}),
    pack_project: (dir) => ({ outputPath: join(dir, '..', `${dir.split(/[\\/]/u).pop()}.c3p`) }),
  };

  /** Save project.c3proj as the editor would, with another author; returns the text saved. */
  async function saveInEditor(dir: string): Promise<string> {
    const project = await readProject(dir);
    project.properties.author = 'Saved in the editor';
    const text = JSON.stringify(project, null, '\t');
    await writeFile(join(dir, 'project.c3proj'), text, 'utf8');
    return text;
  }

  it.each(['inject_runtime_bridge', 'export_for_preview', 'pack_project'])(
    '%s: a save while the ID generator scans the project for the bridge entry\'s SID is kept',
    async (tool) => {
      const dir = await copyFixture('minimal-project');
      const args = ARGS[tool](dir);
      if (args.outputPath) dirs.push(args.outputPath as string);
      const { server, reader } = await runtimeSetup(dir);
      // The first SID of the session: the ID generator reads every object type, and the editor saves meanwhile
      const readAllObjectTypes = reader.readAllObjectTypes.bind(reader);
      let saved: string | undefined;
      vi.spyOn(reader, 'readAllObjectTypes').mockImplementation(async (...rest) => {
        saved ??= await saveInEditor(dir);
        return readAllObjectTypes(...rest);
      });

      const refused = await server.callTool(tool, args);
      expect(saved, 'the scan ran during the call').toBeDefined();
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toContain('project.c3proj was changed on disk after this server read it');
      expect(await readFile(join(dir, 'project.c3proj'), 'utf8')).toBe(saved);
      expect(existsSync(join(dir, 'scripts', 'c3-runtime-bridge.js'))).toBe(false);

      payload(await server.callTool(tool, args));
      const project = await readProject(dir);
      expect(project.properties.author).toBe('Saved in the editor');
      expect(bridgeEntries(project)).toHaveLength(1);
    },
  );

  it.each(['inject_runtime_bridge', 'export_for_preview', 'pack_project', 'remove_runtime_bridge'])(
    '%s: a save after the check at the start of the call, before project.c3proj is written, is kept',
    async (tool) => {
      const dir = await copyFixture('minimal-project');
      const args = ARGS[tool](dir);
      if (args.outputPath) dirs.push(args.outputPath as string);
      const { server, writer } = await runtimeSetup(dir);
      if (tool === 'remove_runtime_bridge') payload(await server.callTool('inject_runtime_bridge', {}));
      const bridgePath = join(dir, 'scripts', 'c3-runtime-bridge.js');
      const bridgeBefore = existsSync(bridgePath) ? await readFile(bridgePath, 'utf8') : undefined;
      // The check passes, then the editor saves
      const check = writer.assertProjectFileCurrent.bind(writer);
      let saved: string | undefined;
      vi.spyOn(writer, 'assertProjectFileCurrent').mockImplementation(async () => {
        await check();
        saved ??= await saveInEditor(dir);
      });

      const refused = await server.callTool(tool, args);
      expect(saved).toBeDefined();
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toContain('project.c3proj was changed on disk after this server read it');
      expect(refused.content[0].text).toContain(`The bridge was not ${tool === 'remove_runtime_bridge' ? 'removed' : 'added'}: the files this call had written are back as they were.`);
      expect(await readFile(join(dir, 'project.c3proj'), 'utf8')).toBe(saved);
      expect(existsSync(bridgePath) ? await readFile(bridgePath, 'utf8') : undefined).toBe(bridgeBefore);
    },
  );

  it('a save right after the call wrote project.c3proj is not taken for the call\'s own write', async () => {
    const dir = await copyFixture('minimal-project');
    const { server, reader, writer } = await runtimeSetup(dir);
    const afterDirectWrites = writer.afterDirectWrites.bind(writer);
    vi.spyOn(writer, 'afterDirectWrites').mockImplementationOnce(async (writes) => {
      await saveInEditor(dir);
      return afterDirectWrites(writes);
    });

    payload(await server.callTool('inject_runtime_bridge', {}));
    // Seen as a change made outside the server: the next call loads it, and the index and the ID generator rebuild
    expect(await reader.projectFileChanged()).toBe(true);
    const epoch = reader.getDiskEpoch();
    expect(payload(await server.callTool('inject_runtime_bridge', {})).registered).toBe(false);
    expect(reader.getDiskEpoch()).toBeGreaterThan(epoch);
    expect(reader.getProject().properties.author).toBe('Saved in the editor');
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
