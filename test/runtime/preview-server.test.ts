/**
 * serve_preview's server: an exported game folder is served over loopback,
 * anything that is not an export is refused, and the server stops cleanly.
 * Browser launching is not exercised here (it needs a Chrome on the machine);
 * only the executable discovery rules are.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  PreviewManager,
  PreviewServer,
  checkExportFolder,
  chromeCandidates,
  findChrome,
  isLoopbackHost,
  readDevToolsActivePort,
  removeStaleProfiles,
} from '../../src/runtime/preview-server.js';

const FIXTURE_PROJECT = join(__dirname, '..', 'fixtures', 'minimal-project');

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

/** A folder shaped like an HTML5 export, beside a file it must not serve. */
async function makeExport(): Promise<{ root: string; game: string }> {
  const root = await mkdtemp(join(tmpdir(), 'c3-preview-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const game = join(root, 'game');
  await mkdir(join(game, 'scripts'), { recursive: true });
  await writeFile(join(game, 'index.html'), '<!doctype html><title>Game</title>', 'utf8');
  await writeFile(join(game, 'scripts', 'main.js'), 'console.log(1)', 'utf8');
  await writeFile(join(game, 'data.json'), '{"a":1}', 'utf8');
  await writeFile(join(root, 'secret.txt'), 'not served', 'utf8');
  return { root, game };
}

describe('checkExportFolder', () => {
  it('accepts a folder holding index.html and returns its absolute path', async () => {
    const { game } = await makeExport();
    expect(await checkExportFolder(game)).toBe(game);
  });

  it('refuses a .c3p, a source project folder, a folder without index.html and a missing folder', async () => {
    const { root } = await makeExport();
    await expect(checkExportFolder(join(root, 'game.c3p'))).rejects.toThrow('source project, not an exported game');
    await expect(checkExportFolder(FIXTURE_PROJECT)).rejects.toThrow('project.c3proj');
    await expect(checkExportFolder(root)).rejects.toThrow('No index.html');
    await expect(checkExportFolder(join(root, 'nowhere'))).rejects.toThrow('Folder not found');
  });
});

describe('PreviewServer', () => {
  it('serves the export with content types, refuses escapes and other methods, and stops', async () => {
    const { game } = await makeExport();
    const server = await PreviewServer.start({ folder: game });
    cleanups.push(() => server.stop());
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);

    const index = await fetch(server.url);
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(index.headers.get('cache-control')).toBe('no-store');
    expect(await index.text()).toContain('<title>Game</title>');

    const script = await fetch(server.url + 'scripts/main.js');
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(await script.text()).toBe('console.log(1)');
    expect((await fetch(server.url + 'data.json')).headers.get('content-type')).toBe('application/json; charset=utf-8');

    expect((await fetch(server.url + 'missing.png')).status).toBe(404);
    expect((await fetch(server.url + '..%2Fsecret.txt')).status).toBe(404);
    expect((await fetch(server.url + 'scripts/../../secret.txt')).status).toBe(404);
    expect((await fetch(server.url + 'scripts/')).status).toBe(404);
    expect((await fetch(server.url, { method: 'POST' })).status).toBe(405);
    const head = await fetch(server.url, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');

    expect(server.info().requests).toBeGreaterThanOrEqual(8);
    await server.stop();
    cleanups.pop();
    await expect(fetch(server.url)).rejects.toThrow();
  });
});

describe('PreviewManager', () => {
  it('lists, stops by id and closes everything', async () => {
    const { game } = await makeExport();
    const manager = new PreviewManager();
    cleanups.push(() => manager.closeAll());
    const first = await manager.serve({ folder: game });
    const second = await manager.serve({ folder: game });
    expect(manager.list().map(p => p.serverId).sort()).toEqual([first.serverId, second.serverId].sort());
    expect(first.browser).toBeUndefined();

    const stopped = await manager.stop(first.serverId);
    expect(stopped.serverId).toBe(first.serverId);
    expect(manager.list().map(p => p.serverId)).toEqual([second.serverId]);
    await expect(manager.stop(first.serverId)).rejects.toThrow('Unknown preview server');

    await manager.closeAll();
    expect(manager.list()).toEqual([]);
    await expect(fetch(second.url)).rejects.toThrow();
  });
});

describe('browser discovery', () => {
  it('tries CHROME_PATH first, then the platform locations', () => {
    const win = chromeCandidates({ CHROME_PATH: 'X:/my/chrome.exe', PROGRAMFILES: 'C:/PF', 'PROGRAMFILES(X86)': 'C:/PF86', LOCALAPPDATA: 'C:/LA', SYSTEMDRIVE: 'D:' }, 'win32');
    expect(win[0]).toBe('X:/my/chrome.exe');
    expect(win).toContain(join('C:/PF', 'Google', 'Chrome', 'Application', 'chrome.exe'));
    expect(win).toContain(join('C:/PF86', 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    // Git Bash drops ProgramFiles(x86); the system drive's roots are tried regardless.
    const bash = chromeCandidates({ PROGRAMFILES: 'C:\\Program Files', SYSTEMDRIVE: 'C:' }, 'win32');
    expect(bash).toContain(join('C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'));
    expect(new Set(bash).size).toBe(bash.length);
    expect(chromeCandidates({}, 'darwin')[0]).toContain('Google Chrome.app');
    expect(chromeCandidates({}, 'linux')).toContain('/usr/bin/google-chrome');
  });

  it('takes CHROME_PATH when it is set, and says so when it names no file', () => {
    expect(findChrome({ CHROME_PATH: process.execPath })).toBe(process.execPath);
    // Path-free on purpose: a message with a path reaches the client blanked by the redactor.
    expect(() => findChrome({ CHROME_PATH: 'Z:/does/not/exist/chrome.exe' })).toThrow('CHROME_PATH is set but names no file (the path is in the server log).');
  });

  it('knows which hosts are this machine', () => {
    for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '::1', '[::1]']) expect(isLoopbackHost(host)).toBe(true);
    for (const host of ['0.0.0.0', '10.0.0.5', 'example.com', '::']) expect(isLoopbackHost(host)).toBe(false);
  });
});

describe('DevToolsActivePort', () => {
  it('reads the port and browser path once both lines are there, and nothing before', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'c3-devtools-port-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    expect(await readDevToolsActivePort(dir)).toBeUndefined();
    await writeFile(join(dir, 'DevToolsActivePort'), '53917', 'utf8');
    expect(await readDevToolsActivePort(dir)).toBeUndefined();
    await writeFile(join(dir, 'DevToolsActivePort'), '53917\r\n/devtools/browser/0b1c-42\r\n', 'utf8');
    expect(await readDevToolsActivePort(dir)).toEqual({ port: 53917, browserPath: '/devtools/browser/0b1c-42' });
    await writeFile(join(dir, 'DevToolsActivePort'), '0\n/devtools/browser/x', 'utf8');
    expect(await readDevToolsActivePort(dir)).toBeUndefined();
  });
});

describe('stale browser profiles', () => {
  it('removes the profiles of servers and browsers that are gone, and keeps every other folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'c3-profiles-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    // A process that has exited: its pid is not alive any more.
    const gone = spawnSync(process.execPath, ['-e', '0']).pid!;
    const profile = async (name: string, owner?: { serverPid: number; browserPid: number }) => {
      await mkdir(join(root, name, 'Default'), { recursive: true });
      await writeFile(join(root, name, 'Default', 'Preferences'), '{}', 'utf8');
      if (owner) await writeFile(join(root, name, 'c3mcp-owner.json'), JSON.stringify(owner), 'utf8');
    };
    await profile(`c3mcp-chrome-${gone}-aB3dE9`, { serverPid: gone, browserPid: gone });
    await profile(`c3mcp-chrome-${gone}-nOwNeR`);
    await profile(`c3mcp-chrome-${process.pid}-mine01`, { serverPid: process.pid, browserPid: gone });
    await profile(`c3mcp-chrome-${gone}-orphan`, { serverPid: gone, browserPid: process.pid });
    await profile('c3mcp-chrome-legacy');
    await profile('something-else');

    const removed = await removeStaleProfiles(root);

    expect(removed.sort()).toEqual([`c3mcp-chrome-${gone}-aB3dE9`, `c3mcp-chrome-${gone}-nOwNeR`].sort());
    expect(existsSync(join(root, `c3mcp-chrome-${gone}-aB3dE9`))).toBe(false);
    expect(existsSync(join(root, `c3mcp-chrome-${gone}-nOwNeR`))).toBe(false);
    // This process's own profile, one whose browser still runs, and folders not ours stay.
    expect(existsSync(join(root, `c3mcp-chrome-${process.pid}-mine01`))).toBe(true);
    expect(existsSync(join(root, `c3mcp-chrome-${gone}-orphan`))).toBe(true);
    expect(existsSync(join(root, 'c3mcp-chrome-legacy'))).toBe(true);
    expect(existsSync(join(root, 'something-else'))).toBe(true);
  });
});
