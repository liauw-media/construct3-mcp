/**
 * The runtime tools against a real headless Chrome or Edge and a fake
 * Construct export (test/helpers/fake-c3-export.ts), through the tool
 * handlers. Skipped, with a note in the output, when no browser is found
 * (CHROME_PATH or the platform's usual locations).
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
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

// Starting a browser takes a few seconds, more on a busy machine.
const LIVE_TIMEOUT_MS = 60_000;

interface Registered { server: MockServer; controller: RuntimeToolController }

const controllers: RuntimeToolController[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (controllers.length > 0) await controllers.pop()!.close();
  while (cleanups.length > 0) await cleanups.pop()!();
});

function register(): Registered {
  const server = new MockServer();
  const controller = registerRuntimeTools({ server: server as never, reader: {} as never, writer: {} as never });
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

async function profileDirs(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((name) => name.startsWith('c3mcp-chrome-')).sort();
}

describe.skipIf(!browser)('runtime tools against a real headless browser', () => {
  it('launches on a debugging port the browser picks and never contacts another process on 9222', async (context) => {
    const foreign = await listenRecorder(9222);
    if (!foreign) context.skip('port 9222 is in use on this machine');
    const folder = await fakeExport('dom');
    const { server } = register();

    const served = parse(await server.callTool('serve_preview', { folder, launchBrowser: true, headless: true }));
    expect(served.browser.cdpPort).not.toBe(9222);
    const connected = parse(await server.callTool('connect_to_game', { host: '127.0.0.1', port: served.browser.cdpPort, timeoutMs: 15_000 }));
    expect(connected.gameState.ready).toBe(true);
    parse(await server.callTool('stop_preview', { serverId: served.serverId }));
    expect(foreign!.requests).toEqual([]);
  }, LIVE_TIMEOUT_MS);

  it('removes the browser profile on stop_preview and on shutdown, and shuts down within 2 s', async () => {
    // Profiles this test made that are still there (an earlier test's leftover may go meanwhile).
    const before = await profileDirs();
    const newProfileDirs = async () => (await profileDirs()).filter((name) => !before.includes(name));
    const folder = await fakeExport('dom');
    const { server, controller } = register();

    const first = parse(await server.callTool('serve_preview', { folder, launchBrowser: true, headless: true }));
    parse(await server.callTool('connect_to_game', { host: '127.0.0.1', port: first.browser.cdpPort, timeoutMs: 15_000 }));
    parse(await server.callTool('stop_preview', { serverId: first.serverId }));
    expect(await newProfileDirs()).toEqual([]);

    const second = parse(await server.callTool('serve_preview', { folder, launchBrowser: true, headless: true }));
    parse(await server.callTool('connect_to_game', { host: '127.0.0.1', port: second.browser.cdpPort, timeoutMs: 15_000 }));
    const startedAt = Date.now();
    await controller.close();
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(await newProfileDirs()).toEqual([]);
  }, LIVE_TIMEOUT_MS);

  it('delivers keys with their real codes, typed text as key presses, and a canvas click', async () => {
    const folder = await fakeExport('dom');
    const { server } = register();
    const served = parse(await server.callTool('serve_preview', { folder, launchBrowser: true, headless: true }));
    const { connectionId } = parse(await server.callTool('connect_to_game', { cdpEndpoint: served.browser.pageEndpoint, timeoutMs: 15_000 }));
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
    const served = parse(await server.callTool('serve_preview', { folder, launchBrowser: true, headless: true }));
    const { connectionId } = parse(await server.callTool('connect_to_game', { cdpEndpoint: served.browser.pageEndpoint, timeoutMs: 15_000 }));
    const bridge = async (name: string) => parse(await server.callTool('call_bridge', { connectionId, command: 'callFunction', args: { name } })).result;
    expect(await bridge('MaxTouchPoints')).toBe(0);
    await bridge('InputLog');

    parse(await server.callTool('simulate_input', { connectionId, action: { type: 'touch', x: 10, y: 20, gesture: 'tap' }, coordinateSpace: 'canvas' }));
    const touches = (await bridge('InputLog') as Array<Record<string, unknown>>).filter((e) => e.type === 'touchstart' || e.type === 'touchend');
    expect(touches.map((e) => e.type)).toEqual(['touchstart', 'touchend']);
    expect(await bridge('MaxTouchPoints')).toBe(0);
  }, LIVE_TIMEOUT_MS);
});
