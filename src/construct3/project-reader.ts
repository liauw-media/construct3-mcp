/**
 * Utilities for reading and parsing Construct 3 project files
 */

import { readFile, readdir, stat } from 'fs/promises';
import { join, dirname } from 'path';
import type {
  Construct3Project,
  EventSheet,
  ObjectType,
  Layout,
  Subfolder,
} from './types.js';
import { resolveProjectPath } from './path-utils.js';
import { parseJsonText, stripBom } from './json-format.js';
import { searchFileText, type RawTextTerm } from './raw-text-search.js';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
/** Limits for listing flowcharts/ and timelines/ */
const MAX_DATA_FOLDER_DEPTH = 20;
const MAX_DATA_FILES = 5000;

/**
 * Name → project-bar folder path for one project.c3proj container: "" for
 * root items, "A/B" for items in folder A > B. Construct 3 mirrors these
 * folders on disk, and the reader loads <category>/<folder path>/<name>.json.
 * A name listed twice keeps its last position.
 */
export function entityFolderPaths(container: { items: string[]; subfolders: Subfolder[] }): Map<string, string> {
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

/** Project-relative path of a registered entity's file, e.g. "layouts/Menus/Title.json". */
export function entityFilePath(category: string, folderPath: string, name: string): string {
  return folderPath ? `${category}/${folderPath}/${name}.json` : `${category}/${name}.json`;
}

export type EntityCategory = 'objectTypes' | 'eventSheets' | 'layouts' | 'families';

// ─── Read-failure typing ─────────────────────────────────────

/**
 * Why a bulk read skipped an entity file. Consumers branch on these codes,
 * never on message text.
 */
export type ReadFailureCode =
  | 'E_FILE_TOO_LARGE'   // exists but exceeds MAX_FILE_SIZE; contents were NOT scanned
  | 'E_FILE_NOT_FOUND'   // ENOENT on stat/read; the file provably holds no data
  | 'E_INVALID_JSON'     // read fine, JSON.parse threw
  | 'E_READ_ERROR';      // anything else (EACCES, EISDIR, ...)

export interface ReadFailure {
  code: ReadFailureCode;
  message: string;
}

/**
 * Thrown by the per-entity readers. Carries a stable code so callers never
 * have to parse the message to learn what went wrong.
 */
export class ProjectReadError extends Error {
  readonly code: ReadFailureCode;

  constructor(code: ReadFailureCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProjectReadError';
    this.code = code;
  }
}

/** True for a Node fs error with code ENOENT (libuv reports this on Windows too). */
export function isFileNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}

/** Classify a raw error from stat/readFile/JSON.parse into a ReadFailureCode. */
export function classifyReadError(error: unknown): ReadFailureCode {
  if (error instanceof ProjectReadError) return error.code;
  if (isFileNotFoundError(error)) return 'E_FILE_NOT_FOUND';
  if (error instanceof SyntaxError) return 'E_INVALID_JSON';
  return 'E_READ_ERROR';
}

/** The record a bulk read keeps for an entity it skipped. */
function toReadFailure(error: unknown): ReadFailure {
  return {
    code: classifyReadError(error),
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Regex-scan raw JSON text for "uid"/"sid" values without parsing it.
 * Over-approximation (a value inside a string literal) is harmless for
 * high-water and collision purposes. The UIDs hierarchy links name count too
 * ("parent-uid", and "uid" of a children entry), as for parsed layouts.
 * Exported so the test mock shares this exact implementation instead of
 * re-implementing it.
 */
export function scanIdsInText(content: string): { highestUid: number; sids: number[] } {
  let highestUid = 0;
  for (const match of content.matchAll(/"(?:parent-)?uid"\s*:\s*(\d+)/g)) {
    const uid = Number(match[1]);
    if (uid > highestUid) highestUid = uid;
  }
  const sids: number[] = [];
  for (const match of content.matchAll(/"sid"\s*:\s*(\d+)/g)) {
    sids.push(Number(match[1]));
  }
  return { highestUid, sids };
}

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

  // Entities the bulk readers could not read/parse (e.g. over the size cap),
  // keyed by category → name → typed failure. Each bulk read collects its own
  // and stores them with its cached map at the end, so a reload in the middle
  // of a read (invalidateCaches) cannot leave a cached map without them.
  private readFailures: Map<EntityCategory, Map<string, ReadFailure>> = new Map();

  constructor(projectPath: string) {
    this.projectPath = projectPath;
  }

  /**
   * Read a file safely within project bounds, with size check.
   * A leading BOM is dropped so the text can go straight to JSON.parse.
   */
  private async readProjectFile(filePath: string): Promise<string> {
    const stats = await stat(filePath);
    if (stats.size > MAX_FILE_SIZE) {
      throw new ProjectReadError(
        'E_FILE_TOO_LARGE',
        `File too large (${(stats.size / 1024 / 1024).toFixed(1)}MB exceeds 10MB limit)`
      );
    }
    return stripBom(await readFile(filePath, 'utf-8'));
  }

  /**
   * Build name→path maps from the project file's subfolder trees.
   * Items at root level get empty string prefix; items in subfolders get "subfolder/" prefix.
   */
  private buildPathMaps(): void {
    const project = this.getProject();

    this.objectPathMap = entityFolderPaths(project.objectTypes);
    this.eventSheetPathMap = entityFolderPaths(project.eventSheets);
    this.layoutPathMap = entityFolderPaths(project.layouts);
    this.familyPathMap = entityFolderPaths(project.families);
  }

  /**
   * Load and parse the main project file
   */
  async loadProject(): Promise<Construct3Project> {
    try {
      const projectFile = await readFile(this.projectPath, 'utf-8');
      this.projectData = parseJsonText(projectFile) as Construct3Project;
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

  private pathMapFor(category: EntityCategory): Map<string, string> {
    switch (category) {
      case 'objectTypes': return this.objectPathMap;
      case 'eventSheets': return this.eventSheetPathMap;
      case 'layouts': return this.layoutPathMap;
      case 'families': return this.familyPathMap;
    }
  }

  /**
   * Resolve <projectDir>/<category>/[subfolder/]<name>.json through the
   * c3proj path maps. The parsed readers and the raw scan share this, so
   * they cannot disagree about where an entity lives.
   */
  private resolveEntityPath(category: EntityCategory, name: string): string {
    const subPath = this.pathMapFor(category).get(name);
    const segments = subPath
      ? [category, subPath, `${name}.json`]
      : [category, `${name}.json`];
    return resolveProjectPath(this.getProjectDir(), ...segments);
  }

  /**
   * The project-relative path this reader resolves for an entity
   * (`<category>/[subfolder/]<name>.json`), for messages that must not
   * carry the absolute project path.
   */
  getEntityRelativePath(category: EntityCategory, name: string): string {
    return entityFilePath(category, this.pathMapFor(category).get(name) ?? '', name);
  }

  /**
   * Read an event sheet file
   */
  async readEventSheet(name: string): Promise<EventSheet> {
    const eventSheetPath = this.resolveEntityPath('eventSheets', name);
    try {
      const content = await this.readProjectFile(eventSheetPath);
      return JSON.parse(content) as EventSheet;
    } catch (error) {
      if (error instanceof Error && error.message.includes('Path traversal')) throw error;
      throw new ProjectReadError(
        classifyReadError(error),
        `Failed to read event sheet "${name}": ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  /**
   * Read an object type file
   */
  async readObjectType(name: string): Promise<ObjectType> {
    const objectPath = this.resolveEntityPath('objectTypes', name);
    try {
      const content = await this.readProjectFile(objectPath);
      return JSON.parse(content) as ObjectType;
    } catch (error) {
      if (error instanceof Error && error.message.includes('Path traversal')) throw error;
      throw new ProjectReadError(
        classifyReadError(error),
        `Failed to read object type "${name}": ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  /**
   * Read a layout file
   */
  async readLayout(name: string): Promise<Layout> {
    const layoutPath = this.resolveEntityPath('layouts', name);
    try {
      const content = await this.readProjectFile(layoutPath);
      return JSON.parse(content) as Layout;
    } catch (error) {
      if (error instanceof Error && error.message.includes('Path traversal')) throw error;
      throw new ProjectReadError(
        classifyReadError(error),
        `Failed to read layout "${name}": ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  /**
   * Read a family file
   */
  async readFamily(name: string): Promise<Record<string, unknown>> {
    const familyPath = this.resolveEntityPath('families', name);
    try {
      const content = await this.readProjectFile(familyPath);
      return JSON.parse(content) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof Error && error.message.includes('Path traversal')) throw error;
      throw new ProjectReadError(
        classifyReadError(error),
        `Failed to read family "${name}": ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  /**
   * Read a project script file as text.
   * @param relativePath  Path inside the project's scripts/ folder, e.g. "importsForEvents.js" or "base/utils.ts"
   */
  async readScriptFile(relativePath: string): Promise<string> {
    const scriptsDir = resolveProjectPath(this.getProjectDir(), 'scripts');
    const scriptPath = resolveProjectPath(scriptsDir, ...relativePath.split('/'));
    try {
      return await this.readProjectFile(scriptPath);
    } catch (error) {
      if (error instanceof Error && error.message.includes('Path traversal')) throw error;
      throw new Error(
        `Failed to read script "${relativePath}": ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Read a project file (rootFileFolders.general, saved in the project's
   * files/ folder) as text.
   * @param relativePath  Path inside files/, e.g. "data.json" or "sub/page.html"
   */
  async readProjectFileText(relativePath: string): Promise<string> {
    const filesDir = resolveProjectPath(this.getProjectDir(), 'files');
    const filePath = resolveProjectPath(filesDir, ...relativePath.split('/'));
    try {
      return await this.readProjectFile(filePath);
    } catch (error) {
      if (error instanceof Error && error.message.includes('Path traversal')) throw error;
      throw new Error(
        `Failed to read project file "${relativePath}": ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * List the JSON files below the project's flowcharts/ or timelines/ folder
   * (subfolders included, editor UI state files "*.uistate.json" excluded).
   * A missing folder lists nothing.
   * @returns Paths relative to the folder, e.g. "Flow 1.json" or "sub/Intro.json"
   */
  async listDataFiles(folder: 'flowcharts' | 'timelines'): Promise<string[]> {
    const root = resolveProjectPath(this.getProjectDir(), folder);
    const out: string[] = [];
    const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
      if (depth > MAX_DATA_FOLDER_DEPTH || out.length >= MAX_DATA_FILES) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          await walk(join(dir, entry.name), `${prefix}${entry.name}/`, depth + 1);
        } else if (entry.isFile() && entry.name.endsWith('.json') && !entry.name.endsWith('.uistate.json')) {
          if (out.length < MAX_DATA_FILES) out.push(prefix + entry.name);
        }
      }
    };
    await walk(root, '', 0);
    return out.sort();
  }

  /**
   * Read a file listed by listDataFiles as text.
   * @param relativePath  Path inside the folder, e.g. "Flow 1.json"
   */
  async readDataFileText(folder: 'flowcharts' | 'timelines', relativePath: string): Promise<string> {
    const root = resolveProjectPath(this.getProjectDir(), folder);
    const filePath = resolveProjectPath(root, ...relativePath.split('/'));
    try {
      return await this.readProjectFile(filePath);
    } catch (error) {
      throw new Error(
        `Failed to read ${folder} file "${relativePath}": ${error instanceof Error ? error.message : String(error)}`
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
    const failures = new Map<string, ReadFailure>();
    for (const name of names) {
      try {
        map.set(name, await this.readEventSheet(name));
      } catch (error) {
        // Skip unreadable sheets, but record why so callers can report/recover
        failures.set(name, toReadFailure(error));
      }
    }
    this.eventSheetCache = map;
    this.readFailures.set('eventSheets', failures);
    return map;
  }

  /**
   * Bulk read all object types with caching
   */
  async readAllObjectTypes(): Promise<Map<string, ObjectType>> {
    if (this.objectTypeCache) return this.objectTypeCache;
    const names = await this.listObjectTypes();
    const map = new Map<string, ObjectType>();
    const failures = new Map<string, ReadFailure>();
    for (const name of names) {
      try {
        map.set(name, await this.readObjectType(name));
      } catch (error) {
        // Skip unreadable objects, but record why so callers can report/recover
        failures.set(name, toReadFailure(error));
      }
    }
    this.objectTypeCache = map;
    this.readFailures.set('objectTypes', failures);
    return map;
  }

  /**
   * Bulk read all layouts with caching
   */
  async readAllLayouts(): Promise<Map<string, Layout>> {
    if (this.layoutCache) return this.layoutCache;
    const names = await this.listLayouts();
    const map = new Map<string, Layout>();
    const failures = new Map<string, ReadFailure>();
    for (const name of names) {
      try {
        map.set(name, await this.readLayout(name));
      } catch (error) {
        // Skip unreadable layouts, but record why so callers can report/recover
        failures.set(name, toReadFailure(error));
      }
    }
    this.layoutCache = map;
    this.readFailures.set('layouts', failures);
    return map;
  }

  /**
   * Bulk read all families with caching
   */
  async readAllFamilies(): Promise<Map<string, Record<string, unknown>>> {
    if (this.familyCache) return this.familyCache;
    const names = await this.listFamilies();
    const map = new Map<string, Record<string, unknown>>();
    const failures = new Map<string, ReadFailure>();
    for (const name of names) {
      try {
        map.set(name, await this.readFamily(name));
      } catch (error) {
        // Skip unreadable families, but record why so callers can report/recover
        failures.set(name, toReadFailure(error));
      }
    }
    this.familyCache = map;
    this.readFailures.set('families', failures);
    return map;
  }

  /**
   * Entities the cached bulk read of a category could not read/parse
   * (name → typed failure with a stable code and the original message).
   * Empty until the category's readAll* has run, and again after
   * invalidateCaches(). A bulk read stores its failures together with its
   * result, so they always describe the cached map; take them right after
   * awaiting readAll*, before a concurrent reload can clear both.
   */
  getReadFailures(category: EntityCategory): Map<string, ReadFailure> {
    return this.readFailures.get(category) ?? new Map();
  }

  /**
   * Raw ID scan of an entity file that bypasses the size cap and JSON parsing.
   * Used to recover the UID high-water mark (and SIDs) from files the normal
   * reader refuses (over 10MB) or cannot parse: layout instances and
   * objectTypes' singleglobal-inst carry UIDs. Recovers uid/sid only;
   * imageSpriteIds are not recovered (random 7-digit, collision-negligible).
   * fs errors propagate unwrapped so callers can test `.code` (ENOENT means
   * there is nothing to recover).
   */
  async scanEntityIdsRaw(category: EntityCategory, name: string): Promise<{ highestUid: number; sids: number[] }> {
    const content = await readFile(this.resolveEntityPath(category, name), 'utf-8');
    return scanIdsInText(content);
  }

  /**
   * Text search of an entity file for names or patterns (raw-text-search.ts),
   * bypassing the size cap and JSON parsing: for the files the bulk reads
   * skipped, whose uses the reference checks cannot see otherwise (#55). The
   * file is streamed, so memory use does not grow with its size, through the
   * same path map and resolveProjectPath() check as the parsed readers.
   * Returns the keys of the terms found. fs errors propagate unwrapped, so
   * callers can test `.code` (ENOENT: no file, so no uses in it).
   */
  async searchEntityTextRaw(category: EntityCategory, name: string, terms: readonly RawTextTerm[]): Promise<Set<string>> {
    return searchFileText(this.resolveEntityPath(category, name), terms);
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
    this.readFailures.clear();
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
      const data = parseJsonText(content);
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
