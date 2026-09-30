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
import { scanFileIds, searchFileText, type RawTextTerm } from './raw-text-search.js';
import {
  currentToolCall,
  fileKey,
  noteFileRead,
  noteFileWritten,
  sameFileState,
  statFileState,
  stampOf,
  type FileState,
} from './disk-state.js';

/**
 * Scan raw JSON text for "uid"/"parent-uid"/"sid" values without parsing it (the scan
 * scanEntityIdsRaw streams a file through). Over-approximation (a value
 * inside a string literal) is harmless for high-water and collision
 * purposes. Exported so the test mock shares this exact implementation.
 */
export { scanIdsInText } from './raw-text-search.js';

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

/** How the read errors name an entity of each category. */
const ENTITY_KINDS: Record<EntityCategory, string> = {
  eventSheets: 'event sheet',
  objectTypes: 'object type',
  layouts: 'layout',
  families: 'family',
};

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

  // State on disk of the files each cached bulk read came from (fileKey → state)
  private cacheStates: Map<EntityCategory, Map<string, FileState>> = new Map();
  // Bumped by invalidateCaches(): a bulk read that started before keeps its
  // result to itself instead of caching data a newer change may have replaced
  private cacheGeneration = 0;

  // project.c3proj as last loaded; projectStale: a reload after an external change failed
  private projectState: FileState | undefined;
  private projectStale = false;
  // Files whose content the cached state (bulk caches, project index, ID
  // generator) may hold, with the state they had when first read since the
  // last external change: syncWithDisk() compares them with the disk
  private knownFiles: Map<string, { path: string; state: FileState }> = new Map();
  // The state each file was last read or written in, for the write checks
  private lastSeen: Map<string, FileState> = new Map();
  // Counts the external changes syncWithDisk() found; the project index and
  // the ID generator rebuild when it moves
  private diskEpoch = 0;
  private syncing: Promise<unknown> = Promise.resolve();

  constructor(projectPath: string) {
    this.projectPath = projectPath;
  }

  /**
   * Read a file safely within project bounds, with size check.
   * A leading BOM is dropped so the text can go straight to JSON.parse.
   * The file's state on disk is recorded (see syncWithDisk).
   */
  private async readProjectFile(filePath: string): Promise<string> {
    return (await this.readProjectFileWithState(filePath)).text;
  }

  private async readProjectFileWithState(filePath: string): Promise<{ text: string; state: FileState }> {
    let stats;
    try {
      stats = await stat(filePath);
    } catch (error) {
      if (isFileNotFoundError(error)) this.noteRead(filePath, null);
      throw error;
    }
    // Taken before the read: a change while reading makes the state older than the text, never newer
    const state = stampOf(stats);
    this.noteRead(filePath, state);
    if (stats.size > MAX_FILE_SIZE) {
      throw new ProjectReadError(
        'E_FILE_TOO_LARGE',
        `File too large (${(stats.size / 1024 / 1024).toFixed(1)}MB exceeds 10MB limit)`
      );
    }
    return { text: stripBom(await readFile(filePath, 'utf-8')), state };
  }

  /** Record the state a file was read in: for syncWithDisk, the write checks and the running tool call. */
  private noteRead(path: string, state: FileState): void {
    const key = fileKey(path);
    if (!this.knownFiles.has(key)) this.knownFiles.set(key, { path, state });
    this.lastSeen.set(key, state);
    noteFileRead(key, state);
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
      // Taken before the read, like readProjectFile
      const state = await statFileState(this.projectPath);
      const projectFile = await readFile(this.projectPath, 'utf-8');
      this.projectData = parseJsonText(projectFile) as Construct3Project;
      this.buildPathMaps();
      this.projectState = state;
      this.projectStale = false;
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
   * Read and parse an entity file, with the state it was read in. Failures
   * throw a ProjectReadError with a code ("Failed to read <kind> "<name>": …").
   */
  private async readEntityWithState(category: EntityCategory, name: string): Promise<{ data: unknown; state: FileState }> {
    const entityPath = this.resolveEntityPath(category, name);
    try {
      const { text, state } = await this.readProjectFileWithState(entityPath);
      return { data: JSON.parse(text), state };
    } catch (error) {
      if (error instanceof Error && error.message.includes('Path traversal')) throw error;
      throw new ProjectReadError(
        classifyReadError(error),
        `Failed to read ${ENTITY_KINDS[category]} "${name}": ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  /**
   * Read an event sheet file
   */
  async readEventSheet(name: string): Promise<EventSheet> {
    return (await this.readEntityWithState('eventSheets', name)).data as EventSheet;
  }

  /**
   * Read an object type file
   */
  async readObjectType(name: string): Promise<ObjectType> {
    return (await this.readEntityWithState('objectTypes', name)).data as ObjectType;
  }

  /**
   * Read a layout file
   */
  async readLayout(name: string): Promise<Layout> {
    return (await this.readEntityWithState('layouts', name)).data as Layout;
  }

  /**
   * Read a family file
   */
  async readFamily(name: string): Promise<Record<string, unknown>> {
    return (await this.readEntityWithState('families', name)).data as Record<string, unknown>;
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
    return this.readAllCached('eventSheets') as Promise<Map<string, EventSheet>>;
  }

  /**
   * Bulk read all object types with caching
   */
  async readAllObjectTypes(): Promise<Map<string, ObjectType>> {
    return this.readAllCached('objectTypes') as Promise<Map<string, ObjectType>>;
  }

  /**
   * Bulk read all layouts with caching
   */
  async readAllLayouts(): Promise<Map<string, Layout>> {
    return this.readAllCached('layouts') as Promise<Map<string, Layout>>;
  }

  /**
   * Bulk read all families with caching
   */
  async readAllFamilies(): Promise<Map<string, Record<string, unknown>>> {
    return this.readAllCached('families') as Promise<Map<string, Record<string, unknown>>>;
  }

  private bulkCache(category: EntityCategory): Map<string, unknown> | null {
    switch (category) {
      case 'eventSheets': return this.eventSheetCache;
      case 'objectTypes': return this.objectTypeCache;
      case 'layouts': return this.layoutCache;
      case 'families': return this.familyCache;
    }
  }

  private setBulkCache(category: EntityCategory, map: Map<string, unknown>): void {
    switch (category) {
      case 'eventSheets': this.eventSheetCache = map as Map<string, EventSheet>; break;
      case 'objectTypes': this.objectTypeCache = map as Map<string, ObjectType>; break;
      case 'layouts': this.layoutCache = map as Map<string, Layout>; break;
      case 'families': this.familyCache = map as Map<string, Record<string, unknown>>; break;
    }
  }

  /**
   * Every registered entity of a category, parsed; cached until the next
   * invalidateCaches(). Unreadable files are skipped and recorded with a
   * typed failure (getReadFailures). The running tool call learns the state
   * each file was read in, also when the map comes from the cache.
   */
  private async readAllCached(category: EntityCategory): Promise<Map<string, unknown>> {
    if (this.bulkCache(category)) await this.ensureCachesFresh();
    const cached = this.bulkCache(category);
    if (cached) {
      for (const [key, state] of this.cacheStates.get(category) ?? []) noteFileRead(key, state);
      return cached;
    }
    const generation = this.cacheGeneration;
    const names = Array.from(this.pathMapFor(category).keys());
    const map = new Map<string, unknown>();
    const failures = new Map<string, ReadFailure>();
    const states = new Map<string, FileState>();
    for (const name of names) {
      try {
        const { data, state } = await this.readEntityWithState(category, name);
        map.set(name, data);
        states.set(fileKey(this.resolveEntityPath(category, name)), state);
      } catch (error) {
        // Skip unreadable files, but record why so callers can report/recover
        failures.set(name, toReadFailure(error));
      }
    }
    // The failures describe this map, so the caller can take them right
    // after the read. The map is cached only when no invalidation ran
    // meanwhile: a write or an external change during the read may have
    // replaced files it holds, and the next read reads them again.
    this.readFailures.set(category, failures);
    if (generation === this.cacheGeneration) {
      this.setBulkCache(category, map);
      this.cacheStates.set(category, states);
    }
    return map;
  }

  /**
   * Entities the cached bulk read of a category could not read/parse
   * (name → typed failure with a stable code and the original message).
   * Empty until the category's readAll* has run, and again after
   * invalidateCaches(). A bulk read stores its failures when it finishes,
   * so they describe the map it returned (also one it did not cache because
   * the caches were invalidated while it ran); take them right after
   * awaiting readAll*, before a concurrent reload can clear them.
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
   * The file is streamed (scanFileIds in raw-text-search.ts), so its size is
   * not limited by the length of a string. fs errors propagate unwrapped so
   * callers can test `.code` (ENOENT means there is nothing to recover). No
   * file is rejected for its encoding: NUL characters are dropped, so UTF-16
   * without a byte order mark, UTF-16BE and a save cut short (zeros at the
   * end) are scanned too.
   */
  async scanEntityIdsRaw(category: EntityCategory, name: string): Promise<{ highestUid: number; sids: number[] }> {
    const path = this.resolveEntityPath(category, name);
    // The ID generator keeps what this finds: record the file's state like a parsed read
    this.noteRead(path, await statFileState(path));
    return scanFileIds(path);
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
    this.cacheStates.clear();
    this.cacheGeneration++;
  }

  // ─── Changes on disk (#51) ─────────────────────────────────

  /**
   * Bring the cached state up to date with the files on disk: compares
   * project.c3proj and every file the cached state may hold (read since the
   * last external change) with the state it was read in. After a change the
   * server did not make (saved in the Construct 3 editor, `git restore`,
   * another program), project.c3proj is loaded again when it changed, the
   * caches are dropped and the disk epoch moves, so the project index and
   * the ID generator rebuild on their next use. Returns whether anything
   * changed.
   *
   * Tool calls do this in two steps (the handlers registered through
   * withProjectSync): checkProjectFile() when the call starts, and the check
   * of the other files the first time the call uses cached data
   * (ensureCachesFresh). Scripts that use the reader directly call this
   * after changing files outside it.
   *
   * Only stats files, so it costs little. A change that keeps a file's size,
   * modification time and file id (coarse timestamps on some file systems)
   * is not seen.
   */
  async syncWithDisk(): Promise<boolean> {
    return this.oneAtATime(async () => {
      const changed = await this.projectFileChangedOnDisk() || await this.knownFileChangedOnDisk();
      if (changed) await this.dropStateAfterExternalChange();
      return changed;
    });
  }

  /**
   * The check at the start of a tool call: loads project.c3proj again when it
   * changed on disk (and drops all cached state). The files the caches hold
   * are checked when the call first uses them (ensureCachesFresh), so a call
   * that uses no cached data costs one stat. Throws when project.c3proj
   * changed and cannot be read.
   */
  async checkProjectFile(): Promise<boolean> {
    return this.oneAtATime(async () => {
      const changed = await this.projectFileChangedOnDisk();
      if (changed) {
        await this.dropStateAfterExternalChange();
        this.markFilesChecked();
      }
      return changed;
    });
  }

  /**
   * Before a tool call serves data from a cache (a bulk read, the project
   * index, the ID generator's scan) or writes a file it did not read: checks
   * every file the cached state holds against the disk, once per tool call,
   * and drops the cached state when one changed. Outside a tool call it does
   * nothing; call syncWithDisk() there.
   */
  async ensureCachesFresh(): Promise<void> {
    const scope = currentToolCall();
    if (!scope || scope.checked.has(this)) return;
    await this.oneAtATime(async () => {
      if (scope.checked.has(this)) return;
      if (await this.knownFileChangedOnDisk()) await this.dropStateAfterExternalChange();
      scope.checked.add(this);
    });
  }

  private markFilesChecked(): void {
    currentToolCall()?.checked.add(this);
  }

  /** Run the checks one at a time: parallel calls wait for the one before them. */
  private oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.syncing.then(fn);
    this.syncing = run.catch(() => undefined);
    return run;
  }

  private async projectFileChangedOnDisk(): Promise<boolean> {
    if (this.projectStale || this.projectState === undefined) return true;
    return !sameFileState(await statFileState(this.projectPath), this.projectState);
  }

  private async knownFileChangedOnDisk(): Promise<boolean> {
    if (this.knownFiles.size === 0) return false;
    const known = Array.from(this.knownFiles.values());
    // An unreadable state (EACCES, ...) counts as a change
    const now = await Promise.all(known.map(k => statFileState(k.path).catch(() => undefined)));
    return known.some((k, i) => now[i] === undefined || !sameFileState(now[i] as FileState, k.state));
  }

  /**
   * After a change the server did not make: forget the states read before
   * (the files are read again from here on; a tool call that read a file
   * before keeps that state in its scope), drop the caches, move the disk
   * epoch and load project.c3proj again.
   */
  private async dropStateAfterExternalChange(): Promise<void> {
    this.knownFiles.clear();
    this.lastSeen.clear();
    this.diskEpoch++;
    this.invalidateCaches();
    try {
      await this.loadProject();
    } catch (error) {
      // Keep trying on the next call rather than serve the old project
      this.projectStale = true;
      throw new Error(
        `project.c3proj changed on disk and could not be read again (${error instanceof Error ? error.message : String(error)}). ` +
        'If Construct 3 or git is still writing the project, try again once it is done.'
      );
    }
  }

  /**
   * How many external changes syncWithDisk() has found. The project index and
   * the ID generator note the epoch they were built in and rebuild when it
   * moves.
   */
  getDiskEpoch(): number {
    return this.diskEpoch;
  }

  /**
   * The state a file was in when the running tool call first read it, or,
   * outside a tool call or for a file the call did not read, when this reader
   * last read or wrote it; undefined when it never did. The writer refuses to
   * replace or delete a file whose state on disk differs from this.
   */
  stateAsRead(path: string): FileState | undefined {
    const key = fileKey(path);
    const scope = currentToolCall();
    if (scope?.reads.has(key)) return scope.reads.get(key);
    return this.lastSeen.get(key);
  }

  /**
   * Record that the server itself wrote (or deleted: null) a file, so
   * syncWithDisk() does not take its own write for an external change. The
   * caller has brought the cached state in line with the new content (the
   * writer drops the caches and the index and adds the file's IDs to the ID
   * generator).
   */
  noteOwnWrite(path: string, state: FileState): void {
    const key = fileKey(path);
    this.knownFiles.set(key, { path, state });
    this.lastSeen.set(key, state);
    noteFileWritten(key, state);
  }

  /**
   * Whether project.c3proj on disk differs from the version this reader
   * loaded last (a change the server did not make).
   */
  async projectFileChanged(): Promise<boolean> {
    return this.projectStale || this.projectState === undefined
      || !sameFileState(await statFileState(this.projectPath), this.projectState);
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
