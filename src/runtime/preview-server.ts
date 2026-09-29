/**
 * Serve an exported Construct game over loopback HTTP, and optionally launch
 * Chrome on it with a remote-debugging port so `connect_to_game` can follow.
 *
 * The input is an exported HTML5 folder (one that contains `index.html`).
 * A source project folder (`project.c3proj`) or a `.c3p` archive is refused:
 * Construct exports only from its editor, and a source project is not a
 * runnable game (upstream issue 13 proposed extracting a `.c3p`, which does
 * not produce one).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';

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
  host?: string;
  port?: number;
}

export interface LaunchBrowserOptions {
  url: string;
  debuggingPort: number;
  chromePath?: string;
  headless: boolean;
  windowWidth?: number;
  windowHeight?: number;
  /** How long to wait for the debugging port to answer (default 15 s). */
  readyTimeoutMs?: number;
}

export interface LaunchedBrowser {
  pid: number;
  executable: string;
  cdpPort: number;
  userDataDir: string;
  /** The browser-level CDP endpoint reported by /json/version. */
  webSocketDebuggerUrl?: string;
  close(): Promise<void>;
}

export interface PreviewInfo {
  serverId: string;
  url: string;
  host: string;
  port: number;
  folder: string;
  requests: number;
  browser?: { pid: number; executable: string; cdpPort: number; headless: boolean };
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

/** Map a request path onto a file under `root`, or undefined when it escapes or is missing. */
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
    return info.isFile() ? file : undefined;
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
  ) {}

  get url(): string {
    const host = this.host.includes(':') && !this.host.startsWith('[') ? `[${this.host}]` : this.host;
    return `http://${host}:${this.port}/`;
  }

  static async start(options: ServePreviewOptions): Promise<PreviewServer> {
    const root = await checkExportFolder(options.folder);
    const host = options.host ?? 'localhost';
    let instance: PreviewServer | undefined;
    const server = createServer((request, response) => {
      void serve(root, request, response).then(() => { if (instance) instance.requests++; });
    });
    await new Promise<void>((done, fail) => {
      server.once('error', fail);
      server.listen(options.port ?? 0, host, () => {
        server.off('error', fail);
        done();
      });
    });
    const address = server.address() as AddressInfo;
    instance = new PreviewServer(root, host, address.port, server);
    return instance;
  }

  info(): PreviewInfo {
    return {
      serverId: this.id,
      url: this.url,
      host: this.host,
      port: this.port,
      folder: this.folder,
      requests: this.requests,
      browser: this.browser
        ? { pid: this.browser.pid, executable: this.browser.executable, cdpPort: this.browser.cdpPort, headless: this.browserHeadless }
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

async function serve(root: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD' }).end();
    return;
  }
  const file = await resolveFile(root, request.url ?? '/');
  if (!file) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
    return;
  }
  const info = await stat(file);
  response.writeHead(200, {
    'content-type': MIME_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': 'no-store',
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  await new Promise<void>((done) => {
    const stream = createReadStream(file);
    stream.on('error', () => { response.destroy(); done(); });
    stream.on('end', done);
    stream.pipe(response);
  });
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

/** The Chrome (or Edge) executable to launch: the explicit path, `CHROME_PATH`, or the first platform default that exists. */
export function findChrome(explicit?: string): string {
  // Messages stay free of paths: the client sees a message with paths
  // redacted to nothing, so the list of locations tried goes to the log.
  if (explicit) {
    if (existsSync(explicit)) return explicit;
    throw new Error('Chrome executable not found at the given chromePath.');
  }
  const candidates = chromeCandidates();
  const found = candidates.find(candidate => existsSync(candidate));
  if (!found) {
    console.error(`[serve_preview] no browser executable at any of: ${candidates.join('; ')}`);
    throw new Error(`No Chrome or Edge executable found in the ${candidates.length} usual locations (listed in the server log). Pass chromePath or set CHROME_PATH.`);
  }
  return found;
}

async function waitForDebugger(port: number, timeoutMs: number, child: ChildProcess): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  let exited: number | null | undefined;
  child.once('exit', code => { exited = code ?? -1; });
  while (Date.now() < deadline) {
    if (exited !== undefined) throw new Error(`The browser exited with code ${exited} before its debugging port answered`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        const version = await response.json() as { webSocketDebuggerUrl?: string };
        return version.webSocketDebuggerUrl;
      }
    } catch {
      // not up yet
    }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`The browser's debugging port ${port} did not answer within ${timeoutMs} ms`);
}

/** Ask a running browser to close through its CDP endpoint; resolves false when it could not be reached. */
async function browserClose(webSocketDebuggerUrl: string): Promise<boolean> {
  return new Promise(done => {
    const socket = new WebSocket(webSocketDebuggerUrl);
    const timer = setTimeout(() => { socket.terminate(); done(false); }, 2000);
    socket.once('open', () => {
      socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      setTimeout(() => { clearTimeout(timer); socket.terminate(); done(true); }, 300);
    });
    socket.once('error', () => { clearTimeout(timer); done(false); });
  });
}

/**
 * Launch Chrome on `url` with a remote-debugging port and a fresh profile.
 * The child is not detached: it ends with the server process.
 */
export async function launchBrowser(options: LaunchBrowserOptions): Promise<LaunchedBrowser> {
  const executable = findChrome(options.chromePath);
  const userDataDir = await mkdtemp(join(tmpdir(), 'c3mcp-chrome-'));
  const args = [
    `--remote-debugging-port=${options.debuggingPort}`,
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
  const child = spawn(executable, args, { stdio: 'ignore', windowsHide: false });
  if (child.pid === undefined) throw new Error(`Could not start ${executable}`);
  let webSocketDebuggerUrl: string | undefined;
  try {
    webSocketDebuggerUrl = await waitForDebugger(options.debuggingPort, options.readyTimeoutMs ?? 15_000, child);
  } catch (error) {
    child.kill();
    await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  const pid = child.pid;
  let closed = false;
  return {
    pid,
    executable,
    cdpPort: options.debuggingPort,
    userDataDir,
    webSocketDebuggerUrl,
    async close() {
      if (closed) return;
      closed = true;
      const asked = webSocketDebuggerUrl ? await browserClose(webSocketDebuggerUrl) : false;
      const gone = await new Promise<boolean>(done => {
        if (child.exitCode !== null) { done(true); return; }
        const timer = setTimeout(() => done(false), asked ? 3000 : 0);
        child.once('exit', () => { clearTimeout(timer); done(true); });
      });
      if (!gone) child.kill();
      await new Promise(r => setTimeout(r, 300));
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
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
