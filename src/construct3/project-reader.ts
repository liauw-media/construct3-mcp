/**
 * Utilities for reading and parsing Construct 3 project files
 */

import { readFile, readdir, stat } from 'fs/promises';
import { join, dirname, resolve, relative, isAbsolute } from 'path';
import type {
  Construct3Project,
  EventSheet,
  ObjectType,
  Layout,
  Subfolder,
} from './types.js';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export class Construct3ProjectReader {
  private projectPath: string;
  private projectData: Construct3Project | null = null;

  // Name→subfolder-path maps built at load time
  private objectPathMap: Map<string, string> = new Map();
  private eventSheetPathMap: Map<string, string> = new Map();
  private layoutPathMap: Map<string, string> = new Map();
  private familyPathMap: Map<string, string> = new Map();

  // Caches for bulk reads
  private eventSheetCache: Map<string, EventSheet> | null = null;
  private objectTypeCache: Map<string, ObjectType> | null = null;
  private layoutCache: Map<string, Layout> | null = null;
  private familyCache: Map<string, Record<string, unknown>> | null = null;

  constructor(projectPath: string) {
    this.projectPath = projectPath;
  }

  /**
   * Resolve a path confined within the project directory.
   * Rejects path traversal attempts.
   */
  private resolveProjectPath(...segments: string[]): string {
    const projectDir = this.getProjectDir();
    const resolved = resolve(projectDir, ...segments);
    const rel = relative(projectDir, resolved);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error('Path traversal detected: path escapes project directory');
    }
    return resolved;
  }

  /**
   * Read a file safely within project bounds, with size check.
   */
  private async readProjectFile(filePath: string): Promise<string> {
    const stats = await stat(filePath);
    if (stats.size > MAX_FILE_SIZE) {
      throw new Error(`File too large (${(stats.size / 1024 / 1024).toFixed(1)}MB exceeds 10MB limit)`);
    }
    return readFile(filePath, 'utf-8');
  }

  /**
   * Build name→path maps from the project file's subfolder trees.
   * Items at root level get empty string prefix; items in subfolders get "subfolder/" prefix.
   */
  private buildPathMaps(): void {
    const project = this.getProject();

    this.objectPathMap = this.buildPathMapFromContainer(project.objectTypes);
    this.eventSheetPathMap = this.buildPathMapFromContainer(project.eventSheets);
    this.layoutPathMap = this.buildPathMapFromContainer(project.layouts);
    this.familyPathMap = this.buildPathMapFromContainer(project.families);
  }

  private buildPathMapFromContainer(container: { items: string[]; subfolders: Subfolder[] }): Map<string, string> {
    const map = new Map<string, string>();

    // Root items have no subfolder prefix
    for (const item of container.items) {
      map.set(item, '');
    }

    // Recursively walk subfolders
    const walkSubfolders = (subfolders: Subfolder[], prefix: string) => {
      for (const subfolder of subfolders) {
        const folderPath = prefix ? `${prefix}/${subfolder.name}` : subfolder.name;
        for (const item of subfolder.items) {
          map.set(item, folderPath);
        }
        walkSubfolders(subfolder.subfolders, folderPath);
      }
    };

    walkSubfolders(container.subfolders, '');
    return map;
  }

  /**
   * Load and parse the main project file
   */
  async loadProject(): Promise<Construct3Project> {
    try {
      const projectFile = await readFile(this.projectPath, 'utf-8');
      this.projectData = JSON.parse(projectFile) as Construct3Project;
      this.buildPathMaps();
      return this.projectData;
    } catch (error) {
      throw new Error(
        `Failed to load Construct3 project: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get the loaded project data
   */
  getProject(): Construct3Project {
    if (!this.projectData) {
      throw new Error('Project not loaded. Call loadProject() first.');
    }
    return this.projectData;
  }

  /**
   * Get project directory path
   */
  getProjectDir(): string {
    return dirname(this.projectPath);
  }

  /**
   * Read an event sheet file
   */
  async readEventSheet(name: string): Promise<EventSheet> {
    const subPath = this.eventSheetPathMap.get(name);
    const segments = subPath
      ? ['eventSheets', subPath, `${name}.json`]
      : ['eventSheets', `${name}.json`];
    const eventSheetPath = this.resolveProjectPath(...segments);
    try {
      const content = await this.readProjectFile(eventSheetPath);
      return JSON.parse(content) as EventSheet;
    } catch (error) {
      if (error instanceof Error && error.message.includes('Path traversal')) throw error;
      throw new Error(
        `Failed to read event sheet "${name}": ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Read an object type file
   */
  async readObjectType(name: string): Promise<ObjectType> {
    const subPath = this.objectPathMap.get(name);
    const segments = subPath
      ? ['objectTypes', subPath, `${name}.json`]
      : ['objectTypes', `${name}.json`];
    const objectPath = this.resolveProjectPath(...segments);
    try {
      const content = await this.readProjectFile(objectPath);
      return JSON.parse(content) as ObjectType;
    } catch (error) {
      if (error instanceof Error && error.message.includes('Path traversal')) throw error;
      throw new Error(
        `Failed to read object type "${name}": ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Read a layout file
   */
  async readLayout(name: string): Promise<Layout> {
    const subPath = this.layoutPathMap.get(name);
    const segments = subPath
      ? ['layouts', subPath, `${name}.json`]
      : ['layouts', `${name}.json`];
    const layoutPath = this.resolveProjectPath(...segments);
    try {
      const content = await this.readProjectFile(layoutPath);
      return JSON.parse(content) as Layout;
    } catch (error) {
      if (error instanceof Error && error.message.includes('Path traversal')) throw error;
      throw new Error(
        `Failed to read layout "${name}": ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Read a family file
   */
  async readFamily(name: string): Promise<Record<string, unknown>> {
    const subPath = this.familyPathMap.get(name);
    const segments = subPath
      ? ['families', subPath, `${name}.json`]
      : ['families', `${name}.json`];
    const familyPath = this.resolveProjectPath(...segments);
    try {
      const content = await this.readProjectFile(familyPath);
      return JSON.parse(content) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof Error && error.message.includes('Path traversal')) throw error;
      throw new Error(
        `Failed to read family "${name}": ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * List all event sheets (from all subfolders)
   */
  async listEventSheets(): Promise<string[]> {
    return Array.from(this.eventSheetPathMap.keys());
  }

  /**
   * List all object types (from all subfolders)
   */
  async listObjectTypes(): Promise<string[]> {
    return Array.from(this.objectPathMap.keys());
  }

  /**
   * List all layouts (from all subfolders)
   */
  async listLayouts(): Promise<string[]> {
    return Array.from(this.layoutPathMap.keys());
  }

  /**
   * List all families (from all subfolders)
   */
  async listFamilies(): Promise<string[]> {
    return Array.from(this.familyPathMap.keys());
  }

  /**
   * Bulk read all event sheets with caching
   */
  async readAllEventSheets(): Promise<Map<string, EventSheet>> {
    if (this.eventSheetCache) return this.eventSheetCache;
    const names = await this.listEventSheets();
    const map = new Map<string, EventSheet>();
    for (const name of names) {
      try {
        map.set(name, await this.readEventSheet(name));
      } catch {
        // Skip unreadable sheets
      }
    }
    this.eventSheetCache = map;
    return map;
  }

  /**
   * Bulk read all object types with caching
   */
  async readAllObjectTypes(): Promise<Map<string, ObjectType>> {
    if (this.objectTypeCache) return this.objectTypeCache;
    const names = await this.listObjectTypes();
    const map = new Map<string, ObjectType>();
    for (const name of names) {
      try {
        map.set(name, await this.readObjectType(name));
      } catch {
        // Skip unreadable objects
      }
    }
    this.objectTypeCache = map;
    return map;
  }

  /**
   * Bulk read all layouts with caching
   */
  async readAllLayouts(): Promise<Map<string, Layout>> {
    if (this.layoutCache) return this.layoutCache;
    const names = await this.listLayouts();
    const map = new Map<string, Layout>();
    for (const name of names) {
      try {
        map.set(name, await this.readLayout(name));
      } catch {
        // Skip unreadable layouts
      }
    }
    this.layoutCache = map;
    return map;
  }

  /**
   * Bulk read all families with caching
   */
  async readAllFamilies(): Promise<Map<string, Record<string, unknown>>> {
    if (this.familyCache) return this.familyCache;
    const names = await this.listFamilies();
    const map = new Map<string, Record<string, unknown>>();
    for (const name of names) {
      try {
        map.set(name, await this.readFamily(name));
      } catch {
        // Skip unreadable families
      }
    }
    this.familyCache = map;
    return map;
  }

  /**
   * Invalidate all caches so subsequent reads pick up fresh data.
   * Must be called after any write operation.
   */
  invalidateCaches(): void {
    this.eventSheetCache = null;
    this.objectTypeCache = null;
    this.layoutCache = null;
    this.familyCache = null;
  }

  /**
   * Reload the project file from disk and rebuild path maps.
   * Call after modifying project.c3proj.
   */
  async reloadProject(): Promise<void> {
    await this.loadProject();
    this.invalidateCaches();
  }

  /**
   * Get the project file path
   */
  getProjectPath(): string {
    return this.projectPath;
  }

  /**
   * Get project metadata
   */
  getMetadata() {
    const project = this.getProject();
    return {
      name: project.name,
      version: project.properties.version,
      author: project.properties.author,
      description: project.properties.description,
      runtime: project.runtime,
      viewportWidth: project.viewportWidth,
      viewportHeight: project.viewportHeight,
      firstLayout: project.firstLayout,
    };
  }

  /**
   * Get all used addons (plugins and behaviors)
   */
  getUsedAddons() {
    const project = this.getProject();
    return project.usedAddons;
  }

  /**
   * Search for objects by name pattern
   */
  searchObjects(pattern: string): string[] {
    const lowerPattern = pattern.toLowerCase();
    const allNames = Array.from(this.objectPathMap.keys());
    return allNames.filter((obj) =>
      obj.toLowerCase().includes(lowerPattern)
    );
  }

  /**
   * Find nearest matching name for suggestions
   */
  findNearestName(name: string, category: 'objects' | 'eventsheets' | 'layouts'): string[] {
    const lowerName = name.toLowerCase();
    let allNames: string[];
    switch (category) {
      case 'objects':
        allNames = Array.from(this.objectPathMap.keys());
        break;
      case 'eventsheets':
        allNames = Array.from(this.eventSheetPathMap.keys());
        break;
      case 'layouts':
        allNames = Array.from(this.layoutPathMap.keys());
        break;
    }
    return allNames
      .filter((n) => n.toLowerCase().includes(lowerName) || lowerName.includes(n.toLowerCase()))
      .slice(0, 5);
  }

  /**
   * Check if project file exists and is valid
   */
  static async isValidProject(projectPath: string): Promise<boolean> {
    try {
      const stats = await stat(projectPath);
      if (!stats.isFile() || !projectPath.endsWith('.c3proj')) {
        return false;
      }
      const content = await readFile(projectPath, 'utf-8');
      const data = JSON.parse(content);
      return (
        typeof data === 'object' &&
        data !== null &&
        'projectFormatVersion' in data &&
        'name' in data
      );
    } catch {
      return false;
    }
  }

  /**
   * Find project file in a directory
   */
  static async findProjectFile(directory: string): Promise<string | null> {
    try {
      const files = await readdir(directory);
      const c3projFile = files.find((file) => file.endsWith('.c3proj'));
      return c3projFile ? join(directory, c3projFile) : null;
    } catch {
      return null;
    }
  }
}
