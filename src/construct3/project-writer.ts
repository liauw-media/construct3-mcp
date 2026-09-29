/**
 * Safe write operations for Construct 3 projects.
 * Safety model: backup → validate → write → verify → invalidate caches.
 * Files keep their on-disk text style (line endings, trailing newline, BOM);
 * see json-format.ts.
 */

import { readFile, writeFile, copyFile, unlink, mkdir, stat, rename, readdir } from 'fs/promises';
import { dirname, relative, sep } from 'path';
import { resolveProjectPath } from './path-utils.js';
import { atomicReplace, existingSpelling, findFileIgnoringCase } from './atomic-write.js';
import type { Construct3ProjectReader } from './project-reader.js';
import type { IdGenerator } from './id-generator.js';
import type { Addon, Subfolder, ProjectProperties } from './types.js';
import { resetProjectIndex } from './analyzers/index-builder.js';
import { KNOWN_SCIRRA_PLUGINS, KNOWN_SCIRRA_BEHAVIORS } from './templates.js';
import { generatePlaceholderPng, getImageFileName } from './png-generator.js';
import { applyJsonTextStyle, jsonTextStyleOf, parseJsonText, resolveJsonTextStyle } from './json-format.js';
import { simulateImageRenames } from './animation-rename.js';

/** Maximum entity file size we'll write (5MB — well above any real C3 entity) */
const MAX_WRITE_SIZE = 5 * 1024 * 1024;

/** Keys allowed at the project root level (outside properties) */
const ALLOWED_TOP_LEVEL = new Set(['name']);

/**
 * Compile-time enforced map of ProjectProperties keys.
 * If a key is added/removed from the interface, TypeScript will error here.
 */
const PROPERTIES_KEY_MAP: Record<keyof ProjectProperties, true> = {
  description: true, version: true, autoIncrementVersion: true,
  author: true, authorEmail: true, authorWebsite: true, appId: true,
  pixelRounding: true, zAxisScale: true, fov: true, useLoaderLayout: true,
  fullscreenMode: true, fullscreenQuality: true, viewportFit: true,
  backgroundColor: true, splashColor: true, useThemeColor: true,
  themeColor: true, orientations: true, webgpu: true, multitexturing: true, gpuPreference: true,
  scriptsType: true, framerateMode: true, sampling: true, downscaling: true,
  renderingMode: true, anisotropicFiltering: true, zNear: true, zFar: true,
  maxSpriteSheetSize: true, loaderStyle: true, preloadSounds: true,
  cordovaiOSScheme: true, cordovaAndroidScheme: true,
  exportFileStructure: true, uidAllocationMode: true,
};
const ALLOWED_PROPERTIES = new Set(Object.keys(PROPERTIES_KEY_MAP));

type EntityCategory = 'objectTypes' | 'eventSheets' | 'layouts' | 'families';

/** Options for Construct3ProjectWriter.writeEntityFile. */
export interface WriteEntityOptions {
  /**
   * The entity is new: refuse to write (no backup, no write) when a file for it
   * already exists, also one whose name differs only in case.
   */
  createOnly?: boolean;
}

/**
 * A new, empty project-bar folder for a project.c3proj container. The key
 * order (items, subfolders, name) is the one the Construct 3 editor writes,
 * so its next save of the project does not reorder the folder.
 */
export function newProjectFolder(name: string): Subfolder {
  return { items: [], subfolders: [], name };
}

/**
 * writeEntityFile failed after it backed the file up, while or after
 * replacing it: the file may hold the new content (e.g. the post-write check
 * failed), none, or its old content. `backupPath` is the path writeEntityFile
 * returns on success; restoreEntityFile(backupPath) puts the content from
 * before the call back when the file existed (for a new file there is no
 * backup). The message is the cause's.
 */
export class EntityWriteError extends Error {
  constructor(cause: unknown, readonly backupPath: string) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'EntityWriteError';
  }
}

export class Construct3ProjectWriter {
  private projectLock: Promise<void> = Promise.resolve();

  constructor(
    private reader: Construct3ProjectReader,
    private idGen: IdGenerator,
  ) {}

  /**
   * Serialize access to the .c3proj file to prevent lost-update races.
   */
  private async withProjectLock<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>(resolve => { release = resolve; });
    const prev = this.projectLock;
    this.projectLock = next;
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Atomically replace a file (temp file + rename), keeping an existing file's
   * name on disk, including its case (see atomic-write.ts).
   */
  private async atomicWrite(filePath: string, content: string | Buffer): Promise<void> {
    await atomicReplace(filePath, content);
  }

  /**
   * Create a .bak backup of a file before overwriting.
   * Returns the backup path (even if the original didn't exist).
   */
  private async createBackup(path: string): Promise<string> {
    // The backup takes the file's name as spelled on disk
    const filePath = await existingSpelling(path);
    const backupPath = filePath + '.bak';
    try {
      await stat(filePath);
    } catch (e: unknown) {
      // File doesn't exist yet (new entity) — no backup needed
      if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') return backupPath;
      throw new Error(`Cannot access file for backup: ${e instanceof Error ? e.message : String(e)}`);
    }
    // File exists — backup must succeed or we abort
    await copyFile(filePath, backupPath);
    return backupPath;
  }

  /**
   * Validate JSON data before writing — ensures we won't write garbage.
   */
  private validateJsonData(data: unknown, entityName: string): string {
    if (data === null || data === undefined) {
      throw new Error(`Cannot write null/undefined data for "${entityName}"`);
    }
    if (typeof data !== 'object') {
      throw new Error(`Data for "${entityName}" must be an object, got ${typeof data}`);
    }

    const json = JSON.stringify(data, null, '\t');

    if (json.length > MAX_WRITE_SIZE) {
      throw new Error(`Generated JSON for "${entityName}" is too large (${(json.length / 1024 / 1024).toFixed(1)}MB > 5MB limit)`);
    }

    // Verify it round-trips cleanly
    try {
      JSON.parse(json);
    } catch (e) {
      throw new Error(`Generated JSON for "${entityName}" is not valid: ${e instanceof Error ? e.message : String(e)}`);
    }

    return json;
  }

  /**
   * Post-write verification — read the file back, check it holds exactly the
   * text we wrote, and verify it parses. Different content that still parses
   * means another write to the same file landed in between (e.g. two tool
   * calls in parallel), which is reported as such rather than as corruption.
   */
  private async verifyWrittenFile(filePath: string, entityName: string, expected: string): Promise<void> {
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
      parseJsonText(content);
    } catch (e) {
      throw new Error(`Post-write verification failed for "${entityName}": file may be corrupted. A .bak backup exists. Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (content !== expected) {
      throw new Error(`Post-write verification failed for "${entityName}": the file was changed by another write during this one (concurrent writes to the same file?). It holds valid JSON, but not this call's changes. Re-read it and retry.`);
    }
  }

  /**
   * Validate, write and verify project.c3proj, keeping the text style of
   * `original` (the content it was read from). Caller holds the project lock.
   */
  private async writeProjectFile(projectPath: string, project: unknown, original: string): Promise<void> {
    const json = this.validateJsonData(project, 'project.c3proj');
    const text = applyJsonTextStyle(json, jsonTextStyleOf(original));
    await this.atomicWrite(projectPath, text);
    await this.verifyWrittenFile(projectPath, 'project.c3proj', text);
  }

  /** Path of an entity's JSON file, confined to the project directory. */
  private entityFilePath(category: EntityCategory, name: string, subfolder?: string): string {
    const segments = subfolder
      ? [category, subfolder, `${name}.json`]
      : [category, `${name}.json`];
    return resolveProjectPath(this.reader.getProjectDir(), ...segments);
  }

  /**
   * Why a new entity cannot be written: the file it would be written to already
   * exists, also when its name there differs only in case (on Windows and macOS
   * that is the same file, and writing would replace it). Returns the refusal
   * text, or undefined when the name is free on disk. Create tools check this
   * before their first write and return the text as a tool error.
   */
  async entityFileRefusal(category: EntityCategory, name: string, subfolder?: string): Promise<string | undefined> {
    const existing = await findFileIgnoringCase(this.entityFilePath(category, name, subfolder));
    if (!existing) return undefined;
    const label = relative(this.reader.getProjectDir(), existing).split(sep).join('/');
    return `Refusing to create "${name}": the file ${label} already exists (not registered in project.c3proj under this name, ` +
      'or registered with a name that differs only in case). It was left unchanged. Choose another name, or, if the file ' +
      'is a leftover of a deleted entity, check it and remove it first.';
  }

  /**
   * Write an entity JSON file (object, event sheet, layout, family). An
   * existing file keeps its name on disk, including its case.
   */
  async writeEntityFile(
    category: EntityCategory,
    name: string,
    data: unknown,
    subfolder?: string,
    options: WriteEntityOptions = {},
  ): Promise<string> {
    // Pre-write validation
    const json = this.validateJsonData(data, name);
    if (options.createOnly) {
      const refusal = await this.entityFileRefusal(category, name, subfolder);
      if (refusal) throw new Error(refusal);
    }

    const requested = this.entityFilePath(category, name, subfolder);

    // Ensure directory exists
    await mkdir(dirname(requested), { recursive: true });
    const filePath = await existingSpelling(requested);

    // Keep the existing file's text style; a new file follows the project's
    const style = await resolveJsonTextStyle(filePath, this.reader.getProjectPath(), dirname(filePath));
    const text = applyJsonTextStyle(json, style);

    const backupPath = await this.createBackup(filePath);
    try {
      await this.atomicWrite(filePath, text);

      // Post-write verification
      await this.verifyWrittenFile(filePath, name, text);
    } catch (error) {
      // The file may have been replaced already: tell the caller where the backup is
      throw new EntityWriteError(error, backupPath);
    }

    this.invalidateAll();
    return backupPath;
  }

  /**
   * Delete an entity JSON file.
   */
  async deleteEntityFile(
    category: EntityCategory,
    name: string,
    subfolder?: string,
  ): Promise<string> {
    const filePath = this.entityFilePath(category, name, subfolder);

    const backupPath = await this.createBackup(filePath);
    try {
      await unlink(filePath);
    } catch (e: unknown) {
      // File already gone — that's the desired end state
      if (!(e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT')) {
        throw e;
      }
    }

    this.invalidateAll();
    return backupPath;
  }

  /**
   * Add a name to a c3proj container (objectTypes, eventSheets, layouts, families).
   */
  async addToProject(
    category: EntityCategory,
    name: string,
    subfolder?: string,
  ): Promise<void> {
    return this.withProjectLock(async () => {
      const projectPath = this.reader.getProjectPath();
      await this.createBackup(projectPath);

      const content = await readFile(projectPath, 'utf-8');
      const project = parseJsonText(content);
      const container = project[category];

      if (subfolder) {
        const target = this.findOrCreateSubfolder(container, subfolder);
        if (!target.items.includes(name)) {
          target.items.push(name);
        }
      } else {
        if (!container.items.includes(name)) {
          container.items.push(name);
        }
      }

      await this.writeProjectFile(projectPath, project, content);
      await this.reader.reloadProject();
    });
  }

  /**
   * Remove a name from a c3proj container.
   */
  async removeFromProject(
    category: EntityCategory,
    name: string,
  ): Promise<void> {
    return this.withProjectLock(async () => {
      const projectPath = this.reader.getProjectPath();
      await this.createBackup(projectPath);

      const content = await readFile(projectPath, 'utf-8');
      const project = parseJsonText(content);
      const container = project[category];

      // Remove from root items
      const rootIdx = container.items.indexOf(name);
      if (rootIdx !== -1) {
        container.items.splice(rootIdx, 1);
      } else {
        // Search subfolders
        this.removeFromSubfolders(container.subfolders, name);
      }

      await this.writeProjectFile(projectPath, project, content);
      await this.reader.reloadProject();
    });
  }

  /**
   * Update the project.c3proj properties (metadata).
   */
  async updateProjectProperties(updates: Record<string, unknown>): Promise<string> {
    // Validate all keys against the allowlist before acquiring the lock
    const unknownKeys = Object.keys(updates).filter(
      k => !ALLOWED_TOP_LEVEL.has(k) && !ALLOWED_PROPERTIES.has(k),
    );
    if (unknownKeys.length > 0) {
      const validKeys = [...ALLOWED_TOP_LEVEL, ...ALLOWED_PROPERTIES].sort().join(', ');
      throw new Error(
        `Unknown project property key(s): ${unknownKeys.join(', ')}. ` +
        `Valid keys are: ${validKeys}`,
      );
    }

    return this.withProjectLock(async () => {
      const projectPath = this.reader.getProjectPath();
      const backupPath = await this.createBackup(projectPath);

      const content = await readFile(projectPath, 'utf-8');
      const project = parseJsonText(content);

      // Apply updates to top-level and properties
      for (const [key, value] of Object.entries(updates)) {
        if (ALLOWED_TOP_LEVEL.has(key)) {
          project[key] = value;
        } else {
          project.properties[key] = value;
        }
      }

      await this.writeProjectFile(projectPath, project, content);
      await this.reader.reloadProject();

      return backupPath;
    });
  }

  /**
   * Get the subfolder path for an existing entity name.
   */
  getSubfolderForEntity(
    category: EntityCategory,
    name: string,
  ): string | undefined {
    const project = this.reader.getProject();
    const container = project[category];

    if (container.items.includes(name)) return undefined;

    const findInSubfolders = (subfolders: Subfolder[], prefix: string): string | undefined => {
      for (const sf of subfolders) {
        const path = prefix ? `${prefix}/${sf.name}` : sf.name;
        if (sf.items.includes(name)) return path;
        const found = findInSubfolders(sf.subfolders, path);
        if (found) return found;
      }
      return undefined;
    };

    return findInSubfolders(container.subfolders, '');
  }

  /**
   * Ensure a plugin or behavior addon is registered in usedAddons.
   * Auto-adds known Scirra addons; blocks unknown/third-party addons.
   * Returns a warning string if the addon was auto-added, or undefined.
   */
  async ensureAddonRegistered(
    type: 'plugin' | 'behavior',
    id: string,
  ): Promise<string | undefined> {
    const addons = this.reader.getUsedAddons();
    const already = addons.some(a => a.type === type && a.id === id);
    if (already) return undefined;

    // Look up known Scirra addon
    const knownMap = type === 'plugin' ? KNOWN_SCIRRA_PLUGINS : KNOWN_SCIRRA_BEHAVIORS;
    const displayName = knownMap[id];

    if (!displayName) {
      throw new Error(
        `${type === 'plugin' ? 'Plugin' : 'Behavior'} "${id}" is not registered in the project's usedAddons ` +
        `and is not a known built-in Scirra addon. Add it to the project in the Construct 3 editor first.`
      );
    }

    return this.withProjectLock(async () => {
      // Re-check under lock — another concurrent call may have registered it
      const freshAddons = this.reader.getUsedAddons();
      if (freshAddons.some(a => a.type === type && a.id === id)) return undefined;

      // Auto-register the addon in c3proj
      const projectPath = this.reader.getProjectPath();
      await this.createBackup(projectPath);

      const content = await readFile(projectPath, 'utf-8');
      const project = parseJsonText(content);

      const newAddon: Addon = {
        type,
        id,
        name: displayName,
        author: 'Scirra',
        bundled: false,
      };
      project.usedAddons.push(newAddon);

      await this.writeProjectFile(projectPath, project, content);
      await this.reader.reloadProject();

      return `Auto-registered ${type} "${id}" in usedAddons (was not previously in the project).`;
    });
  }

  /**
   * Write a single placeholder PNG image file to the images/ directory.
   *
   * @param objectName    Object type name
   * @param animationName Animation name (for Sprites)
   * @param frameIndex    Frame index (0-based)
   * @param pluginId      Plugin ID (e.g. 'Sprite', 'TiledBg')
   * @param width         Image width in pixels (default: 1)
   * @param height        Image height in pixels (default: 1)
   * @returns The written file path
   */
  async writeImageFile(
    objectName: string,
    animationName: string,
    frameIndex: number,
    pluginId?: string,
    width = 1,
    height = 1,
  ): Promise<string> {
    const fileName = getImageFileName(objectName, animationName, frameIndex, pluginId);
    // Directly in images/: a name with a path separator is refused
    const filePath = this.imageFilePath(fileName);

    await mkdir(dirname(filePath), { recursive: true });

    const png = generatePlaceholderPng(width, height);
    await writeFile(filePath, png);

    return filePath;
  }

  /**
   * Write multiple image files atomically — if any fails, clean up the ones already written.
   *
   * @param files Array of image file descriptors
   * @returns Array of written file paths
   */
  async writeImageFiles(
    files: Array<{
      objectName: string;
      animationName: string;
      frameIndex: number;
      pluginId?: string;
      width?: number;
      height?: number;
    }>,
  ): Promise<string[]> {
    const writtenPaths: string[] = [];

    try {
      for (const file of files) {
        const path = await this.writeImageFile(
          file.objectName,
          file.animationName,
          file.frameIndex,
          file.pluginId,
          file.width,
          file.height,
        );
        writtenPaths.push(path);
      }
      return writtenPaths;
    } catch (error) {
      // Rollback: remove any images we already wrote
      for (const path of writtenPaths) {
        try {
          await unlink(path);
        } catch {
          // Best-effort cleanup — orphaned PNGs are harmless
        }
      }
      throw error;
    }
  }

  /** Names of the entries in the project's images/ folder (none when there is no such folder). */
  async listImageFiles(): Promise<string[]> {
    try {
      return await readdir(resolveProjectPath(this.reader.getProjectDir(), 'images'));
    } catch (e: unknown) {
      if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') return [];
      throw e;
    }
  }

  /**
   * Rename files in images/ (`from` and `to` are names in that folder), in
   * order and all or nothing: when a rename fails, the files renamed before
   * it are renamed back, last first, and the call throws. Nothing is renamed
   * when a `to` is taken by another file at the point its rename runs, also
   * one whose name differs only in case (on Windows and macOS that is the
   * same file); a name an earlier rename of the list moved away is free, so
   * files can move along a chain (002 → 003, then 001 → 002). `to` may differ
   * from `from` only in case. To undo a call, rename each `to` back to its
   * `from` in reverse order.
   */
  async renameImageFiles(renames: ReadonlyArray<{ from: string; to: string }>): Promise<void> {
    const moves = renames.map(r => ({ ...r, fromPath: this.imageFilePath(r.from), toPath: this.imageFilePath(r.to) }));
    const existing = moves.length > 0 ? await this.listImageFiles() : [];
    const [clash] = simulateImageRenames(existing, moves).clashes;
    if (clash !== undefined) {
      throw new Error(clash.renamedThere
        ? `Cannot rename two files to images/${clash.to}. No image file was renamed.`
        : `Cannot rename images/${clash.from} to images/${clash.to}: images/${clash.occupant} already exists. No image file was renamed.`);
    }

    const done: typeof moves = [];
    try {
      for (const move of moves) {
        await rename(move.fromPath, move.toPath);
        done.push(move);
      }
    } catch (error) {
      const notRestored: string[] = [];
      for (const move of done.reverse()) {
        try {
          await rename(move.toPath, move.fromPath);
        } catch {
          notRestored.push(`images/${move.to} (was images/${move.from})`);
        }
      }
      const cause = error instanceof Error ? error.message : String(error);
      throw new Error(notRestored.length === 0
        ? `Renaming image files failed: ${cause}. The files renamed before were renamed back.`
        : `Renaming image files failed: ${cause}. These files could not be renamed back: ${notRestored.join(', ')}.`);
    }
  }

  /**
   * Put an entity file back to its content before a writeEntityFile call,
   * copied from the backup path that call returned (or that its
   * EntityWriteError carries). Rolls back one file of a change that spans
   * several files. A file that already holds that content is left as it is.
   */
  async restoreEntityFile(backupPath: string): Promise<void> {
    if (!backupPath.endsWith('.json.bak')) {
      throw new Error(`Not a backup of an entity file: ${backupPath}`);
    }
    const filePath = resolveProjectPath(this.reader.getProjectDir(), backupPath.slice(0, -'.bak'.length));
    const content = await readFile(backupPath);
    let current: Buffer | undefined;
    try {
      current = await readFile(filePath);
    } catch {
      // Missing or unreadable: write it
    }
    if (current === undefined || !current.equals(content)) {
      await this.atomicWrite(filePath, content);
    }
    this.invalidateAll();
  }

  /** Path of a file directly in images/; refuses names that would point elsewhere. */
  private imageFilePath(name: string): string {
    if (name === '' || name === '.' || name === '..' || /[\\/]/.test(name)) {
      throw new Error(`Invalid image file name "${name}"`);
    }
    return resolveProjectPath(this.reader.getProjectDir(), 'images', name);
  }

  /**
   * Invalidate all caches (reader + project index + id generator).
   */
  private invalidateAll(): void {
    this.reader.invalidateCaches();
    resetProjectIndex();
    this.idGen.reset();
  }

  /**
   * Find or create a nested subfolder path in a container.
   */
  private findOrCreateSubfolder(
    container: { items: string[]; subfolders: Subfolder[] },
    path: string,
  ): { items: string[]; subfolders: Subfolder[] } {
    const parts = path.split('/');
    let current: { items: string[]; subfolders: Subfolder[] } = container;

    for (const part of parts) {
      let found = current.subfolders.find(sf => sf.name === part);
      if (!found) {
        found = newProjectFolder(part);
        current.subfolders.push(found);
      }
      current = found;
    }

    return current;
  }

  /**
   * Recursively remove a name from subfolder items.
   */
  private removeFromSubfolders(subfolders: Subfolder[], name: string): boolean {
    for (const sf of subfolders) {
      const idx = sf.items.indexOf(name);
      if (idx !== -1) {
        sf.items.splice(idx, 1);
        return true;
      }
      if (this.removeFromSubfolders(sf.subfolders, name)) {
        return true;
      }
    }
    return false;
  }
}
