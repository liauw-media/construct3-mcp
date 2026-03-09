/**
 * SID and UID generator with collision avoidance.
 * Scans existing project IDs on first use, then generates unique new ones.
 */

import type { Construct3ProjectReader } from './project-reader.js';
import type { C3Event, Layout } from './types.js';

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
    this.scanContainerSids(project.rootFileFolders as unknown as Record<string, unknown>);

    // Scan all object types
    const objects = await reader.readAllObjectTypes();
    for (const [, obj] of objects) {
      this.collectSid(obj.sid);
      // Behavior SIDs
      if (Array.isArray(obj.behaviors)) {
        for (const b of obj.behaviors) {
          this.collectSid((b as Record<string, unknown>).sid as number);
        }
      }
      // Also check behaviorTypes (C3 uses this key)
      const behaviorTypes = (obj as Record<string, unknown>).behaviorTypes as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(behaviorTypes)) {
        for (const b of behaviorTypes) {
          this.collectSid(b.sid as number);
        }
      }
      // Instance variable SIDs
      const vars = (obj as Record<string, unknown>).instanceVariables;
      if (Array.isArray(vars)) {
        for (const v of vars as Array<Record<string, unknown>>) {
          this.collectSid(v.sid as number);
        }
      }
      // Animation SIDs
      const animations = (obj as Record<string, unknown>).animations;
      if (animations && typeof animations === 'object') {
        this.scanAnimationSids(animations as Record<string, unknown>);
      }
      // Singleglobal instance
      const sgi = (obj as Record<string, unknown>)['singleglobal-inst'] as Record<string, unknown> | undefined;
      if (sgi) {
        this.collectSid(sgi.sid as number);
        this.trackUid(sgi.uid as number);
      }
    }

    // Scan all event sheets
    const sheets = await reader.readAllEventSheets();
    for (const [, sheet] of sheets) {
      this.collectSid((sheet as unknown as Record<string, unknown>).sid as number);
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

  private scanContainerSids(rootFolders: Record<string, unknown>): void {
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

  private scanAnimationSids(animations: Record<string, unknown>): void {
    const items = animations.items as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(items)) {
      for (const anim of items) {
        this.collectSid(anim.sid);
        const frames = anim.frames as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(frames)) {
          for (const frame of frames) {
            this.collectSid(frame.sid);
            this.collectImageSpriteId(frame.imageSpriteId);
          }
        }
      }
    }
    const subfolders = animations.subfolders as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(subfolders)) {
      for (const sub of subfolders) {
        this.scanAnimationSids(sub);
      }
    }
  }

  private scanEventSids(events: C3Event[]): void {
    const stack = [...events];
    while (stack.length > 0) {
      const event = stack.pop()!;
      this.collectSid((event as Record<string, unknown>).sid);

      // Conditions & actions
      if ('conditions' in event && Array.isArray(event.conditions)) {
        for (const c of event.conditions) {
          this.collectSid(c.sid);
        }
      }
      if ('actions' in event && Array.isArray(event.actions)) {
        for (const a of event.actions) {
          this.collectSid((a as Record<string, unknown>).sid);
        }
      }

      // Function parameters
      if ('parameters' in event && Array.isArray(event.parameters)) {
        for (const p of event.parameters as Array<Record<string, unknown>>) {
          this.collectSid(p.sid);
        }
      }
      // Also check functionParameters
      const funcParams = (event as Record<string, unknown>).functionParameters;
      if (Array.isArray(funcParams)) {
        for (const p of funcParams as Array<Record<string, unknown>>) {
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
    const nonworld = (layout as Record<string, unknown>)['nonworld-instances'] as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(nonworld)) {
      for (const inst of nonworld) {
        this.collectSid(inst.sid);
        this.trackUid(inst.uid);
      }
    }
  }
}
