/**
 * launchBrowser when the browser cannot be started: a folder named as
 * CHROME_PATH, a file that is no executable, and a start that fails only
 * after spawn() returned (Node reports a missing or unusable executable
 * with an 'error' event on the next tick and no pid). Each is an error of
 * the call, the process lives on, and no browser profile stays behind.
 * Before, the 'error' event had no listener and ended the MCP server, and a
 * start that failed at once left its profile until the next server start.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failSpawnLater = false;

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: ((...args: Parameters<typeof actual.spawn>) => {
      if (!failSpawnLater) return actual.spawn(...args);
      // What ChildProcess does for an executable it cannot start: no pid, and 'error' on the next tick.
      const child = Object.assign(new EventEmitter(), { pid: undefined, exitCode: null, signalCode: null, kill: () => false });
      process.nextTick(() => child.emit('error', Object.assign(new Error(`spawn ${String(args[0])} ENOENT`), { code: 'ENOENT' })));
      return child;
    }) as typeof actual.spawn,
  };
});

const { findChrome, launchBrowser } = await import('../../src/runtime/preview-server.js');

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  failSpawnLater = false;
  vi.unstubAllEnvs();
  while (cleanups.length > 0) await cleanups.pop()!();
});

/** This test process's browser profiles in the temp folder (test files run in processes of their own). */
async function ownProfiles(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((name) => name.startsWith(`c3mcp-chrome-${process.pid}-`));
}

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'c3-launch-errors-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe('launchBrowser when the browser cannot start', () => {
  it('refuses a folder as CHROME_PATH before starting anything', async () => {
    const dir = await scratch();
    expect(() => findChrome({ CHROME_PATH: dir })).toThrow('CHROME_PATH is set but names no file');
    vi.stubEnv('CHROME_PATH', dir);
    await expect(launchBrowser({ url: 'http://127.0.0.1:1/', headless: true, readyTimeoutMs: 2_000 })).rejects.toThrow('names no file');
    expect(await ownProfiles()).toEqual([]);
  });

  it('reports a file that is no executable, and leaves no profile', async () => {
    const dir = await scratch();
    const notABrowser = join(dir, 'not-a-browser.txt');
    await writeFile(notABrowser, 'plain text', 'utf8');
    vi.stubEnv('CHROME_PATH', notABrowser);
    await expect(launchBrowser({ url: 'http://127.0.0.1:1/', headless: true, readyTimeoutMs: 2_000 })).rejects.toThrow(/could not be started|exited/u);
    expect(await ownProfiles()).toEqual([]);
  });

  it('reports a start that fails after spawn returned, instead of ending the process, and leaves no profile', async () => {
    const dir = await scratch();
    const executable = join(dir, 'browser.exe');
    await writeFile(executable, '', 'utf8');
    vi.stubEnv('CHROME_PATH', executable);
    failSpawnLater = true;
    await expect(launchBrowser({ url: 'http://127.0.0.1:1/', headless: true, readyTimeoutMs: 2_000 })).rejects.toThrow('could not be started (ENOENT)');
    // An 'error' event without a listener would have been thrown by now.
    await new Promise((r) => setTimeout(r, 50));
    expect(await ownProfiles()).toEqual([]);
  });
});
