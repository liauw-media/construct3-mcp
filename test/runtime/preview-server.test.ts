/**
 * serve_preview's server: an exported game folder is served over loopback,
 * anything that is not an export is refused, and the server stops cleanly.
 * Browser launching is not exercised here (it needs a Chrome on the machine);
 * only the executable discovery rules are.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PreviewManager,
  PreviewServer,
  checkExportFolder,
  chromeCandidates,
  findChrome,
  isLoopbackHost,
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
    const server = await PreviewServer.start({ folder: game, host: '127.0.0.1' });
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
    const first = await manager.serve({ folder: game, host: '127.0.0.1' });
    const second = await manager.serve({ folder: game, host: '127.0.0.1' });
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

  it('names a missing explicit executable', () => {
    // Path-free on purpose: a message with a path reaches the client blanked by the redactor.
    expect(() => findChrome('Z:/does/not/exist/chrome.exe')).toThrow('Chrome executable not found at the given chromePath.');
  });

  it('knows which hosts are this machine', () => {
    for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '::1', '[::1]']) expect(isLoopbackHost(host)).toBe(true);
    for (const host of ['0.0.0.0', '10.0.0.5', 'example.com', '::']) expect(isLoopbackHost(host)).toBe(false);
  });
});
