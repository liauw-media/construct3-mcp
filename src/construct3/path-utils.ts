/**
 * Path utilities for Construct 3 project file access.
 * Shared between project-reader.ts and project-writer.ts to avoid duplication.
 */

import { resolve, relative, isAbsolute } from 'path';

/**
 * Resolve a path confined within a project directory.
 * Rejects path traversal attempts.
 *
 * @param projectDir  The project root directory (must be absolute)
 * @param segments    Path segments to join and resolve
 * @returns           Absolute resolved path within projectDir
 * @throws            Error if the resolved path escapes projectDir
 */
export function resolveProjectPath(projectDir: string, ...segments: string[]): string {
  const resolved = resolve(projectDir, ...segments);
  const rel = relative(projectDir, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('Path traversal detected: path escapes project directory');
  }
  return resolved;
}
