/**
 * Safe write operations for Construct 3 projects.
 * Safety model: backup → validate → write → verify → invalidate caches.
 */

import { readFile, writeFile, copyFile, unlink, mkdir, stat } from 'fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'path';
import type { Construct3ProjectReader } from './project-reader.js';
import type { IdGenerator } from './id-generator.js';
import type { Addon, Subfolder } from './types.js';
import { resetProjectIndex } from './analyzers/index-builder.js';
import { KNOWN_SCIRRA_PLUGINS, KNOWN_SCIRRA_BEHAVIORS } from './templates.js';

/** Maximum entity file size we'll write (5MB — well above any real C3 entity) */
const MAX_WRITE_SIZE = 5 * 1024 * 1024;

export class Construct3ProjectWriter {
  constructor(
    private reader: Construct3ProjectReader,
    private idGen: IdGenerator,
  ) {}

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
      await stat(filePath); // Verify file exists before copying
      await copyFile(filePath, backupPath);
    } catch {
      // File may not exist yet (new entity) — no backup needed
    }
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
    await unlink(filePath);

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
  }

  /**
   * Remove a name from a c3proj container.
   */
  async removeFromProject(
    category: 'objectTypes' | 'eventSheets' | 'layouts' | 'families',
    name: string,
  ): Promise<void> {
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
  }

  /**
   * Update the project.c3proj properties (metadata).
   */
  async updateProjectProperties(updates: Record<string, unknown>): Promise<string> {
    const projectPath = this.reader.getProjectPath();
    const backupPath = await this.createBackup(projectPath);

    const content = await readFile(projectPath, 'utf-8');
    const project = JSON.parse(content);

    // Apply updates to top-level and properties
    const topLevelKeys = ['name'];
    for (const [key, value] of Object.entries(updates)) {
      if (topLevelKeys.includes(key)) {
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
