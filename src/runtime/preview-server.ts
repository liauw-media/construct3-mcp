/**
 * Serve an exported Construct game over loopback HTTP, and optionally launch
 * Chrome on it with a remote-debugging port so `connect_to_game` can follow.
 * The server listens on 127.0.0.1 only; which interface to listen on and
 * which browser to start are not the tool caller's to choose (the browser
 * comes from CHROME_PATH or the platform's usual locations).
 *
 * The input is an exported HTML5 folder (one that contains `index.html`).
 * A source project folder (`project.c3proj`) or a `.c3p` archive is refused:
 * Construct exports only from its editor, and a source project is not a
 * runnable game (upstream issue 13 proposed extracting a `.c3p`, which does
 * not produce one).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, open, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { tmpdir, platform } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
};

export interface ServePreviewOptions {
  folder: string;
  port?: number;
  /**
   * Send Cross-Origin-Opener-Policy: same-origin and
   * Cross-Origin-Embedder-Policy: require-corp, which a game needs for
   * SharedArrayBuffer (crossOriginIsolated). Off by default: require-corp
   * blocks resources from other origins that do not opt in, such as an SDK
   * loaded from a CDN.
   */
  crossOriginIsolated?: boolean;
}

/**
 * The address the preview server listens on. Not "localhost": that name can
 * resolve to ::1 first, where nothing would listen, and 127.0.0.1 is a secure
 * context in browsers just the same.
 */
export const PREVIEW_HOST = '127.0.0.1';

export interface LaunchBrowserOptions {
  url: string;
  headless: boolean;
  windowWidth?: number;
  windowHeight?: number;
  /** How long to wait for the debugging port to answer (default 15 s). */
  readyTimeoutMs?: number;
}

export interface LaunchedBrowser {
  pid: number;
  executable: string;
  /** The debugging port the browser picked itself and wrote to its profile. */
  cdpPort: number;
  userDataDir: string;
  /** The browser-level CDP endpoint, from the same file. */
  webSocketDebuggerUrl: string;
  /** The CDP endpoint of the tab showing the served URL, when the browser listed it. */
  pageEndpoint?: string;
  close(): Promise<void>;
}

export interface PreviewInfo {
  serverId: string;
  url: string;
  host: string;
  port: number;
  folder: string;
  crossOriginIsolated: boolean;
  requests: number;
  browser?: { pid: number; executable: string; cdpPort: number; pageEndpoint?: string; headless: boolean };
}

/**
 * Resolve an exported game folder, refusing anything that is not one.
 * Returns the absolute folder path.
 */
export async function checkExportFolder(folder: string): Promise<string> {
  const absolute = resolve(folder);
  if (/\.c3p$/iu.test(absolute)) {
    throw new Error(
      'The path is a .c3p archive, which is a source project, not an exported game. Export the project from Construct (Menu > Project > Export > Web (HTML5)) and pass the exported folder.',
    );
  }
  let info;
  try {
    info = await stat(absolute);
  } catch {
    throw new Error(`Folder not found: ${absolute}`);
  }
  if (!info.isDirectory()) throw new Error(`Not a folder: ${absolute}`);
  if (existsSync(join(absolute, 'project.c3proj'))) {
    throw new Error(
      'The folder holds a source project (project.c3proj), not an exported game. Construct exports only from its editor; pass the folder that Export > Web (HTML5) produced.',
    );
  }
  if (!existsSync(join(absolute, 'index.html'))) {
    throw new Error(`No index.html in ${absolute}. Pass the folder an HTML5 export produced, the one that holds index.html.`);
  }
  return absolute;
}

/** True for the names and addresses that reach this machine. */
export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  return bare === 'localhost' || bare === '::1' || /^127\.\d+\.\d+\.\d+$/.test(bare);
}

/**
 * True when a request's Host header names this machine (127.0.0.1, localhost
 * or [::1], any port). Anything else is refused, so a page on another site
 * that points its own host name at 127.0.0.1 (DNS rebinding) cannot read the
 * export through the browser.
 */
export function isAllowedHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  const match = /^(\[[^\]]*\]|[^:]+)(?::\d{1,5})?$/u.exec(host.trim());
  if (!match) return false;
  const name = match[1].toLowerCase();
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
}

/**
 * Map a request path onto a file under `root`, or undefined when it escapes
 * or is missing. `root` is the export folder's real path; the file's real
 * path must lie under it too, so a junction or symbolic link in the export
 * that leads out of it is not followed.
 */
async function resolveFile(root: string, requestPath: string): Promise<string | undefined> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath.split('?')[0]);
  } catch {
    return undefined;
  }
  if (decoded.includes('\0')) return undefined;
  let file = resolve(root, '.' + (decoded.startsWith('/') ? decoded : '/' + decoded));
  if (file !== root && !file.startsWith(root + sep)) return undefined;
  try {
    let info = await stat(file);
    if (info.isDirectory()) {
      file = join(file, 'index.html');
      info = await stat(file);
    }
    if (!info.isFile()) return undefined;
    const real = await realpath(file);
    return real.startsWith(root + sep) ? real : undefined;
  } catch {
    return undefined;
  }
}

export class PreviewServer {
  readonly id = randomUUID();
  requests = 0;
  browser?: LaunchedBrowser;
  browserHeadless = false;

  private constructor(
    readonly folder: string,
    readonly host: string,
    readonly port: number,
    private readonly server: Server,
    readonly crossOriginIsolated: boolean,
  ) {}

  get url(): string {
    return `http://${this.host}:${this.port}/`;
  }

  static async start(options: ServePreviewOptions): Promise<PreviewServer> {
    const root = await realpath(await checkExportFolder(options.folder));
    const host = PREVIEW_HOST;
    const isolated = options.crossOriginIsolated === true;
    let instance: PreviewServer | undefined;
    const server = createServer((request, response) => {
      // Nothing a request meets may escape as an unhandled rejection: that
      // would end the whole MCP server.
      serve(root, request, response, isolated)
        .catch((error: unknown) => {
          console.error('[serve_preview] request failed:', error);
          if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('Internal error');
          else response.destroy();
        })
        .finally(() => { if (instance) instance.requests++; });
    });
    await new Promise<void>((done, fail) => {
      server.once('error', fail);
      server.listen(options.port ?? 0, host, () => {
        server.off('error', fail);
        done();
      });
    });
    const address = server.address() as AddressInfo;
    instance = new PreviewServer(root, host, address.port, server, isolated);
    return instance;
  }

  info(): PreviewInfo {
    return {
      serverId: this.id,
      url: this.url,
      host: this.host,
      port: this.port,
      folder: this.folder,
      crossOriginIsolated: this.crossOriginIsolated,
      requests: this.requests,
      browser: this.browser
        ? {
          pid: this.browser.pid,
          executable: this.browser.executable,
          cdpPort: this.browser.cdpPort,
          pageEndpoint: this.browser.pageEndpoint,
          headless: this.browserHeadless,
        }
        : undefined,
    };
  }

  async stop(): Promise<void> {
    const browser = this.browser;
    this.browser = undefined;
    if (browser) await browser.close();
    await new Promise<void>(done => {
      this.server.closeAllConnections?.();
      this.server.close(() => done());
    });
  }
}

const ISOLATION_HEADERS = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-resource-policy': 'same-origin',
};

async function serve(root: string, request: IncomingMessage, response: ServerResponse, isolated: boolean): Promise<void> {
  if (!isAllowedHostHeader(request.headers.host)) {
    response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('Host not allowed');
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD' }).end();
    return;
  }
  const file = await resolveFile(root, request.url ?? '/');
  if (!file) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
    return;
  }
  // Opened once, and size and content read through that one handle: a file
  // replaced or deleted after the path check (a new export into the served
  // folder) is either the file that was opened or a 404, never a failure.
  let handle;
  try {
    handle = await open(file, 'r');
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
    return;
  }
  let streaming = false;
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    response.writeHead(200, {
      'content-type': MIME_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'no-store',
      ...(isolated ? ISOLATION_HEADERS : {}),
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    streaming = true;
    // pipeline() destroys the read stream, and with it closes the file, when
    // the client goes away mid-download; pipe() left both open.
    await pipeline(handle.createReadStream(), response).catch(() => {
      response.destroy();
    });
  } finally {
    // The read stream closes the handle it was given; otherwise close it here.
    if (!streaming) await handle.close().catch(() => undefined);
  }
}

/** Candidate Chrome executables for this platform, in the order tried. */
export function chromeCandidates(env: NodeJS.ProcessEnv = process.env, os: string = platform()): string[] {
  const out: string[] = [];
  if (env.CHROME_PATH) out.push(env.CHROME_PATH);
  if (os === 'win32') {
    // A POSIX shell (Git Bash) drops ProgramFiles(x86), whose name it cannot
    // hold, so the system drive's usual roots are tried as well.
    const drive = env['SYSTEMDRIVE'] ?? env['SystemDrive'] ?? 'C:';
    const roots = [...new Set([
      env['PROGRAMFILES'], env['ProgramFiles'],
      env['PROGRAMFILES(X86)'], env['ProgramFiles(x86)'],
      `${drive}\\Program Files`, `${drive}\\Program Files (x86)`,
      env['LOCALAPPDATA'], env['LocalAppData'],
    ].filter((r): r is string => !!r))];
    for (const root of roots) out.push(join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    for (const root of roots) out.push(join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  } else if (os === 'darwin') {
    out.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    out.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
    out.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  } else {
    out.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium');
  }
  return out;
}

/**
 * The Chrome (or Edge) executable to launch: `CHROME_PATH` when it is set,
 * otherwise the first platform default that exists. Set by whoever runs the
 * server, never by a tool call.
 */
export function findChrome(env: NodeJS.ProcessEnv = process.env): string {
  // Messages stay free of paths: the client sees a message with paths
  // redacted to nothing, so the locations tried go to the log.
  if (env.CHROME_PATH) {
    if (isFile(env.CHROME_PATH)) return env.CHROME_PATH;
    console.error(`[serve_preview] CHROME_PATH names no file: ${env.CHROME_PATH}`);
    throw new Error('CHROME_PATH is set but names no file (the path is in the server log).');
  }
  const candidates = chromeCandidates(env);
  const found = candidates.find(candidate => isFile(candidate));
  if (!found) {
    console.error(`[serve_preview] no browser executable at any of: ${candidates.join('; ')}`);
    throw new Error(`No Chrome or Edge executable found in the ${candidates.length} usual locations (listed in the server log). Set CHROME_PATH in the server's environment.`);
  }
  return found;
}

/** True for an existing file (not a folder). */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The error for a browser that could not be started; the executable goes to the log only. */
function startError(executable: string, error: unknown): Error {
  console.error(`[serve_preview] could not start ${executable}:`, error);
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return new Error(`The browser could not be started (${code ?? (error instanceof Error ? error.message : String(error))}); the executable is named in the server log. Set CHROME_PATH to a Chrome or Edge executable.`);
}

/**
 * The debugging port and browser endpoint path a Chromium browser writes to
 * `<userDataDir>/DevToolsActivePort` once its debugging server listens, or
 * undefined while the file is missing or incomplete. Launched with
 * --remote-debugging-port=0, the browser picks a free port itself, and a
 * file in the profile it was given can only come from that browser, so the
 * port is never another process's.
 */
export async function readDevToolsActivePort(userDataDir: string): Promise<{ port: number; browserPath: string } | undefined> {
  let text: string;
  try {
    text = await readFile(join(userDataDir, 'DevToolsActivePort'), 'utf8');
  } catch {
    return undefined;
  }
  const [portLine, pathLine] = text.split(/\r?\n/u);
  const port = Number(portLine);
  const browserPath = pathLine?.trim();
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !browserPath?.startsWith('/devtools/browser/')) return undefined;
  return { port, browserPath };
}

async function waitForDevToolsActivePort(
  userDataDir: string,
  timeoutMs: number,
  child: ChildProcess,
  failure: () => Error | undefined,
): Promise<{ port: number; browserPath: string }> {
  const deadline = Date.now() + timeoutMs;
  let exited: number | null | undefined;
  child.once('exit', code => { exited = code ?? -1; });
  while (Date.now() < deadline) {
    const failed = failure();
    if (failed) throw failed;
    if (exited !== undefined) throw new Error(`The browser exited with code ${exited} before its debugging port answered`);
    const active = await readDevToolsActivePort(userDataDir);
    if (active) return active;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`The browser did not open its debugging port within ${timeoutMs} ms`);
}

/** The CDP endpoint of the page showing `url`, polled briefly from the browser's own /json/list. */
async function findPageEndpoint(port: number, url: string, timeoutMs: number): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json() as Array<{ type?: string; url?: string; webSocketDebuggerUrl?: string }>;
        const page = Array.isArray(targets)
          ? targets.find(t => t.type === 'page' && typeof t.url === 'string' && t.url.startsWith(url) && typeof t.webSocketDebuggerUrl === 'string')
          : undefined;
        if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
      }
    } catch {
      // not listed yet
    }
    await new Promise(r => setTimeout(r, 100));
  }
  return undefined;
}

/** Browser profiles are temporary folders named c3mcp-chrome-<server pid>-<6 random characters>. */
const PROFILE_PREFIX = 'c3mcp-chrome-';
const PROFILE_NAME = /^c3mcp-chrome-(\d+)-[A-Za-z0-9]{6}$/u;
/** Written into each profile: the server process and the browser process that use it. */
const OWNER_FILE = 'c3mcp-owner.json';

/** Profiles of this process that could not be removed yet (files still locked); retried on the next launch. */
const pendingProfileRemovals = new Set<string>();

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Remove a profile folder, retrying while a browser that just ended still holds files; false when it stays. */
async function removeProfile(dir: string, maxRetries: number): Promise<boolean> {
  try {
    await rm(dir, { recursive: true, force: true, maxRetries, retryDelay: 50 });
    pendingProfileRemovals.delete(dir);
    return true;
  } catch {
    pendingProfileRemovals.add(dir);
    return false;
  }
}

/**
 * Remove browser profiles earlier runs left behind in `root` (default: the
 * system temp folder): those whose server process has ended and whose
 * browser, if it recorded one, has ended too, plus this process's own
 * profiles an earlier removal could not finish. Folders of running servers
 * and running browsers, and anything not named like a profile, stay.
 * Returns the names removed.
 */
export async function removeStaleProfiles(root: string = tmpdir()): Promise<string[]> {
  for (const dir of [...pendingProfileRemovals]) await removeProfile(dir, 2);
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    const match = PROFILE_NAME.exec(name);
    if (!match) continue;
    const serverPid = Number(match[1]);
    if (serverPid === process.pid || isProcessAlive(serverPid)) continue;
    const dir = join(root, name);
    try {
      const owner = JSON.parse(await readFile(join(dir, OWNER_FILE), 'utf8')) as { browserPid?: unknown };
      if (typeof owner.browserPid === 'number' && isProcessAlive(owner.browserPid)) continue;
    } catch {
      // no owner file: the server ended before its browser started
    }
    if (await removeProfile(dir, 2)) removed.push(name);
  }
  return removed;
}

/** Wait until `child` has exited, at most `timeoutMs`; true when it is gone. */
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(done => {
    const timer = setTimeout(() => { child.off('exit', onExit); done(false); }, timeoutMs);
    const onExit = () => { clearTimeout(timer); done(true); };
    child.once('exit', onExit);
  });
}

/**
 * Launch Chrome on `url` with a fresh profile and a debugging port the
 * browser picks itself (--remote-debugging-port=0, read back from
 * DevToolsActivePort in that profile). Closing ends only this child
 * process, at once, and removes its profile; nothing is ever sent to
 * whatever else listens on a port. Profiles earlier runs left behind are
 * removed first. The child is not detached: it ends with the server process.
 */
export async function launchBrowser(options: LaunchBrowserOptions): Promise<LaunchedBrowser> {
  const executable = findChrome();
  await removeStaleProfiles();
  const userDataDir = await mkdtemp(join(tmpdir(), `${PROFILE_PREFIX}${process.pid}-`));
  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
  ];
  if (options.headless) args.push('--headless=new', '--enable-unsafe-swiftshader', '--use-angle=swiftshader');
  if (options.windowWidth && options.windowHeight) args.push(`--window-size=${options.windowWidth},${options.windowHeight}`);
  args.push(options.url);
  let child: ChildProcess;
  try {
    child = spawn(executable, args, { stdio: 'ignore', windowsHide: false });
  } catch (error) {
    // Thrown at once for some unusable files (EFTYPE on Windows).
    await removeProfile(userDataDir, 2);
    throw startError(executable, error);
  }
  // Node reports a start that fails later (a missing or unusable
  // executable) as an 'error' event; one without a listener would end the
  // MCP server. The listener stays for the child's whole life.
  let failure: Error | undefined;
  const failed = new Promise<void>(done => {
    child.on('error', error => {
      if (!failure) failure = startError(executable, error);
      else console.error('[serve_preview] browser process error:', error);
      done();
    });
  });
  if (child.pid === undefined) {
    // No process: the 'error' event follows on the next tick.
    await Promise.race([failed, new Promise(r => setTimeout(r, 1_000))]);
    await removeProfile(userDataDir, 2);
    throw failure ?? startError(executable, new Error('no process'));
  }
  await writeFile(join(userDataDir, OWNER_FILE), JSON.stringify({ serverPid: process.pid, browserPid: child.pid })).catch(() => undefined);
  let active: { port: number; browserPath: string };
  try {
    active = await waitForDevToolsActivePort(userDataDir, options.readyTimeoutMs ?? 15_000, child, () => failure);
  } catch (error) {
    child.kill();
    await waitForExit(child, 2_000);
    await removeProfile(userDataDir, 6);
    throw error;
  }
  const pid = child.pid;
  let closed = false;
  return {
    pid,
    executable,
    cdpPort: active.port,
    userDataDir,
    webSocketDebuggerUrl: `ws://127.0.0.1:${active.port}${active.browserPath}`,
    pageEndpoint: await findPageEndpoint(active.port, options.url, 2_000),
    async close() {
      if (closed) return;
      closed = true;
      // Only our own child is ended; its profile goes with it.
      if (!await waitForExit(child, 0)) {
        child.kill();
        if (!await waitForExit(child, 2_000)) {
          child.kill('SIGKILL');
          await waitForExit(child, 1_000);
        }
      }
      // The browser's helper processes can hold profile files a moment
      // longer; what still stays is removed on the next launch.
      await removeProfile(userDataDir, 6);
    },
  };
}

/** The preview servers one MCP server process holds, closed with it. */
export class PreviewManager {
  private readonly servers = new Map<string, PreviewServer>();

  async serve(options: ServePreviewOptions & { launch?: Omit<LaunchBrowserOptions, 'url'> }): Promise<PreviewInfo> {
    const server = await PreviewServer.start(options);
    if (options.launch) {
      try {
        server.browser = await launchBrowser({ ...options.launch, url: server.url });
        server.browserHeadless = options.launch.headless;
      } catch (error) {
        await server.stop();
        throw error;
      }
    }
    this.servers.set(server.id, server);
    return server.info();
  }

  get(serverId: string): PreviewServer | undefined {
    return this.servers.get(serverId);
  }

  list(): PreviewInfo[] {
    return [...this.servers.values()].map(server => server.info());
  }

  async stop(serverId: string): Promise<PreviewInfo> {
    const server = this.servers.get(serverId);
    if (!server) throw new Error(`Unknown preview server: ${serverId}`);
    this.servers.delete(serverId);
    const info = server.info();
    await server.stop();
    return info;
  }

  async closeAll(): Promise<void> {
    const servers = [...this.servers.values()];
    this.servers.clear();
    await Promise.all(servers.map(server => server.stop().catch(() => undefined)));
  }
}
