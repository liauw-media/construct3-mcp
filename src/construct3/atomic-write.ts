/**
 * Atomic file replacement that keeps an existing file's name on disk.
 *
 * Files are replaced by writing <file>.tmp and renaming it onto <file>. On a
 * case-insensitive file system (Windows, default macOS) the path can name an
 * existing file whose name differs in case — "layout1.json" finds
 * "Layout1.json" when project.c3proj spells the entity "layout1" — and the
 * rename would silently change the name on disk to the path's spelling. With
 * git's core.ignorecase=true nothing shows the change until a checkout on a
 * case-sensitive file system. So writes first resolve the path to the name on
 * disk (existingSpelling).
 */

import { readdir, rename, stat, unlink, writeFile } from 'fs/promises';
import { basename, dirname, join } from 'path';
import { nameKey } from './names.js';

/** The file system calls used to resolve names on disk (injectable for tests). */
export interface DirectoryLookup {
  stat(path: string): Promise<unknown>;
  readdir(path: string): Promise<string[]>;
}

const nodeLookup: DirectoryLookup = {
  stat: (path) => stat(path),
  readdir: (path) => readdir(path),
};

/**
 * The entries of `filePath`'s directory whose name equals its file name
 * ignoring case, the exact name first. Empty when the directory cannot be read.
 */
async function caseVariants(filePath: string, fs: DirectoryLookup): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dirname(filePath));
  } catch {
    return [];
  }
  const base = basename(filePath);
  const key = nameKey(base);
  const matches = entries.filter(e => nameKey(e) === key);
  return matches.sort((a, b) => Number(b === base) - Number(a === base));
}

/**
 * `filePath` spelled the way the file it refers to is named on disk. Only the
 * file name is resolved. The path comes back unchanged when it does not exist,
 * when the directory lists it with exactly this spelling, or when the name is
 * ambiguous (several entries match ignoring case). The file must exist at
 * `filePath` (stat succeeds), so on a case-sensitive file system a write never
 * lands on another file whose name differs only in case.
 */
export async function existingSpelling(filePath: string, fs: DirectoryLookup = nodeLookup): Promise<string> {
  try {
    await fs.stat(filePath);
  } catch {
    return filePath; // new file (or unreadable): the write itself reports errors
  }
  const variants = await caseVariants(filePath, fs);
  if (variants.length !== 1) return filePath;
  return variants[0] === basename(filePath) ? filePath : join(dirname(filePath), variants[0]);
}

/**
 * The file on disk whose name equals `filePath`'s file name ignoring case
 * (the exact name when present), or undefined. Unlike existingSpelling this
 * does not depend on the file system's case sensitivity: create tools use it
 * to refuse a name that would share its file on Windows and macOS.
 */
export async function findFileIgnoringCase(filePath: string, fs: DirectoryLookup = nodeLookup): Promise<string | undefined> {
  const variants = await caseVariants(filePath, fs);
  return variants.length > 0 ? join(dirname(filePath), variants[0]) : undefined;
}

/**
 * Replace (or create) a file atomically: write <file>.tmp, then rename it onto
 * the file, keeping an existing file's name on disk (see existingSpelling).
 * On Windows, rename can fail with EEXIST when the destination exists; the
 * destination is then deleted and the rename retried. Returns the path written.
 */
export async function atomicReplace(filePath: string, content: string | Buffer): Promise<string> {
  const target = await existingSpelling(filePath);
  const tmpPath = target + '.tmp';
  await writeFile(tmpPath, content, typeof content === 'string' ? 'utf-8' : undefined);
  try {
    await rename(tmpPath, target);
  } catch (e: unknown) {
    if (e && typeof e === 'object' && 'code' in e && e.code === 'EEXIST') {
      await unlink(target);
      await rename(tmpPath, target);
    } else {
      try { await unlink(tmpPath); } catch { /* best-effort */ }
      throw e;
    }
  }
  return target;
}
