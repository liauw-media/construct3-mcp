/**
 * Safe write operations for Construct 3 projects.
 * Safety model: backup → validate → write → verify → invalidate caches.
 */

import { readFile, writeFile, copyFile, unlink, mkdir, stat } from 'fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'path';
import type { Construct3ProjectReader } from './project-reader.js';
import type { IdGenerator } from './id-generator.js';
import type { Addon, Subfolder, ProjectProperties } from './types.js';
import { resetProjectIndex } from './analyzers/index-builder.js';
import { KNOWN_SCIRRA_PLUGINS, KNOWN_SCIRRA_BEHAVIORS } from './templates.js';
import { generatePlaceholderPng, getImageFileName } from './png-generator.js';

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
   * Resolve a path confined within the project directory.
   * Rejects path traversal attempts.
   */
  private resolveProjectPath(...segments: string[]): string {
    const projectDir = this.reader.getProjectDir();
    const resolved = resolve(projectDir, ...segments);
    const rel = relative(projectDir, resolved);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error('Path traversal detected: path escapes project directory');
    }
    return resolved;
  }

  /**
   * Create a .bak backup of a file before overwriting.
   * Returns the backup path (even if the original didn't exist).
   */
  private async createBackup(filePath: string): Promise<string> {
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
   * Post-write verification — read the file back and verify it parses.
   */
  private async verifyWrittenFile(filePath: string, entityName: string): Promise<void> {
    try {
      const content = await readFile(filePath, 'utf-8');
      JSON.parse(content);
    } catch (e) {
      throw new Error(`Post-write verification failed for "${entityName}": file may be corrupted. A .bak backup exists. Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Write an entity JSON file (object, event sheet, layout, family).
   */
  async writeEntityFile(
    category: 'objectTypes' | 'eventSheets' | 'layouts' | 'families',
    name: string,
    data: unknown,
    subfolder?: string,
  ): Promise<string> {
    // Pre-write validation
    const json = this.validateJsonData(data, name);

    const segments = subfolder
      ? [category, subfolder, `${name}.json`]
      : [category, `${name}.json`];
    const filePath = this.resolveProjectPath(...segments);

    // Ensure directory exists
    await mkdir(dirname(filePath), { recursive: true });

    const backupPath = await this.createBackup(filePath);
    await writeFile(filePath, json, 'utf-8');

    // Post-write verification
    await this.verifyWrittenFile(filePath, name);

    this.invalidateAll();
    return backupPath;
  }

  /**
   * Delete an entity JSON file.
   */
  async deleteEntityFile(
    category: 'objectTypes' | 'eventSheets' | 'layouts' | 'families',
    name: string,
    subfolder?: string,
  ): Promise<string> {
    const segments = subfolder
      ? [category, subfolder, `${name}.json`]
      : [category, `${name}.json`];
    const filePath = this.resolveProjectPath(...segments);

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
    category: 'objectTypes' | 'eventSheets' | 'layouts' | 'families',
    name: string,
    subfolder?: string,
  ): Promise<void> {
    return this.withProjectLock(async () => {
      const projectPath = this.reader.getProjectPath();
      await this.createBackup(projectPath);

      const content = await readFile(projectPath, 'utf-8');
      const project = JSON.parse(content);
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

      const json = this.validateJsonData(project, 'project.c3proj');
      await writeFile(projectPath, json, 'utf-8');
      await this.verifyWrittenFile(projectPath, 'project.c3proj');
      await this.reader.reloadProject();
    });
  }

  /**
   * Remove a name from a c3proj container.
   */
  async removeFromProject(
    category: 'objectTypes' | 'eventSheets' | 'layouts' | 'families',
    name: string,
  ): Promise<void> {
    return this.withProjectLock(async () => {
      const projectPath = this.reader.getProjectPath();
      await this.createBackup(projectPath);

      const content = await readFile(projectPath, 'utf-8');
      const project = JSON.parse(content);
      const container = project[category];

      // Remove from root items
      const rootIdx = container.items.indexOf(name);
      if (rootIdx !== -1) {
        container.items.splice(rootIdx, 1);
      } else {
        // Search subfolders
        this.removeFromSubfolders(container.subfolders, name);
      }

      const json = this.validateJsonData(project, 'project.c3proj');
      await writeFile(projectPath, json, 'utf-8');
      await this.verifyWrittenFile(projectPath, 'project.c3proj');
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
      const project = JSON.parse(content);

      // Apply updates to top-level and properties
      for (const [key, value] of Object.entries(updates)) {
        if (ALLOWED_TOP_LEVEL.has(key)) {
          project[key] = value;
        } else {
          project.properties[key] = value;
        }
      }

      const json = this.validateJsonData(project, 'project.c3proj');
      await writeFile(projectPath, json, 'utf-8');
      await this.verifyWrittenFile(projectPath, 'project.c3proj');
      await this.reader.reloadProject();

      return backupPath;
    });
  }

  /**
   * Get the subfolder path for an existing entity name.
   */
  getSubfolderForEntity(
    category: 'objectTypes' | 'eventSheets' | 'layouts' | 'families',
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
      const project = JSON.parse(content);

      const newAddon: Addon = {
        type,
        id,
        name: displayName,
        author: 'Scirra',
        bundled: false,
      };
      project.usedAddons.push(newAddon);

      const json = this.validateJsonData(project, 'project.c3proj');
      await writeFile(projectPath, json, 'utf-8');
      await this.verifyWrittenFile(projectPath, 'project.c3proj');
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
    const filePath = this.resolveProjectPath('images', fileName);

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
        found = { items: [], subfolders: [], name: part };
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
