/**
 * remove_runtime_bridge deletes the bridge file, so every script that could
 * import it has to be read first: a script it cannot read, or a folder under
 * scripts/ it cannot list, makes it refuse, changing nothing. Otherwise such
 * a script would import a file that no longer exists and the game would not
 * load. Real reader, writer and ID generator on a fixture copy; the file
 * system reads of the runtime tools fail where a test says so.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { registerRuntimeTools } from '../../src/tools/runtime-tools.js';
import { MockServer } from '../mocks/mock-server.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile), readdir: vi.fn(actual.readdir) };
});

const FIXTURES = join(__dirname, '..', 'fixtures');
const dirs: string[] = [];

afterEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(readFile).mockImplementation(actual.readFile as never);
  vi.mocked(readdir).mockImplementation(actual.readdir as never);
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

/** A copy of the minimal project with scripts/main.js as its main script, and the bridge added. */
async function projectWithBridge(): Promise<{ dir: string; server: MockServer }> {
  const dir = await mkdtemp(join(tmpdir(), 'c3-bridge-unreadable-'));
  dirs.push(dir);
  await cp(join(FIXTURES, 'minimal-project'), dir, { recursive: true });
  const projectPath = join(dir, 'project.c3proj');
  const project = JSON.parse(await readFile(projectPath, 'utf8'));
  project.rootFileFolders.script.items.push({ name: 'main.js', type: 'application/javascript', sid: 402118576391205, 'script-info': { purpose: 'main' } });
  await writeFile(projectPath, JSON.stringify(project, null, '\t'), 'utf8');
  await mkdir(join(dir, 'scripts'), { recursive: true });
  await writeFile(join(dir, 'scripts', 'main.js'), 'runOnStartup(async (runtime) => {});\n', 'utf8');

  const reader = new Construct3ProjectReader(projectPath);
  await reader.loadProject();
  const server = new MockServer();
  registerRuntimeTools({ server, reader, writer: new Construct3ProjectWriter(reader, new IdGenerator()) } as never);
  const injected = await server.callTool('inject_runtime_bridge', {});
  expect(injected.isError, injected.content[0].text).toBeUndefined();
  return { dir, server };
}

/** The files under `dir`, with their text. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) files[join(entry.parentPath, entry.name)] = await readFile(join(entry.parentPath, entry.name), 'utf8');
  }
  return files;
}

function busy(path: unknown): Error {
  return Object.assign(new Error(`EBUSY: resource busy or locked, open '${String(path)}'`), { code: 'EBUSY' });
}

describe('remove_runtime_bridge with scripts it cannot read', () => {
  it('refuses, changing nothing, while a script that may import the bridge cannot be read', async () => {
    const { dir, server } = await projectWithBridge();
    const helper = join(dir, 'scripts', 'helper.js');
    await writeFile(helper, 'import "./c3-runtime-bridge.js";\nexport const x = 1;\n', 'utf8');
    const before = await snapshot(dir);
    // Held open by another program (a virus scanner, a sync client, an editor)
    const readText = vi.mocked(readFile).getMockImplementation()!;
    vi.mocked(readFile).mockImplementation((async (path: unknown, ...rest: unknown[]) => {
      if (typeof path === 'string' && resolve(path) === resolve(helper)) throw busy(path);
      return (readText as (...args: unknown[]) => unknown)(path, ...rest);
    }) as never);

    const refused = await server.callTool('remove_runtime_bridge', {});
    vi.mocked(readFile).mockImplementation(readText);
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('Nothing was changed: scripts/helper.js could not be read (EBUSY)');
    expect(refused.content[0].text).not.toContain(dir);
    expect(await snapshot(dir)).toEqual(before);
    expect(existsSync(join(dir, 'scripts', 'c3-runtime-bridge.js'))).toBe(true);
  });

  it('refuses, changing nothing, while a folder under scripts/ cannot be listed', async () => {
    const { dir, server } = await projectWithBridge();
    const folder = join(dir, 'scripts', 'lib');
    await mkdir(folder);
    await writeFile(join(folder, 'uses-bridge.js'), 'import "../c3-runtime-bridge.js";\n', 'utf8');
    const before = await snapshot(dir);
    const list = vi.mocked(readdir).getMockImplementation()!;
    vi.mocked(readdir).mockImplementation((async (path: unknown, ...rest: unknown[]) => {
      if (typeof path === 'string' && resolve(path) === resolve(folder)) {
        throw Object.assign(new Error(`EACCES: permission denied, scandir '${path}'`), { code: 'EACCES' });
      }
      return (list as (...args: unknown[]) => unknown)(path, ...rest);
    }) as never);

    const refused = await server.callTool('remove_runtime_bridge', {});
    vi.mocked(readdir).mockImplementation(list);
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('Nothing was changed: scripts/lib could not be read (EACCES)');
    expect(await snapshot(dir)).toEqual(before);
    expect(existsSync(join(dir, 'scripts', 'c3-runtime-bridge.js'))).toBe(true);
  });

  it('still removes the bridge when the scripts folder is gone', async () => {
    const { dir, server } = await projectWithBridge();
    await rm(join(dir, 'scripts'), { recursive: true });

    const removed = await server.callTool('remove_runtime_bridge', {});
    expect(removed.isError, removed.content[0].text).toBeUndefined();
    expect(JSON.parse(removed.content[0].text)).toMatchObject({ entriesRemoved: 1, importRemoved: false });
  });
});
