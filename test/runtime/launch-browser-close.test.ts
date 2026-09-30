/**
 * How the close() of a launched browser ends it, with a fake browser process
 * and fake timers, so the result does not depend on how busy the machine is.
 * A browser that ends on the kill is waited for only until it has exited:
 * no 2 s wait and no SIGKILL. One that ignores the kill gets SIGKILL after
 * 2 s. The live test (live-browser.test.ts) bounds the whole shutdown of a
 * real browser only loosely, because a loaded machine stretches the removal
 * of its profile to seconds; a close() that sat through its 2 s and 1 s exit
 * waits would still pass there.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface FakeBrowser extends EventEmitter {
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  /** The signal of each kill() call, undefined for a plain kill(). */
  signals: Array<NodeJS.Signals | undefined>;
  kill(signal?: NodeJS.Signals): boolean;
}

/** The port the fake browser writes to DevToolsActivePort. */
let devToolsPort = 0;
/** Which kill ends the fake browser: any, or only SIGKILL. */
let endsOn: 'any kill' | 'SIGKILL' = 'any kill';
let lastBrowser: FakeBrowser | undefined;

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: ((_executable: string, args: readonly string[]) => {
      // A browser writes DevToolsActivePort into its profile once its debugging port listens.
      const userDataDir = args.find((arg) => arg.startsWith('--user-data-dir='))!.slice('--user-data-dir='.length);
      writeFileSync(join(userDataDir, 'DevToolsActivePort'), `${devToolsPort}\n/devtools/browser/fake`);
      const child = Object.assign(new EventEmitter(), { pid: 424242, exitCode: null, signalCode: null, signals: [] }) as unknown as FakeBrowser;
      child.kill = (signal) => {
        child.signals.push(signal);
        if (endsOn === 'any kill' || signal === 'SIGKILL') {
          // A ChildProcess reports the exit later, with an 'exit' event.
          process.nextTick(() => {
            child.signalCode = signal ?? 'SIGTERM';
            child.emit('exit', null, child.signalCode);
          });
        }
        return true;
      };
      lastBrowser = child;
      return child;
    }) as unknown as typeof actual.spawn,
  };
});

const { launchBrowser } = await import('../../src/runtime/preview-server.js');

const PAGE_URL = 'http://127.0.0.1:1/';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  endsOn = 'any kill';
  lastBrowser = undefined;
  vi.unstubAllEnvs();
  while (cleanups.length > 0) await cleanups.pop()!();
});

/** This test process's browser profiles in the temp folder (test files run in processes of their own). */
async function ownProfiles(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((name) => name.startsWith(`c3mcp-chrome-${process.pid}-`));
}

/**
 * launchBrowser with the fake browser: CHROME_PATH names an empty file, and a
 * local HTTP server answers the browser's /json/list with the page, so the
 * launch finds its page endpoint on the first request.
 */
async function launch(): Promise<{ launched: Awaited<ReturnType<typeof launchBrowser>>; browser: FakeBrowser }> {
  const dir = await mkdtemp(join(tmpdir(), 'c3-launch-close-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const executable = join(dir, 'browser.exe');
  await writeFile(executable, '', 'utf8');
  vi.stubEnv('CHROME_PATH', executable);

  const devTools = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify([{ type: 'page', url: PAGE_URL, webSocketDebuggerUrl: `ws://127.0.0.1:${devToolsPort}/devtools/page/fake` }]));
  });
  await new Promise<void>((done) => devTools.listen(0, '127.0.0.1', done));
  cleanups.push(() => new Promise<void>((done) => {
    devTools.closeAllConnections();
    devTools.close(() => done());
  }));
  devToolsPort = (devTools.address() as AddressInfo).port;

  const launched = await launchBrowser({ url: PAGE_URL, headless: true, readyTimeoutMs: 10_000 });
  // A close() that never ends leaves its profile behind; remove it here then.
  cleanups.push(() => rm(launched.userDataDir, { recursive: true, force: true }));
  expect(launched.pageEndpoint).toBe(`ws://127.0.0.1:${devToolsPort}/devtools/page/fake`);
  return { launched, browser: lastBrowser! };
}

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

/**
 * Whether `closing` settles without the fake clock moving on. A close() that
 * waits on a timer never settles under fake timers; the real-time bound only
 * turns that into a failed assertion, since removing the small fake profile
 * takes milliseconds.
 */
async function settlesWithoutTimers(closing: Promise<void>): Promise<boolean> {
  let bound: ReturnType<typeof setTimeout> | undefined;
  const stuck = new Promise<false>((done) => { bound = realSetTimeout(() => done(false), 10_000); });
  try {
    return await Promise.race([closing.then(() => true as const), stuck]);
  } finally {
    realClearTimeout(bound);
  }
}

describe('closing a launched browser', () => {
  it('waits only until a browser that ends on the kill has exited: no 2 s wait and no SIGKILL', async () => {
    const { launched, browser } = await launch();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const closing = launched.close();
    // close() first checks, with a 0 ms wait, whether the browser still runs, then kills it.
    await vi.advanceTimersByTimeAsync(0);
    expect(browser.signals).toEqual([undefined]);

    expect(await settlesWithoutTimers(closing), 'close() waited on a timer after the browser had exited').toBe(true);
    expect(browser.signals).toEqual([undefined]);
    expect(await ownProfiles()).toEqual([]);
  }, 20_000);

  it('sends SIGKILL 2 s after a kill the browser ignored, and then waits only until it has exited', async () => {
    const { launched, browser } = await launch();
    endsOn = 'SIGKILL';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const closing = launched.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(browser.signals).toEqual([undefined]);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(browser.signals).toEqual([undefined]);
    await vi.advanceTimersByTimeAsync(1);
    expect(browser.signals).toEqual([undefined, 'SIGKILL']);

    expect(await settlesWithoutTimers(closing), 'close() waited on a timer after the browser had exited').toBe(true);
    expect(await ownProfiles()).toEqual([]);
  }, 20_000);
});
