/**
 * SID and UID generator with collision avoidance.
 * Scans existing project IDs on first use, then generates unique new ones.
 */

import type { Construct3ProjectReader } from './project-reader.js';
import type { AnimationsContainer, C3Event, Layout, RootFileFolders } from './types.js';

const SID_MIN = 100_000_000_000_000; // 15-digit minimum
const SID_MAX = 999_999_999_999_999; // 15-digit maximum
const MAX_SID_RETRIES = 100;

const IMAGE_SPRITE_ID_MIN = 1_000_000; // 7-digit minimum
const IMAGE_SPRITE_ID_MAX = 9_999_999; // 7-digit maximum

export class IdGenerator {
  private existingSids: Set<number> | null = null;
  private existingImageSpriteIds: Set<number> | null = null;
  private highestUid = 0;
  private initialized = false;

  /**
   * Scan the project to collect all existing SIDs and find the highest UID.
   */
  async initialize(reader: Construct3ProjectReader): Promise<void> {
    if (this.initialized) return;

    this.existingSids = new Set<number>();
    this.existingImageSpriteIds = new Set<number>();

    // Scan c3proj file for SIDs in file items
    const project = reader.getProject();
    this.scanContainerSids(project.rootFileFolders);

    // Scan all object types
    const objects = await reader.readAllObjectTypes();
    for (const [, obj] of objects) {
      this.collectSid(obj.sid);
      // Also check behaviorTypes (C3 uses this key)
      if (Array.isArray(obj.behaviorTypes)) {
        for (const b of obj.behaviorTypes) {
          this.collectSid(b.sid);
        }
      }
      // Instance variable SIDs
      if (Array.isArray(obj.instanceVariables)) {
        for (const v of obj.instanceVariables) {
          this.collectSid(v.sid);
        }
      }
      // Animation SIDs
      if (obj.animations) {
        this.scanAnimationSids(obj.animations);
      }
      // Singleglobal instance
      const sgi = obj['singleglobal-inst'];
      if (sgi) {
        this.collectSid(sgi.sid);
        this.trackUid(sgi.uid);
      }
    }

    // Scan all event sheets
    const sheets = await reader.readAllEventSheets();
    for (const [, sheet] of sheets) {
      this.collectSid(sheet.sid);
      this.scanEventSids(sheet.events);
    }

    // Scan all layouts
    const layouts = await reader.readAllLayouts();
    for (const [, layout] of layouts) {
      this.collectSid(layout.sid);
      this.scanLayoutSids(layout);
    }

    // Scan all families
    const families = await reader.readAllFamilies();
    for (const [, family] of families) {
      this.collectSid(family.sid as number);
    }

    this.initialized = true;
  }

  /**
   * Generate a unique SID (15-digit random integer, collision-checked).
   */
  async generateSid(reader: Construct3ProjectReader): Promise<number> {
    await this.initialize(reader);

    for (let i = 0; i < MAX_SID_RETRIES; i++) {
      const sid = Math.floor(Math.random() * (SID_MAX - SID_MIN + 1)) + SID_MIN;
      if (!this.existingSids!.has(sid)) {
        this.existingSids!.add(sid);
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
      if (!this.existingImageSpriteIds!.has(id)) {
        this.existingImageSpriteIds!.add(id);
        return id;
      }
    }

    throw new Error(`Failed to generate unique imageSpriteId after ${MAX_SID_RETRIES} attempts`);
  }

  /**
   * Register a newly generated SID.
   */
  addSid(sid: number): void {
    this.existingSids?.add(sid);
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
   * Reset so IDs are re-scanned on next use.
   */
  reset(): void {
    this.existingSids = null;
    this.existingImageSpriteIds = null;
    this.highestUid = 0;
    this.initialized = false;
  }

  private collectSid(sid: unknown): void {
    if (typeof sid === 'number' && sid > 0) {
      this.existingSids!.add(sid);
    }
  }

  private collectImageSpriteId(id: unknown): void {
    if (typeof id === 'number' && id > 0) {
      this.existingImageSpriteIds!.add(id);
    }
  }

  private trackUid(uid: unknown): void {
    if (typeof uid === 'number' && uid > this.highestUid) {
      this.highestUid = uid;
    }
  }

  private scanContainerSids(rootFolders: RootFileFolders): void {
    for (const folder of Object.values(rootFolders)) {
      if (folder && typeof folder === 'object') {
        this.scanFileFolderSids(folder as Record<string, unknown>);
      }
    }
  }

  private scanFileFolderSids(folder: Record<string, unknown>): void {
    const items = folder.items as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(items)) {
      for (const item of items) {
        this.collectSid(item.sid);
      }
    }
    const subfolders = folder.subfolders as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(subfolders)) {
      for (const sub of subfolders) {
        this.scanFileFolderSids(sub);
      }
    }
  }

  private scanAnimationSids(animations: AnimationsContainer): void {
    for (const anim of animations.items) {
      this.collectSid(anim.sid);
      for (const frame of anim.frames) {
        this.collectSid(frame.sid);
        this.collectImageSpriteId(frame.imageSpriteId);
      }
    }
    for (const sub of animations.subfolders) {
      this.scanAnimationSids(sub);
    }
  }

  private scanEventSids(events: C3Event[]): void {
    const stack = [...events];
    while (stack.length > 0) {
      const event = stack.pop()!;
      this.collectSid((event as { sid?: unknown }).sid);

      // Conditions & actions
      if ('conditions' in event && Array.isArray(event.conditions)) {
        for (const c of event.conditions) {
          this.collectSid(c.sid);
        }
      }
      if ('actions' in event && Array.isArray(event.actions)) {
        for (const a of event.actions) {
          this.collectSid((a as { sid?: unknown }).sid);
        }
      }

      // Function parameters (functionParameters on FunctionBlockEvent)
      if ('functionParameters' in event && Array.isArray(event.functionParameters)) {
        for (const p of event.functionParameters) {
          this.collectSid(p.sid);
        }
      }

      // Children
      if ('children' in event && Array.isArray(event.children)) {
        stack.push(...event.children);
      }
    }
  }

  private scanLayoutSids(layout: Layout): void {
    for (const layer of layout.layers) {
      this.collectSid(layer.sid);
      for (const instance of layer.instances) {
        this.collectSid(instance.sid);
        this.trackUid(instance.uid);
      }
    }
    // Nonworld instances
    const nonworld = layout['nonworld-instances'];
    if (Array.isArray(nonworld)) {
      for (const inst of nonworld as Array<{ sid?: unknown; uid?: unknown }>) {
        this.collectSid(inst.sid);
        this.trackUid(inst.uid);
      }
    }
  }
}
