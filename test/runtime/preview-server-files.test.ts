/**
 * serve_preview's server while files in the export change under it: a file
 * that vanishes between the path check and the read answers 404 (before, the
 * request's promise rejected unhandled and ended the whole MCP server).
 *
 * The vanishing file is played by node:fs/promises answering the path check
 * and then reporting ENOENT for the same file, which is what a re-export
 * into the served folder does between the two steps.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const VANISHING = 'flip.js';
let vanishingChecks = 0;

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const gone = (path: unknown) => Object.assign(new Error(`ENOENT: no such file or directory, open '${String(path)}'`), { code: 'ENOENT' });
  const vanishes = (path: unknown) => typeof path === 'string' && path.endsWith(VANISHING);
  return {
    ...actual,
    // The first look at the file finds it; every later one does not.
    stat: (async (path: Parameters<typeof actual.stat>[0], ...rest: unknown[]) => {
      if (vanishes(path) && vanishingChecks++ > 0) throw gone(path);
      return (actual.stat as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof actual.stat,
    open: (async (path: Parameters<typeof actual.open>[0], ...rest: unknown[]) => {
      if (vanishes(path)) throw gone(path);
      return (actual.open as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof actual.open,
  };
});

const { PreviewServer } = await import('../../src/runtime/preview-server.js');

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function makeExport(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'c3-preview-files-'));
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const game = join(root, 'game');
  await mkdir(game);
  await writeFile(join(game, 'index.html'), '<!doctype html><title>Game</title>', 'utf8');
  await writeFile(join(game, VANISHING), 'console.log(1)', 'utf8');
  return game;
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return check();
}

describe('PreviewServer with files changing under it', () => {
  it('answers 404 for a file that vanished after the path check, and keeps serving', async () => {
    const game = await makeExport();
    const server = await PreviewServer.start({ folder: game });
    cleanups.push(() => server.stop());
    vanishingChecks = 0;

    const vanished = await fetch(server.url + VANISHING, { signal: AbortSignal.timeout(3_000) });
    expect(vanished.status).toBe(404);
    const index = await fetch(server.url, { signal: AbortSignal.timeout(3_000) });
    expect(index.status).toBe(200);
    expect(await waitFor(() => server.info().requests === 2, 2_000)).toBe(true);
  });
});
