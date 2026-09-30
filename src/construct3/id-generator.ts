/**
 * SID and UID generator with collision avoidance.
 * Scans existing project IDs on first use, then generates unique new ones.
 *
 * The scan is kept across the server's own writes: the writer hands every
 * text it writes to noteWrittenText(), which adds the IDs in it (#38). A
 * change on disk the server did not make (the reader's disk epoch moves, see
 * Construct3ProjectReader.syncWithDisk) makes the next ID request scan the
 * project again (#51). IDs are only ever added: a rescan adds what it finds
 * to what the generator already knows, so an ID it handed out is never handed
 * out again, also when the file it went into was reset on disk meanwhile.
 */

import {
  entityFolderPaths,
  isFileNotFoundError,
  scanIdsInText,
  type Construct3ProjectReader,
  type ReadFailure,
} from './project-reader.js';
import type { AnimationsContainer, C3Event, Layout, RootFileFolders } from './types.js';
import { forEachLayoutInstance, layerEntries } from './layers.js';
import { diskEpochOf, ensureCachesFreshOf } from './disk-state.js';

const SID_MIN = 100_000_000_000_000; // 15-digit minimum
const SID_MAX = 999_999_999_999_999; // 15-digit maximum
const MAX_SID_RETRIES = 100;

const IMAGE_SPRITE_ID_MIN = 1_000_000; // 7-digit minimum
const IMAGE_SPRITE_ID_MAX = 9_999_999; // 7-digit maximum

/**
 * Why the raw scan of a file failed, for the UID refusal: from the fs error
 * code (its message carries the absolute path), or the message of an error
 * without one (the path traversal check).
 */
function scanFailureReason(error: unknown): string {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  if (code === 'EISDIR') return 'a folder in place of the file';
  if (code === 'EACCES' || code === 'EPERM') return 'no read access';
  if (typeof code === 'string') return `could not be read (${code})`;
  return error instanceof Error && error.message ? error.message : 'could not be read';
}

/**
 * A UID-bearing file that exists but could not be scanned at all, with why
 * (scanFailureReason).
 */
interface UnscannedEntity {
  category: 'objectTypes' | 'layouts';
  name: string;
  reason: string;
}

/** Rescans in one initialize() call when the disk keeps changing while it scans. */
const MAX_SCAN_ROUNDS = 3;

/** The IDs one scan finds; merged into the generator when the scan is done. */
class IdCollector {
  readonly sids = new Set<number>();
  readonly imageSpriteIds = new Set<number>();
  highestUid = 0;

  sid(sid: unknown): void {
    if (typeof sid === 'number' && sid > 0) this.sids.add(sid);
  }

  imageSpriteId(id: unknown): void {
    if (typeof id === 'number' && id > 0) this.imageSpriteIds.add(id);
  }

  uid(uid: unknown): void {
    if (typeof uid === 'number' && uid > this.highestUid) this.highestUid = uid;
  }
}

export class IdGenerator {
  private existingSids = new Set<number>();
  private existingImageSpriteIds = new Set<number>();
  private highestUid = 0;
  // The reader's disk epoch the last completed scan ran in (undefined: none yet)
  private scannedEpoch: number | undefined;
  private scanning: { epoch: number; done: Promise<void> } | null = null;
  // Bumped by reset(): a scan that started before does not merge its result
  private generation = 0;
  // UID-bearing files that exist but could not be scanned at all (parse AND
  // raw scan failed), with why. While non-empty, the UID high-water mark is
  // untrustworthy and UID minting must hard-fail rather than risk a
  // duplicate UID.
  private unscannedEntities: UnscannedEntity[] = [];

  /**
   * Scan the project to collect all existing SIDs and find the highest UID:
   * on first use, and again after the reader found a change on disk it did
   * not make. Parallel callers share one scan.
   */
  async initialize(reader: Construct3ProjectReader): Promise<void> {
    // In a tool call: a file the scan read may have changed on disk since
    await ensureCachesFreshOf(reader);
    for (let round = 0; round < MAX_SCAN_ROUNDS; round++) {
      const epoch = diskEpochOf(reader);
      if (this.scannedEpoch === epoch) return;
      let scanning = this.scanning;
      if (!scanning || scanning.epoch !== epoch) {
        const started = { epoch, done: this.scan(reader, epoch) };
        const clear = () => { if (this.scanning === started) this.scanning = null; };
        started.done.then(clear, clear);
        this.scanning = scanning = started;
      }
      await scanning.done;
    }
  }

  /**
   * Scan again the files the last scan could not read at all (a lock held by
   * a virus scanner, a sync client or the editor, no read access, a folder
   * in the file's place). Their state on disk may not have changed when they
   * become readable again, so no external change is seen for them: without
   * this, UID minting would stay refused until the server restarts. A file
   * that is gone or no longer registered holds no UIDs any more.
   */
  private async rescanUnscanned(reader: Construct3ProjectReader): Promise<void> {
    const generation = this.generation;
    const epoch = this.scannedEpoch;
    const project = reader.getProject();
    const ids = new IdCollector();
    const still: UnscannedEntity[] = [];
    for (const { category, name } of this.unscannedEntities) {
      if (!entityFolderPaths(project[category]).has(name)) continue;
      try {
        const scan = await reader.scanEntityIdsRaw(category, name);
        ids.uid(scan.highestUid);
        for (const sid of scan.sids) ids.sid(sid);
      } catch (error) {
        if (isFileNotFoundError(error)) continue;
        still.push({ category, name, reason: scanFailureReason(error) });
      }
    }
    // A reset or a new scan ran meanwhile: its result stands
    if (generation !== this.generation || epoch !== this.scannedEpoch) return;
    for (const sid of ids.sids) this.existingSids.add(sid);
    if (ids.highestUid > this.highestUid) this.highestUid = ids.highestUid;
    this.unscannedEntities = still;
  }

  private async scan(reader: Construct3ProjectReader, epoch: number): Promise<void> {
    const generation = this.generation;
    const ids = new IdCollector();
    const unscanned = await this.collectProjectIds(reader, ids);
    // reset() ran meanwhile and dropped everything known: leave it that way
    if (generation !== this.generation) return;
    for (const sid of ids.sids) this.existingSids.add(sid);
    for (const id of ids.imageSpriteIds) this.existingImageSpriteIds.add(id);
    if (ids.highestUid > this.highestUid) this.highestUid = ids.highestUid;
    this.unscannedEntities = unscanned;
    this.scannedEpoch = epoch;
  }

  /**
   * Collect every SID, UID and imageSpriteId in the project. Returns the
   * UID-bearing files that exist but could not be scanned.
   */
  private async collectProjectIds(reader: Construct3ProjectReader, ids: IdCollector): Promise<UnscannedEntity[]> {
    // Scan c3proj file for SIDs in file items
    const project = reader.getProject();
    this.scanContainerSids(ids, project.rootFileFolders);

    // Scan all object types. The read failures are taken right away: they
    // belong to this result, and a reload by a concurrent call clears them.
    const objects = await reader.readAllObjectTypes();
    const objectTypeFailures = reader.getReadFailures('objectTypes');
    for (const [, obj] of objects) {
      ids.sid(obj.sid);
      // Also check behaviorTypes (C3 uses this key)
      if (Array.isArray(obj.behaviorTypes)) {
        for (const b of obj.behaviorTypes) {
          ids.sid(b.sid);
        }
      }
      // Instance variable SIDs
      if (Array.isArray(obj.instanceVariables)) {
        for (const v of obj.instanceVariables) {
          ids.sid(v.sid);
        }
      }
      // Animation SIDs
      if (obj.animations) {
        this.scanAnimationSids(ids, obj.animations);
      }
      // Singleglobal instance
      const sgi = obj['singleglobal-inst'];
      if (sgi) {
        ids.sid(sgi.sid);
        ids.uid(sgi.uid);
      }
    }

    // Scan all event sheets
    const sheets = await reader.readAllEventSheets();
    for (const [, sheet] of sheets) {
      ids.sid(sheet.sid);
      this.scanEventSids(ids, sheet.events);
    }

    // Scan all layouts
    const layouts = await reader.readAllLayouts();
    const layoutFailures = reader.getReadFailures('layouts');
    for (const [, layout] of layouts) {
      ids.sid(layout.sid);
      this.scanLayoutSids(ids, layout);
    }

    const unscanned = await this.recoverSkippedIds(reader, ids, [
      { category: 'objectTypes', loaded: objects, failures: objectTypeFailures },
      { category: 'layouts', loaded: layouts, failures: layoutFailures },
    ]);

    // Scan all families
    const families = await reader.readAllFamilies();
    for (const [, family] of families) {
      ids.sid(family.sid as number);
    }

    return unscanned;
  }

  /**
   * Registered layouts and object types that the bulk reads skipped (over the
   * size cap, unparsable, ...) still hold live UIDs: layout instances and
   * objectTypes' singleglobal-inst. Recover their UIDs and SIDs with a raw
   * text scan so the UID high-water mark stays correct.
   *
   * Driven by the registered names, not by the failure records alone, so a
   * skipped file is scanned even if its record went missing. Returns the
   * files that exist but could not be scanned either, with the reason;
   * generateUid() refuses while there are any ("category/name: reason"),
   * instead of risking a duplicate UID.
   */
  private async recoverSkippedIds(
    reader: Construct3ProjectReader,
    ids: IdCollector,
    sources: Array<{
      category: 'objectTypes' | 'layouts';
      loaded: Map<string, unknown>;
      failures: Map<string, ReadFailure>;
    }>,
  ): Promise<UnscannedEntity[]> {
    const project = reader.getProject();
    const unscanned: UnscannedEntity[] = [];
    for (const { category, loaded, failures } of sources) {
      for (const name of entityFolderPaths(project[category]).keys()) {
        if (loaded.has(name)) continue;
        // A registered file that does not exist provably holds no UIDs or
        // SIDs: nothing to recover, nothing to distrust.
        if (failures.get(name)?.code === 'E_FILE_NOT_FOUND') continue;
        try {
          const scan = await reader.scanEntityIdsRaw(category, name);
          ids.uid(scan.highestUid);
          for (const sid of scan.sids) {
            ids.sid(sid);
          }
        } catch (error) {
          // No file (or it vanished since the bulk read): same as above.
          if (isFileNotFoundError(error)) continue;
          unscanned.push({ category, name, reason: scanFailureReason(error) });
        }
      }
    }
    return unscanned;
  }

  /**
   * Generate a unique SID (15-digit random integer, collision-checked).
   */
  async generateSid(reader: Construct3ProjectReader): Promise<number> {
    await this.initialize(reader);

    for (let i = 0; i < MAX_SID_RETRIES; i++) {
      const sid = Math.floor(Math.random() * (SID_MAX - SID_MIN + 1)) + SID_MIN;
      if (!this.existingSids.has(sid)) {
        this.existingSids.add(sid);
        return sid;
      }
    }

    throw new Error(`Failed to generate unique SID after ${MAX_SID_RETRIES} attempts`);
  }

  /**
   * Generate the next sequential UID.
   */
  async generateUid(reader: Construct3ProjectReader): Promise<number> {
    await this.initialize(reader);
    // Files the scan could not read may be readable by now
    if (this.unscannedEntities.length > 0) await this.rescanUnscanned(reader);
    if (this.unscannedEntities.length > 0) {
      throw new Error(
        `Cannot generate a safe UID: project file(s) could not be scanned for existing UIDs ` +
        `(${this.unscannedEntities.map(e => `${e.category}/${e.name}: ${e.reason}`).join(', ')}). ` +
        `Minting anyway could duplicate a UID already in use.`
      );
    }
    this.highestUid++;
    return this.highestUid;
  }

  /**
   * Generate a unique imageSpriteId (7-digit integer, collision-checked).
   * These IDs are used per animation frame to link to the image file.
   */
  async generateImageSpriteId(reader: Construct3ProjectReader): Promise<number> {
    await this.initialize(reader);

    for (let i = 0; i < MAX_SID_RETRIES; i++) {
      const id = Math.floor(Math.random() * (IMAGE_SPRITE_ID_MAX - IMAGE_SPRITE_ID_MIN + 1)) + IMAGE_SPRITE_ID_MIN;
      if (!this.existingImageSpriteIds.has(id)) {
        this.existingImageSpriteIds.add(id);
        return id;
      }
    }

    throw new Error(`Failed to generate unique imageSpriteId after ${MAX_SID_RETRIES} attempts`);
  }

  /**
   * Register a newly generated SID.
   */
  addSid(sid: number): void {
    this.existingSids.add(sid);
  }

  /**
   * Register a newly generated UID.
   */
  addUid(uid: number): void {
    if (uid > this.highestUid) {
      this.highestUid = uid;
    }
  }

  /**
   * Add the IDs in a file the server just wrote: every "sid", "uid" and
   * "imageSpriteId" value in the text (a value inside a string counts too,
   * which only makes the known set larger). The writer calls this for each
   * of its writes instead of dropping the scan, so the next ID does not
   * rescan the whole project.
   */
  noteWrittenText(text: string): void {
    const scan = scanIdsInText(text);
    for (const sid of scan.sids) this.existingSids.add(sid);
    if (scan.highestUid > this.highestUid) this.highestUid = scan.highestUid;
    for (const match of text.matchAll(/"imageSpriteId"\s*:\s*(\d+)/g)) {
      this.existingImageSpriteIds.add(Number(match[1]));
    }
  }

  /**
   * Forget everything known, so IDs are scanned from scratch on next use.
   */
  reset(): void {
    this.existingSids = new Set<number>();
    this.existingImageSpriteIds = new Set<number>();
    this.highestUid = 0;
    this.scannedEpoch = undefined;
    this.scanning = null;
    this.generation++;
    this.unscannedEntities = [];
  }

  private scanContainerSids(ids: IdCollector, rootFolders: RootFileFolders): void {
    for (const folder of Object.values(rootFolders)) {
      if (folder && typeof folder === 'object') {
        this.scanFileFolderSids(ids, folder as Record<string, unknown>);
      }
    }
  }

  private scanFileFolderSids(ids: IdCollector, folder: Record<string, unknown>): void {
    const items = folder.items as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(items)) {
      for (const item of items) {
        ids.sid(item.sid);
      }
    }
    const subfolders = folder.subfolders as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(subfolders)) {
      for (const sub of subfolders) {
        this.scanFileFolderSids(ids, sub);
      }
    }
  }

  private scanAnimationSids(ids: IdCollector, animations: AnimationsContainer): void {
    for (const anim of animations.items) {
      ids.sid(anim.sid);
      for (const frame of anim.frames) {
        ids.sid(frame.sid);
        ids.imageSpriteId(frame.imageSpriteId);
      }
    }
    for (const sub of animations.subfolders) {
      this.scanAnimationSids(ids, sub);
    }
  }

  private scanEventSids(ids: IdCollector, events: C3Event[]): void {
    const stack = [...events];
    while (stack.length > 0) {
      const event = stack.pop()!;
      ids.sid((event as { sid?: unknown }).sid);

      // Conditions & actions
      if ('conditions' in event && Array.isArray(event.conditions)) {
        for (const c of event.conditions) {
          ids.sid(c.sid);
        }
      }
      if ('actions' in event && Array.isArray(event.actions)) {
        for (const a of event.actions) {
          ids.sid((a as { sid?: unknown }).sid);
        }
      }

      // Function parameters (functionParameters on FunctionBlockEvent)
      if ('functionParameters' in event && Array.isArray(event.functionParameters)) {
        for (const p of event.functionParameters) {
          ids.sid(p.sid);
        }
      }

      // Children
      if ('children' in event && Array.isArray(event.children)) {
        stack.push(...event.children);
      }
    }
  }

  /** Layer SIDs, instance SIDs and UIDs on every layer and sub-layer, and of non-world instances. */
  private scanLayoutSids(ids: IdCollector, layout: Layout): void {
    for (const { layer } of layerEntries(layout.layers)) {
      ids.sid(layer.sid);
    }
    forEachLayoutInstance(layout, instance => {
      ids.sid(instance.sid);
      ids.uid(instance.uid);
    });
  }
}
