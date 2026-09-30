/**
 * The runtime tools against a real headless Chrome or Edge and a fake
 * Construct export (test/helpers/fake-c3-export.ts), through the tool
 * handlers. Skipped, with a note in the output, when no browser is found
 * (CHROME_PATH or the platform's usual locations).
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findChrome } from '../../src/runtime/preview-server.js';
import { registerRuntimeTools, type RuntimeToolController } from '../../src/tools/runtime-tools.js';
import { MockServer } from '../mocks/mock-server.js';
import { writeFakeExport } from '../helpers/fake-c3-export.js';

function installedBrowser(): string | undefined {
  try {
    return findChrome();
  } catch {
    return undefined;
  }
}

const browser = installedBrowser();
if (!browser) console.warn('[live-browser.test] No Chrome or Edge found (CHROME_PATH or the usual locations): the live browser tests are skipped.');

// Time budgets for a loaded machine. When the full suite runs next to other
// work, a browser start, the bridge coming up in it and the removal of its
// profile each take seconds instead of a fraction of one. Each budget bounds
// one wait for one event; nothing is retried.
/** A browser start: serve_preview's readyTimeoutMs (default 15 s). */
const BROWSER_READY_MS = 60_000;
/** The bridge answering in the page: connect_to_game's timeoutMs (at most 60 s). */
const BRIDGE_READY_MS = 45_000;
/** A test that starts one browser; the tests that start two get twice this. */
const LIVE_TIMEOUT_MS = 120_000;
/** The cleanup after a test: its browsers and preview servers, then its files. */
const CLEANUP_TIMEOUT_MS = 60_000;
/**
 * Shutdown (controller.close()) gives a browser up to 3 s to exit (kill, then
 * SIGKILL) and then removes its profile, which a loaded machine stretches to
 * seconds: up to 3.7 s measured with the full suite running next to eight
 * busy cores, and about 10 s only under a load at which other tests missed
 * vitest's 5 s default as well. 6 s leaves room for the first and still fails
 * a shutdown that waits seconds for more, such as a graceful browser close.
 */
const SHUTDOWN_BOUND_MS = 6_000;

interface Registered { server: MockServer; controller: RuntimeToolController }

const controllers: RuntimeToolController[] = [];
const cleanups: Array<() => Promise<void>> = [];

// A cleanup takes the controllers and files of its own test when it starts, so
// one that runs on after its hook timed out cannot close the next test's browser.
afterEach(async () => {
  vi.unstubAllEnvs();
  const ownControllers = controllers.splice(0).reverse();
  const ownCleanups = cleanups.splice(0).reverse();
  for (const controller of ownControllers) await controller.close();
  for (const cleanup of ownCleanups) await cleanup();
}, CLEANUP_TIMEOUT_MS);

function register(): Registered {
  const server = new MockServer();
  // The open project is a folder the tests never write into. The tools are registered through
  // withProjectSync (#51), so each call first checks project.c3proj, which this stub never changes.
  const reader = { getProjectDir: () => join(tmpdir(), 'c3mcp-live-test-project'), checkProjectFile: async () => false };
  const controller = registerRuntimeTools({ server: server as never, reader: reader as never, writer: {} as never });
  controllers.push(controller);
  return { server, controller };
}

function parse(result: { content: Array<{ text: string }>; isError?: boolean }): Record<string, any> {
  if (result.isError) throw new Error(result.content[0].text);
  return JSON.parse(result.content[0].text) as Record<string, any>;
}

async function fakeExport(mode: 'dom' | 'worker'): Promise<string> {
  const folder = await writeFakeExport(mode);
  cleanups.push(() => rm(folder, { recursive: true, force: true }));
  return folder;
}

/** serve_preview with a headless browser that gets the whole start-up budget. */
async function servePreview(server: MockServer, folder: string, options: Record<string, unknown> = {}): Promise<Record<string, any>> {
  return parse(await server.callTool('serve_preview', { folder, launchBrowser: true, headless: true, readyTimeoutMs: BROWSER_READY_MS, ...options }));
}

/** An HTTP server on 127.0.0.1:`port` that records every request and upgrade, or undefined when the port is taken. */
async function listenRecorder(port: number): Promise<{ requests: string[]; server: Server } | undefined> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(request.url === '/json/version'
      ? JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/foreign` })
      : JSON.stringify([{ id: 'foreign', type: 'page', url: 'about:blank', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/foreign` }]));
  });
  server.on('upgrade', (request, socket) => {
    requests.push(`UPGRADE ${request.url}`);
    socket.destroy();
  });
  const listening = await new Promise<boolean>((done) => {
    server.once('error', () => done(false));
    server.listen(port, '127.0.0.1', () => done(true));
  });
  if (!listening) return undefined;
  cleanups.push(() => new Promise<void>((done) => server.close(() => done())));
  return { requests, server: server };
}

/** Reload a page through a CDP connection of its own, as a user pressing F5 would. */
async function reloadPage(endpoint: string): Promise<void> {
  const socket = new WebSocket(endpoint);
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail; });
  const answered = new Promise((done) => { socket.onmessage = done; });
  socket.send(JSON.stringify({ id: 1, method: 'Page.reload', params: {} }));
  await answered;
  socket.close();
}

/** This process's browser profiles: another test run on the machine (in parallel, too) has profiles of its own. */
async function profileDirs(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((name) => name.startsWith(`c3mcp-chrome-${process.pid}-`)).sort();
}

describe.skipIf(!browser)('runtime tools against a real headless browser', () => {
  it('launches on a debugging port the browser picks and never contacts another process on 9222', async (context) => {
    const foreign = await listenRecorder(9222);
    if (!foreign) context.skip('port 9222 is in use on this machine');
    const folder = await fakeExport('dom');
    const { server } = register();

    const served = await servePreview(server, folder);
    expect(served.browser.cdpPort).not.toBe(9222);
    const connected = parse(await server.callTool('connect_to_game', { host: '127.0.0.1', port: served.browser.cdpPort, timeoutMs: BRIDGE_READY_MS }));
    expect(connected.gameState.ready).toBe(true);
    parse(await server.callTool('stop_preview', { serverId: served.serverId }));
    expect(foreign!.requests).toEqual([]);
  }, LIVE_TIMEOUT_MS);

  it('removes the browser profile on stop_preview and on shutdown, and shuts down within 6 s', async () => {
    // Profiles this test made that are still there (an earlier test's leftover may go meanwhile).
    const before = await profileDirs();
    const newProfileDirs = async () => (await profileDirs()).filter((name) => !before.includes(name));
    const folder = await fakeExport('dom');
    const { server, controller } = register();

    const first = await servePreview(server, folder);
    parse(await server.callTool('connect_to_game', { host: '127.0.0.1', port: first.browser.cdpPort, timeoutMs: BRIDGE_READY_MS }));
    parse(await server.callTool('stop_preview', { serverId: first.serverId }));
    expect(await newProfileDirs()).toEqual([]);

    const second = await servePreview(server, folder);
    parse(await server.callTool('connect_to_game', { host: '127.0.0.1', port: second.browser.cdpPort, timeoutMs: BRIDGE_READY_MS }));
    const startedAt = Date.now();
    await controller.close();
    expect(Date.now() - startedAt).toBeLessThan(SHUTDOWN_BOUND_MS);
    expect(await newProfileDirs()).toEqual([]);
  }, 2 * LIVE_TIMEOUT_MS);

  it('delivers keys with their real codes, typed text as key presses, and a canvas click', async () => {
    const folder = await fakeExport('dom');
    const { server } = register();
    const served = await servePreview(server, folder);
    const { connectionId } = parse(await server.callTool('connect_to_game', { cdpEndpoint: served.browser.pageEndpoint, timeoutMs: BRIDGE_READY_MS }));
    const inputLog = async () => parse(await server.callTool('call_bridge', { connectionId, command: 'callFunction', args: { name: 'InputLog' } })).result as Array<Record<string, unknown>>;
    await inputLog();

    parse(await server.callTool('simulate_input', { connectionId, action: { type: 'key', key: '.' } }));
    parse(await server.callTool('simulate_input', { connectionId, action: { type: 'type', text: 'a-B' } }));
    const keydowns = (await inputLog()).filter((e) => e.type === 'keydown').map((e) => [e.key, e.code, e.keyCode, e.shiftKey]);
    expect(keydowns).toEqual([
      ['.', 'Period', 190, false],
      ['a', 'KeyA', 65, false],
      ['-', 'Minus', 189, false],
      ['B', 'KeyB', 66, true],
    ]);

    parse(await server.callTool('simulate_input', { connectionId, action: { type: 'click', x: 10, y: 20 }, coordinateSpace: 'canvas' }));
    const clicks = (await inputLog()).filter((e) => e.type === 'click').map((e) => [e.x, e.y]);
    expect(clicks).toEqual([[110, 70]]);
  }, LIVE_TIMEOUT_MS);

  it('taps through touch emulation and leaves the page without touch support afterwards', async () => {
    const folder = await fakeExport('dom');
    const { server } = register();
    const served = await servePreview(server, folder);
    const { connectionId } = parse(await server.callTool('connect_to_game', { cdpEndpoint: served.browser.pageEndpoint, timeoutMs: BRIDGE_READY_MS }));
    const bridge = async (name: string) => parse(await server.callTool('call_bridge', { connectionId, command: 'callFunction', args: { name } })).result;
    expect(await bridge('MaxTouchPoints')).toBe(0);
    await bridge('InputLog');

    parse(await server.callTool('simulate_input', { connectionId, action: { type: 'touch', x: 10, y: 20, gesture: 'tap' }, coordinateSpace: 'canvas' }));
    const touches = (await bridge('InputLog') as Array<Record<string, unknown>>).filter((e) => e.type === 'touchstart' || e.type === 'touchend');
    expect(touches.map((e) => e.type)).toEqual(['touchstart', 'touchend']);
    expect(await bridge('MaxTouchPoints')).toBe(0);
  }, LIVE_TIMEOUT_MS);

  it('runs the whole chain against a game whose runtime is in a worker', async () => {
    const folder = await fakeExport('worker');
    const { server } = register();
    const served = await servePreview(server, folder);
    const connected = parse(await server.callTool('connect_to_game', { host: '127.0.0.1', port: served.browser.cdpPort, timeoutMs: BRIDGE_READY_MS }));
    expect(connected).toMatchObject({ bridgeReady: true, bridgeContext: 'worker', pageVisible: true, gameState: { ready: true, layoutName: 'Title' } });
    const { connectionId } = connected;
    const call = async (command: string, args: Record<string, unknown> = {}) => parse(await server.callTool('call_bridge', { connectionId, command, args })).result;

    expect(await call('callFunction', { name: 'Add', params: [2, 3] })).toBe(5);
    const subscription = parse(await server.callTool('subscribe_events', { connectionId, eventType: 'globalVarChange', filter: { variable: 'Score' } }));
    await call('setGlobalVar', { name: 'Score', value: 7 });
    const waited = parse(await server.callTool('wait_for_condition', { connectionId, condition: { type: 'globalVar', name: 'Score', operator: 'eq', value: 7 }, timeoutMs: 5_000 }));
    expect(waited).toMatchObject({ met: true, finalValue: 7 });
    const events = parse(await server.callTool('read_events', { connectionId, subscriptionId: subscription.subscriptionId }));
    expect(events.events.map((e: { value: unknown }) => e.value)).toEqual([7]);
    await call('goToLayout', { name: 'Game' });
    expect(parse(await server.callTool('wait_for_condition', { connectionId, condition: { type: 'layout', name: 'Game' }, timeoutMs: 5_000 })).met).toBe(true);

    // Input and the canvas stay on the page.
    expect(parse(await server.callTool('get_canvas_size', { connectionId }))).toMatchObject({ left: 100, top: 50, cssWidth: 640, cssHeight: 360 });
    parse(await server.callTool('simulate_input', { connectionId, action: { type: 'click', x: 10, y: 20 }, coordinateSpace: 'canvas' }));
  }, LIVE_TIMEOUT_MS);

  it('says the page reloaded and closes the connection, on the page and in a worker, instead of driving a new game', async () => {
    for (const mode of ['dom', 'worker'] as const) {
      const folder = await fakeExport(mode);
      const { server } = register();
      const served = await servePreview(server, folder);
      const { connectionId, bridgeContext } = parse(await server.callTool('connect_to_game', { cdpEndpoint: served.browser.pageEndpoint, timeoutMs: BRIDGE_READY_MS }));
      expect(bridgeContext).toBe(mode === 'dom' ? 'page' : 'worker');
      const call = (command: string, args: Record<string, unknown> = {}) => server.callTool('call_bridge', { connectionId, command, args });
      parse(await call('setGlobalVar', { name: 'Score', value: 42 }));
      expect(parse(await call('getGlobalVar', { name: 'Score' })).result).toBe(42);

      await reloadPage(served.browser.pageEndpoint);
      await vi.waitFor(async () => {
        const after = await call('getGlobalVar', { name: 'Score' });
        expect(after.isError, mode).toBe(true);
        expect(after.content[0].text, mode).toMatch(/reloaded or navigated/u);
      }, { timeout: 30_000, interval: 200 });
      parse(await server.callTool('stop_preview', { serverId: served.serverId }));
    }
  }, 2 * LIVE_TIMEOUT_MS);

  it('runs the whole chain against a game on the page, cross-origin isolated, with a screenshot over 4 MiB', async () => {
    vi.stubEnv('C3MCP_ALLOW_EVAL', '1');
    const folder = await fakeExport('dom');
    const { server } = register();
    const served = await servePreview(server, folder, { crossOriginIsolated: true, windowWidth: 1920, windowHeight: 1200 });
    expect(served.url).toBe(`http://127.0.0.1:${served.port}/`);
    const connected = parse(await server.callTool('connect_to_game', { cdpEndpoint: served.browser.pageEndpoint, timeoutMs: BRIDGE_READY_MS }));
    expect(connected).toMatchObject({ bridgeContext: 'page', pageVisible: true, gameState: { ready: true } });
    const { connectionId } = connected;
    const expression = async (expr: string) => parse(await server.callTool('wait_for_condition', { connectionId, condition: { type: 'expression', expr, operator: 'neq', value: '__never__' }, timeoutMs: 5_000 })).finalValue;

    expect(await expression('globalThis.crossOriginIsolated')).toBe(true);
    const custom = parse(await server.callTool('subscribe_events', { connectionId, eventType: 'custom', filter: { name: 'Bonus' } }));
    parse(await server.callTool('call_bridge', { connectionId, command: 'callFunction', args: { name: 'Bonus', params: [3] } }));
    const events = parse(await server.callTool('read_events', { connectionId, subscriptionId: custom.subscriptionId }));
    expect(events.events).toEqual([expect.objectContaining({ type: 'custom', name: 'Bonus', value: { n: 3 } })]);

    // Random pixels do not compress: the PNG of a 1920x1080 noise canvas is over 4 MiB as base64.
    await expression('__noise(1920, 1080)');
    const shot = parse(await server.callTool('screenshot_game', { connectionId, outputPath: join(folder, 'shots', 'noise.png'), canvasOnly: true }));
    expect(shot.bytes * 4 / 3).toBeGreaterThan(4 * 1024 * 1024);
    expect(parse(await server.callTool('call_bridge', { connectionId, command: 'ping' })).result).toMatchObject({ pong: true });
    parse(await server.callTool('disconnect_from_game', { connectionId }));
  }, LIVE_TIMEOUT_MS);
});
