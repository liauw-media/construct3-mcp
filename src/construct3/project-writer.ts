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
import {
  currentToolCall,
  fileKey,
  noteFileRead,
  noteFileWritten,
  sameFileState,
  statFileState,
  StaleFileError,
  type CallChange,
  type FileState,
  type ToolCallScope,
} from './disk-state.js';

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

  /**
   * The write replaced the file, but the post-write check found other valid
   * JSON there: another write to the same file landed during this one, and
   * the file holds that write's content (see ConcurrentWriteError).
   */
  get changedByOtherWrite(): boolean {
    return this.cause instanceof ConcurrentWriteError;
  }
}

/**
 * The post-write check read back valid JSON other than the text written:
 * another write to the same file (e.g. a tool call running in parallel)
 * landed after this one.
 */
export class ConcurrentWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConcurrentWriteError';
  }
}

/**
 * How often an update of project.c3proj reads the file again when it changed
 * between the read and the write, before the update is refused.
 */
const MAX_PROJECT_UPDATE_ROUNDS = 3;

/** What undoing a tool call's earlier changes did (see Construct3ProjectWriter.undoCallChanges). */
interface UndoReport {
  /** Files put back as they were before the call. */
  restored: string[];
  /** Files that could not be put back, with their backup (null: the file did not exist before the call). */
  left: Array<{ label: string; backup: string | null }>;
}

/**
 * Why a write to a file that changed on disk since it was read was refused,
 * and, when the tool call had changed other files before, what became of
 * those.
 */
function staleFileMessage(label: string, undo?: UndoReport): string {
  const cause = `${label} was changed on disk after this server read it (saved in the Construct 3 editor, restored with git, ` +
    'or written by another program or a tool call running in parallel). It was not written, so that change is kept.';
  if (!undo || (undo.restored.length === 0 && undo.left.length === 0)) {
    return `${cause} Run the tool again: it reads the file as it is now.`;
  }
  if (undo.left.length === 0) {
    return `${cause} The files this tool call had already changed were put back as they were before the call ` +
      `(${undo.restored.join(', ')}), so the call changed nothing. Run the tool again: it reads the files as they are now.`;
  }
  const left = undo.left.map(f => (f.backup
    ? `${f.label} (its state from before the call is in ${f.backup})`
    : `${f.label} (it did not exist before the call)`));
  return `${cause} This tool call had already changed other files, and not all of them could be put back: ` +
    (undo.restored.length > 0 ? `put back as they were before the call: ${undo.restored.join(', ')}; ` : '') +
    `left as they are (changed on disk again after this call wrote them, or their backup was replaced): ${left.join(', ')}. ` +
    'Check the project (validate_project, git diff) before you run the tool again.';
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT';
}

/**
 * A lock: the function it returns runs each `fn` after every `fn` passed to
 * it before has finished, in call order.
 */
function createLock(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    let release!: () => void;
    const next = new Promise<void>(resolve => { release = resolve; });
    const prev = tail;
    tail = next;
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

export class Construct3ProjectWriter {
  private readonly projectLock = createLock();
  // One lock per entity file (fileKey): the check that the file is unchanged
  // since it was read and the write that follows run as one step, so of two
  // parallel calls writing the same file the second sees the first's write
  private readonly fileLocks = new Map<string, ReturnType<typeof createLock>>();
  private readonly animationLock = createLock();

  constructor(
    private reader: Construct3ProjectReader,
    private idGen: IdGenerator,
  ) {}

  /**
   * Serialize access to the .c3proj file to prevent lost-update races.
   */
  private async withProjectLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.projectLock(fn);
  }

  /**
   * Run `fn` after every earlier withAnimationLock call has finished. The
   * animation tools take this lock for their whole call: each one reads a
   * Sprite's object file, changes its animations or frames, and writes it
   * back, and several rename or write frame image files in images/, whose
   * names hold the frame index. Run in parallel, one could write the object
   * back without the frames another one added, while that one had already
   * moved the image files, or plan renames against files another one is
   * moving and, rolling back, rename a file over one the other moved there.
   * `fn` must read what it changes inside the lock.
   */
  async withAnimationLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.animationLock(fn);
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
   *
   * Once per tool call (#51): when the running call already backed the file
   * up, or found it missing before its first write, the .bak keeps the state
   * from before the call, so a call that writes a file twice (create_object
   * registering its plugin and then the object in project.c3proj) does not
   * back up its own intermediate state.
   */
  private async createBackup(path: string): Promise<string> {
    // The backup takes the file's name as spelled on disk
    const filePath = await existingSpelling(path);
    const scope = currentToolCall();
    const key = fileKey(filePath);
    const earlier = scope?.backups.get(key);
    if (earlier !== undefined) return earlier.path;
    const backupPath = filePath + '.bak';
    try {
      await stat(filePath);
    } catch (e: unknown) {
      // File doesn't exist yet (new entity) — no backup needed
      if (isNotFound(e)) {
        scope?.backups.set(key, { path: backupPath, existed: false, state: null });
        return backupPath;
      }
      throw new Error(`Cannot access file for backup: ${e instanceof Error ? e.message : String(e)}`);
    }
    // File exists — backup must succeed or we abort
    await copyFile(filePath, backupPath);
    if (scope) scope.backups.set(key, { path: backupPath, existed: true, state: await statFileState(backupPath) });
    return backupPath;
  }

  /**
   * Record in the running tool call that it changed (wrote or deleted) a
   * file it backed up before, so a refused write later in the call can put
   * it back (undoCallChanges).
   */
  private noteCallChange(filePath: string, isProjectFile = false): void {
    const scope = currentToolCall();
    if (!scope) return;
    const key = fileKey(filePath);
    const backup = scope.backups.get(key);
    if (backup === undefined || scope.changes.has(key)) return;
    scope.changes.set(key, { path: filePath, label: this.projectRelative(filePath), backup, isProjectFile });
  }

  /**
   * Undo what the running tool call changed before one of its writes was
   * refused (#51), so the call leaves the project as it found it: each file
   * it wrote or deleted through the writer is put back from its backup,
   * which holds the state from before the call, last change first, and a
   * file the call created is removed again. A file that changed on disk
   * after the call wrote it, or whose backup another call replaced
   * meanwhile, is left as it is. Runs outside the writer's locks; takes the
   * lock of each file it puts back.
   */
  private async undoCallChanges(scope: ToolCallScope): Promise<UndoReport> {
    const report: UndoReport = { restored: [], left: [] };
    const changes = [...scope.changes].reverse();
    scope.changes.clear();
    let projectPutBack = false;
    for (const [key, change] of changes) {
      let putBack = false;
      try {
        putBack = change.isProjectFile
          ? await this.withProjectLock(() => this.putBack(key, change, scope))
          : await this.withFileLock(change.path, () => this.putBack(key, change, scope));
      } catch {
        putBack = false;
      }
      if (putBack) {
        report.restored.push(change.backup.existed ? change.label : `${change.label} (deleted: the call had created it)`);
        if (change.isProjectFile) projectPutBack = true;
      } else {
        report.left.push({ label: change.label, backup: change.backup.existed ? this.projectRelative(change.backup.path) : null });
      }
    }
    if (projectPutBack) {
      try {
        await this.reader.reloadProject();
      } catch {
        // Not valid JSON right now: the next tool call's check loads it again
      }
      resetProjectIndex(this.reader);
    }
    return report;
  }

  /**
   * Put one file the tool call changed back as it was before the call.
   * False when it changed on disk since the call wrote it, or its backup no
   * longer holds the state from before the call.
   */
  private async putBack(key: string, change: CallChange, scope: ToolCallScope): Promise<boolean> {
    const asLeft = scope.reads.get(key);
    if (asLeft === undefined || !sameFileState(await statFileState(change.path), asLeft)) return false;
    if (!change.backup.existed) {
      try {
        await unlink(change.path);
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
      if (change.isProjectFile) noteFileWritten(key, null);
      else this.afterOwnWrite(change.path, null);
      return true;
    }
    if (!sameFileState(await statFileState(change.backup.path), change.backup.state)) return false;
    const content = await readFile(change.backup.path);
    await this.atomicWrite(change.path, content);
    const state = await statFileState(change.path);
    if (change.isProjectFile) noteFileWritten(key, state);
    else this.afterOwnWrite(change.path, state, content.toString('utf-8'));
    return true;
  }

  /**
   * A write of the running tool call was refused as stale (StaleFileError):
   * undo what the call changed before it (undoCallChanges) and return the
   * refusal with what became of those files. Any other error is returned as
   * it is. Called outside the writer's locks.
   */
  private async refusalAfterUndo(error: unknown): Promise<unknown> {
    if (!(error instanceof StaleFileError) || error.undone) return error;
    const scope = currentToolCall();
    if (!scope || scope.changes.size === 0) return error;
    const undo = await this.undoCallChanges(scope);
    return new StaleFileError(staleFileMessage(error.file, undo), error.file, true);
  }

  /**
   * Refuse to replace or delete a file that changed on disk after the server
   * read it (#51): the change was made outside this call (saved in the
   * Construct 3 editor, `git restore`, a tool call running in parallel), and
   * writing would replace it with content built from the old file.
   */
  private async assertUnchangedSinceRead(filePath: string, label: string): Promise<void> {
    // A file the call did not read itself is compared with the state the
    // reader last saw, which is only current once the call checked it
    await this.reader.ensureCachesFresh();
    const asRead = this.reader.stateAsRead(filePath);
    if (asRead === undefined) return;
    const now = await statFileState(filePath);
    if (!sameFileState(now, asRead)) {
      throw new StaleFileError(staleFileMessage(label), label);
    }
  }

  /**
   * Refuse (StaleFileError) when project.c3proj changed on disk since the
   * reader loaded it, that is, during the running tool call. For the tools
   * that update project.c3proj themselves (timelines, addons, runtime
   * bridge) after deciding on the loaded project: they run it before their
   * first write. The writer's own updates of project.c3proj take such a
   * change in and merge into it instead (updateProjectFile), since they run
   * after the call wrote other files. Should the call have changed files
   * through the writer before, they are put back first (undoCallChanges).
   */
  async assertProjectFileCurrent(): Promise<void> {
    if (await this.reader.projectFileChanged()) {
      const label = this.projectRelative(this.reader.getProjectPath());
      throw await this.refusalAfterUndo(new StaleFileError(staleFileMessage(label), label));
    }
  }

  /**
   * After a write of the server's own: record the file's new state, drop the
   * reader caches and the project index, and add the IDs in the written text
   * to the ID generator (it keeps its scan instead of scanning the whole
   * project again, #38).
   */
  private afterOwnWrite(filePath: string, state: FileState, text?: string): void {
    this.reader.noteOwnWrite(filePath, state);
    this.reader.invalidateCaches();
    resetProjectIndex(this.reader);
    if (text !== undefined) this.idGen.noteWrittenText(text);
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
  private async verifyWrittenFile(filePath: string, entityName: string, expected: string): Promise<FileState> {
    let content: string;
    let state: FileState;
    try {
      // The state before the read-back: when the text is ours, so is this state
      state = await statFileState(filePath);
      content = await readFile(filePath, 'utf-8');
      parseJsonText(content);
    } catch (e) {
      throw new Error(`Post-write verification failed for "${entityName}": file may be corrupted. A .bak backup exists. Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (content !== expected) {
      throw new ConcurrentWriteError(`Post-write verification failed for "${entityName}": the file was changed by another write during this one (concurrent writes to the same file?). It holds valid JSON, but not this call's changes. Re-read it and retry.`);
    }
    return state;
  }

  /**
   * Update project.c3proj under the project lock: `change` edits the parsed
   * file and returns false when there is nothing to write. The file is
   * backed up (once per tool call), written with its text style, read back
   * and loaded again by the reader. Returns the backup path, or undefined
   * when nothing was written.
   *
   * A change made on disk is merged, never replaced (#51): one made since the
   * reader loaded the file is taken in first (reader.checkProjectFile(): the
   * file is loaded again, and the caches, the index and the ID generator's
   * scan are renewed), the file is read right before the write, and when it
   * changes between that read and the write it is read and changed again.
   * Only when it keeps changing is the update refused (StaleFileError).
   * These updates run after the tool call wrote other files (registering a
   * new entity, removing a deleted one), so refusing them for a change they
   * can merge would leave the project half changed.
   */
  private async updateProjectFile(change: (project: any) => boolean | void): Promise<string | undefined> {
    const projectPath = this.reader.getProjectPath();
    const label = this.projectRelative(projectPath);
    try {
      return await this.withProjectLock(async () => {
        await this.reader.checkProjectFile();
        for (let round = 0; round < MAX_PROJECT_UPDATE_ROUNDS; round++) {
          const asRead = await statFileState(projectPath);
          const content = await readFile(projectPath, 'utf-8');
          const project = parseJsonText(content);
          if (change(project) === false) return undefined;
          const text = applyJsonTextStyle(this.validateJsonData(project, 'project.c3proj'), jsonTextStyleOf(content));

          const backupPath = await this.createBackup(projectPath);
          // Changed since the read: read it again, so that change is kept
          if (!sameFileState(await statFileState(projectPath), asRead)) continue;
          await this.atomicWrite(projectPath, text);
          const state = await this.verifyWrittenFile(projectPath, 'project.c3proj', text);
          noteFileWritten(fileKey(projectPath), state);
          this.noteCallChange(projectPath, true);
          await this.reader.reloadProject();
          return backupPath;
        }
        throw new StaleFileError(staleFileMessage(label), label);
      });
    } catch (error) {
      // Refused as stale: first put back what the call changed before
      throw await this.refusalAfterUndo(error);
    }
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
    const refuseExisting = async () => {
      const refusal = await this.entityFileRefusal(category, name, subfolder);
      if (refusal) throw new Error(refusal);
    };
    if (options.createOnly) await refuseExisting();

    const requested = this.entityFilePath(category, name, subfolder);

    // Ensure directory exists
    await mkdir(dirname(requested), { recursive: true });
    const filePath = await existingSpelling(requested);
    try {
      return await this.withFileLock(filePath, async () => {
        if (options.createOnly) {
          // Again under the file's lock: of two parallel calls creating the
          // same entity, the second sees the first one's file and is refused
          await refuseExisting();
          // The call expects no file there, whatever state another call left
          noteFileRead(fileKey(filePath), null);
        }
        await this.assertUnchangedSinceRead(filePath, this.projectRelative(filePath));

        // Keep the existing file's text style; a new file follows the project's
        const style = await resolveJsonTextStyle(filePath, this.reader.getProjectPath(), dirname(filePath));
        const text = applyJsonTextStyle(json, style);

        const backupPath = await this.createBackup(filePath);
        let state: FileState;
        try {
          await this.atomicWrite(filePath, text);

          // Post-write verification
          state = await this.verifyWrittenFile(filePath, name, text);
        } catch (error) {
          // The file may have been replaced already: tell the caller where the backup is
          throw new EntityWriteError(error, backupPath);
        }

        this.afterOwnWrite(filePath, state, text);
        this.noteCallChange(filePath);
        return backupPath;
      });
    } catch (error) {
      // Refused as stale: first put back what the call changed before
      throw await this.refusalAfterUndo(error);
    }
  }

  /** Run `fn` after every earlier withFileLock call for the same file has finished. */
  private withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
    const key = fileKey(filePath);
    let lock = this.fileLocks.get(key);
    if (!lock) {
      lock = createLock();
      this.fileLocks.set(key, lock);
    }
    return lock(fn);
  }

  /** A path inside the project as shown in messages ("layouts/Level 1.json"). */
  private projectRelative(filePath: string): string {
    return relative(this.reader.getProjectDir(), filePath).split(sep).join('/');
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
    try {
      return await this.withFileLock(filePath, async () => {
        await this.assertUnchangedSinceRead(filePath, this.projectRelative(filePath));

        const backupPath = await this.createBackup(filePath);
        let deleted = true;
        try {
          await unlink(filePath);
        } catch (e: unknown) {
          // File already gone — that's the desired end state
          if (!isNotFound(e)) throw e;
          deleted = false;
        }

        this.afterOwnWrite(filePath, null);
        if (deleted) this.noteCallChange(filePath);
        return backupPath;
      });
    } catch (error) {
      // Refused as stale: first put back what the call changed before
      throw await this.refusalAfterUndo(error);
    }
  }

  /**
   * Add a name to a c3proj container (objectTypes, eventSheets, layouts, families).
   */
  async addToProject(
    category: EntityCategory,
    name: string,
    subfolder?: string,
  ): Promise<void> {
    await this.updateProjectFile(project => {
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
    });
  }

  /**
   * Remove a name from a c3proj container.
   */
  async removeFromProject(
    category: EntityCategory,
    name: string,
  ): Promise<void> {
    await this.updateProjectFile(project => {
      const container = project[category];

      // Remove from root items
      const rootIdx = container.items.indexOf(name);
      if (rootIdx !== -1) {
        container.items.splice(rootIdx, 1);
      } else {
        // Search subfolders
        this.removeFromSubfolders(container.subfolders, name);
      }
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

    const backupPath = await this.updateProjectFile(project => {
      // Apply updates to top-level and properties
      for (const [key, value] of Object.entries(updates)) {
        if (ALLOWED_TOP_LEVEL.has(key)) {
          project[key] = value;
        } else {
          project.properties[key] = value;
        }
      }
    });
    // The change above never returns false, so the file was written
    return backupPath as string;
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
   * Throw the error ensureAddonRegistered() would throw: the addon is neither
   * registered in usedAddons nor a known built-in Scirra addon. Tools that
   * register several addons check them all before the first write, so an
   * unknown one does not leave the others registered.
   */
  checkAddonRegistrable(type: 'plugin' | 'behavior', id: string): void {
    if (this.reader.getUsedAddons().some(a => a.type === type && a.id === id)) return;
    const knownMap = type === 'plugin' ? KNOWN_SCIRRA_PLUGINS : KNOWN_SCIRRA_BEHAVIORS;
    if (!knownMap[id]) {
      throw new Error(
        `${type === 'plugin' ? 'Plugin' : 'Behavior'} "${id}" is not registered in the project's usedAddons ` +
        `and is not a known built-in Scirra addon. Add it to the project in the Construct 3 editor first.`
      );
    }
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

    this.checkAddonRegistrable(type, id);
    // Look up known Scirra addon
    const knownMap = type === 'plugin' ? KNOWN_SCIRRA_PLUGINS : KNOWN_SCIRRA_BEHAVIORS;
    const displayName = knownMap[id];

    // Auto-register the addon in c3proj
    const written = await this.updateProjectFile(project => {
      // Checked again in the file as it is now: another call running in
      // parallel, or the editor, may have registered it meanwhile
      if ((project.usedAddons as Addon[]).some(a => a.type === type && a.id === id)) return false;
      const newAddon: Addon = {
        type,
        id,
        name: displayName,
        author: 'Scirra',
        bundled: false,
      };
      project.usedAddons.push(newAddon);
    });
    if (written === undefined) return undefined;
    return `Auto-registered ${type} "${id}" in usedAddons (was not previously in the project).`;
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

  /**
   * Delete a file directly in images/ (`name` relative to that folder).
   * Returns false when there is no such file; a name that cannot be a file
   * directly in images/ (a path separator, "." or "..") names none.
   */
  async deleteImageFile(name: string): Promise<boolean> {
    let filePath: string;
    try {
      filePath = this.imageFilePath(name);
    } catch {
      return false;
    }
    try {
      await unlink(filePath);
      return true;
    } catch (e: unknown) {
      if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') return false;
      throw e;
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
    await this.withFileLock(filePath, async () => {
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
      this.afterOwnWrite(filePath, await statFileState(filePath), content.toString('utf-8'));
    });
  }

  /** Path of a file directly in images/; refuses names that would point elsewhere. */
  private imageFilePath(name: string): string {
    if (name === '' || name === '.' || name === '..' || /[\\/]/.test(name)) {
      throw new Error(`Invalid image file name "${name}"`);
    }
    return resolveProjectPath(this.reader.getProjectDir(), 'images', name);
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
