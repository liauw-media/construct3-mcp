/**
 * Whether the file system under `dir` (default: the OS temp directory, where
 * the tests create their projects) ignores case in file names, as on Windows
 * and default macOS. Evaluated synchronously so tests can use it in skipIf.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export function isCaseInsensitiveFs(dir: string = tmpdir()): boolean {
  const probeDir = mkdtempSync(join(dir, 'c3-case-probe-'));
  try {
    writeFileSync(join(probeDir, 'Probe.txt'), '');
    return existsSync(join(probeDir, 'probe.txt'));
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}
