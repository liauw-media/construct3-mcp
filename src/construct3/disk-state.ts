/**
 * What the server knows about the project files on disk (#51).
 *
 * A file stamp (modification time, size, file id) tells cheaply whether a
 * file changed since it was read, without reading it again. The reader keeps
 * the stamps its cached data came from and compares them at the start of each
 * tool call (syncWithDisk), so changes made outside the server — saving in the
 * Construct 3 editor, `git restore`, another program — are picked up. The
 * writer compares the file it is about to replace with the stamp it was read
 * with, and refuses the write when the file changed in between.
 *
 * A tool call scope (AsyncLocalStorage) groups everything one tool call does:
 * the stamps of the files it read, and the files it already backed up, so a
 * call that writes a file twice keeps the backup of the state before the call.
 */

import { AsyncLocalStorage } from 'async_hooks';
import { stat } from 'fs/promises';
import type { Stats } from 'fs';
import { resolve } from 'path';

/** A file's state on disk, enough to tell that it changed. */
export interface FileStamp {
  mtimeMs: number;
  size: number;
  ino: number;
}

/** A stamp, or null for a file that does not exist. */
export type FileState = FileStamp | null;

export function stampOf(stats: Stats): FileStamp {
  return { mtimeMs: stats.mtimeMs, size: stats.size, ino: stats.ino };
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}

/** The file's stamp, or null when there is no file. Other fs errors propagate. */
export async function statFileState(path: string): Promise<FileState> {
  try {
    return stampOf(await stat(path));
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export function sameFileState(a: FileState, b: FileState): boolean {
  if (a === null || b === null) return a === b;
  return a.mtimeMs === b.mtimeMs && a.size === b.size && a.ino === b.ino;
}

const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

/** Map key for a file path: absolute, and ignoring case where the file system does. */
export function fileKey(path: string): string {
  const absolute = resolve(path);
  return CASE_INSENSITIVE_FS ? absolute.toLowerCase() : absolute;
}

// ─── Tool call scope ─────────────────────────────────────────

/** What one tool call has done so far. */
export interface ToolCallScope {
  /** Files the call read (or wrote), by fileKey: the state it read them in (first read wins). */
  readonly reads: Map<string, FileState>;
  /** Files the call already backed up (or found missing before its first write), by fileKey → backup path. */
  readonly backups: Map<string, string>;
  /** Readers that already checked their cached files against the disk in this call. */
  readonly checked: Set<object>;
}

const scopes = new AsyncLocalStorage<ToolCallScope>();

/** The scope of the tool call running now, if any. */
export function currentToolCall(): ToolCallScope | undefined {
  return scopes.getStore();
}

/**
 * Run `fn` as one tool call. Inside a call that is already running, `fn`
 * joins that call's scope.
 */
export function runInToolCall<T>(fn: () => Promise<T>): Promise<T> {
  if (scopes.getStore()) return fn();
  return scopes.run({ reads: new Map(), backups: new Map(), checked: new Set() }, fn);
}

/** Remember the state a file was read in, for the running tool call (the first read of a file counts). */
export function noteFileRead(key: string, state: FileState): void {
  const scope = scopes.getStore();
  if (scope && !scope.reads.has(key)) scope.reads.set(key, state);
}

/** Remember the state the running tool call left a file in by writing it. */
export function noteFileWritten(key: string, state: FileState): void {
  scopes.getStore()?.reads.set(key, state);
}

// ─── Errors ──────────────────────────────────────────────────

/**
 * A write was refused because the file changed on disk after the server read
 * it: writing would replace that change with content built from the old file.
 */
export class StaleFileError extends Error {
  readonly code = 'E_STALE_FILE';

  constructor(message: string) {
    super(message);
    this.name = 'StaleFileError';
  }
}

/** The external-change counter of a reader (0 for test doubles that have none). */
export function diskEpochOf(reader: unknown): number {
  const r = reader as { getDiskEpoch?: () => number };
  return typeof r.getDiskEpoch === 'function' ? r.getDiskEpoch() : 0;
}

/**
 * Let a reader check its cached files against the disk before cached data is
 * used (Construct3ProjectReader.ensureCachesFresh); test doubles without files
 * have nothing to check.
 */
export async function ensureCachesFreshOf(reader: unknown): Promise<void> {
  const r = reader as { ensureCachesFresh?: () => Promise<void> };
  if (typeof r.ensureCachesFresh === 'function') await r.ensureCachesFresh();
}
