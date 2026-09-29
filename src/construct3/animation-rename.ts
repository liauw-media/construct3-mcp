/**
 * What else changes when a Sprite animation is renamed.
 *
 * Frame image files: the editor names a frame's image
 * lower("<object>-<animation>-<NNN>.<ext>"), NNN being the frame's index in
 * the animation (3 digits) and ext "jpg" for a JPEG frame (fileType
 * "image/jpeg"), "png" otherwise (also when fileType is missing). The
 * animation's folder and the frames' imageSpriteId are not part of the name.
 * Checked on Scirra's public example projects
 * (github.com/Scirra/Construct-Example-Projects: 20,185 of 20,185 frames,
 * 1,651 of them in animation folders, 4,040 without fileType) and on
 * editor-saved r449 projects (5,146 of 5,146 frames, 17 of them JPEG). So a
 * renamed animation's images have to be renamed too, or the editor no longer
 * finds them. images/ can also hold files the frames no longer use under such
 * names (seen in editor-saved projects: a PNG next to a JPEG frame's file of
 * the same name, and files for frame indexes past the last frame); they are
 * left as they are.
 *
 * An editor rename seen in an editor-saved project's history renamed every
 * frame file (same content, no file left under the old name), changed nothing
 * in the object JSON but the animation's name (sid, frames and imageSpriteIds
 * kept), set "initial-animation" of the object's layout instances that named
 * the old animation to the new name, and left a string naming the old
 * animation in an event sheet as it was.
 *
 * Since the file name holds the frame's index, inserting or deleting a frame
 * renumbers the image files of the frames after it too: they move one index
 * up or down with their frames (planFrameImageShift), or every later frame
 * would show its neighbour's image.
 *
 * Layout instances: every Sprite instance names an animation of its object
 * in "initial-animation" (20,833 of 20,833 in the public examples, 2,494 of
 * 2,494 in the editor-saved projects, sub-layers included).
 */

import { getImageFileName } from './png-generator.js';
import { forEachLayoutInstance } from './layers.js';

/** A file in images/ to rename (names relative to images/). */
export interface ImageFileRename {
  from: string;
  to: string;
}

/** The image file renames that go with an animation rename. */
export interface FrameImageRenamePlan {
  renames: ImageFileRename[];
  /** Expected file names of frames that have no image file (nothing to rename for them) */
  missing: string[];
  /** Target names already taken by other files (renaming would replace them) */
  clashes: string[];
}

/**
 * Extension of a Sprite frame's image file: "jpg" for a JPEG frame, "png" for
 * a PNG frame or one without fileType; undefined for any other fileType (none
 * seen in editor-saved projects or the public examples).
 */
export function frameImageExtension(fileType: unknown): 'jpg' | 'png' | undefined {
  if (fileType === 'image/jpeg') return 'jpg';
  if (fileType === 'image/png' || fileType === undefined) return 'png';
  return undefined;
}

/** A frame's image file name without the extension, e.g. "hero-walk-000". */
export function frameImageBaseName(objectName: string, animationName: string, frameIndex: number): string {
  return getImageFileName(objectName, animationName, frameIndex, 'Sprite').replace(/\.png$/, '');
}

/**
 * The file name a frame's image is expected under, e.g. "hero-walk-001.jpg":
 * `base` (from frameImageBaseName) with the extension of the frame's
 * fileType, "*" for a fileType without a known extension.
 */
export function expectedFrameImageName(base: string, fileType: unknown): string {
  return `${base}.${frameImageExtension(fileType) ?? '*'}`;
}

/** The files of a listing of images/, looked up ignoring case. */
export interface ImageFileIndex {
  /** The files whose lowercase name is `lowerName` (several only on a case-sensitive file system) */
  named(lowerName: string): string[];
  /**
   * The files that hold the image of the frame whose file name without
   * extension is `base` (lowercase): the file its fileType points to; for
   * another fileType, every file named `base` with a single extension.
   */
  frameFiles(base: string, fileType: unknown): string[];
}

/** Index a listing of images/ (file names) for lookups that ignore case. */
export function indexImageFiles(files: readonly string[]): ImageFileIndex {
  const byLowerName = new Map<string, string[]>();
  const byStem = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, key: string, file: string) => {
    const list = map.get(key);
    if (list) list.push(file); else map.set(key, [file]);
  };
  for (const file of files) {
    const lower = file.toLowerCase();
    add(byLowerName, lower, file);
    // "hero-walk-000.gif" has the stem "hero-walk-000", "hero-walk-000.png.bak" has none that a frame uses
    const dot = lower.lastIndexOf('.');
    if (dot > 0 && dot < lower.length - 1) add(byStem, lower.slice(0, dot), file);
  }
  return {
    named: lowerName => byLowerName.get(lowerName) ?? [],
    frameFiles: (base, fileType) => {
      const extension = frameImageExtension(fileType);
      return extension !== undefined ? byLowerName.get(`${base}.${extension}`) ?? [] : byStem.get(base) ?? [];
    },
  };
}

/**
 * Plan the renames of an animation's frame image files when it is renamed
 * from `oldName` to `newName`. `files` lists images/. Each frame's file is
 * the one its fileType points to, found ignoring case (so a mixed-case name
 * written by older versions of these tools is found too), and gets the
 * lowercase name for `newName`. For a frame of another format, every file
 * with the frame's name and a single extension is renamed, keeping the
 * extension. Only files of existing frames are renamed.
 */
export function planFrameImageRenames(
  files: readonly string[],
  objectName: string,
  oldName: string,
  newName: string,
  frames: ReadonlyArray<{ fileType?: unknown }>,
): FrameImageRenamePlan {
  const index = indexImageFiles(files);

  const plan: FrameImageRenamePlan = { renames: [], missing: [], clashes: [] };
  frames.forEach((frame, frameIndex) => {
    const oldBase = frameImageBaseName(objectName, oldName, frameIndex);
    const newBase = frameImageBaseName(objectName, newName, frameIndex);
    const sources = index.frameFiles(oldBase, frame?.fileType);
    if (sources.length === 0) {
      plan.missing.push(expectedFrameImageName(oldBase, frame?.fileType));
      return;
    }
    for (const from of sources) {
      const to = `${newBase}.${from.slice(oldBase.length + 1).toLowerCase()}`;
      if (from === to) continue;
      // Another file under the target name (any case) would be replaced, or
      // two files that differ only in case would get the same name
      if (index.named(to).some(file => file !== from) || plan.renames.some(r => r.to === to)) {
        plan.clashes.push(to);
        continue;
      }
      plan.renames.push({ from, to });
    }
  });
  return plan;
}

/** A frame inserted at index `insertAt` (0 to the frame count), or the frame at `deleteAt` deleted. */
export type FrameListChange = { insertAt: number } | { deleteAt: number };

/** The image file renames that go with inserting or deleting a frame. */
export interface FrameImageShiftPlan {
  /**
   * Every rename, in the order to apply them: each target name is free when
   * its rename runs (a name another rename moved away before counts as free).
   * Undo them in reverse order.
   */
  renames: ImageFileRename[];
  /** Image files of later frames moved one index up (insert) or down (delete), in `renames` */
  shifted: ImageFileRename[];
  /** Image files of the deleted frame, kept under a .bak name, in `renames` */
  parked: ImageFileRename[];
  /**
   * Files no frame uses under a name a moved image or the new frame's image
   * takes (e.g. an image left behind by a deleted frame), kept under a .bak
   * name instead of being replaced, in `renames`
   */
  backedUp: ImageFileRename[];
  /** Expected file names of moved frames that have no image file (nothing moved for them) */
  missing: string[];
  /** Name of the new frame's image file (insert only; the name is free once `renames` ran) */
  newFrameFile?: string;
  /** Why the renames cannot be applied (nothing may be changed then) */
  clashes: string[];
}

/**
 * Plan the image file renames that keep an animation's frames and their
 * images together when a frame is inserted or deleted. `files` lists images/,
 * `frames` are the animation's frames before the change. Each frame's files
 * are found as for a rename (planFrameImageRenames: its fileType's
 * extension, or for another fileType every file with its name and a single
 * extension, ignoring case) and move to the lowercase name of their new
 * index, keeping the extension.
 *
 * - Insert at k: the files of frames k..n-1 move one index up, the last
 *   first; the new frame's image then goes under the name of index k.
 * - Delete at k: the deleted frame's files are renamed to <file>.bak (kept,
 *   not deleted), then the files of frames k+1..n-1 move one index down.
 *
 * No existing file is replaced: a file that no frame uses but that has a
 * name a moved image or the new frame's image needs is renamed to <file>.bak
 * first (<file>.1.bak, … when that name is taken too).
 */
export function planFrameImageShift(
  files: readonly string[],
  objectName: string,
  animationName: string,
  frames: ReadonlyArray<{ fileType?: unknown } | null | undefined>,
  change: FrameListChange,
): FrameImageShiftPlan {
  const index = indexImageFiles(files);
  const base = (frameIndex: number) => frameImageBaseName(objectName, animationName, frameIndex);
  const plan: FrameImageShiftPlan = { renames: [], shifted: [], parked: [], backedUp: [], missing: [], clashes: [] };

  // Every name in images/ so far, and those the renames produce, ignoring case (for free .bak names)
  const taken = new Set(files.map(f => f.toLowerCase()));
  const backupName = (file: string): string => {
    for (let n = 0; ; n++) {
      const name = n === 0 ? `${file}.bak` : `${file}.${n}.bak`;
      if (!taken.has(name.toLowerCase())) {
        taken.add(name.toLowerCase());
        return name;
      }
    }
  };

  const move = (from: number, to: number) => {
    const fileType = frames[from]?.fileType;
    const sources = index.frameFiles(base(from), fileType);
    if (sources.length === 0) plan.missing.push(expectedFrameImageName(base(from), fileType));
    for (const file of sources) {
      const target = `${base(to)}.${file.slice(base(from).length + 1).toLowerCase()}`;
      plan.shifted.push({ from: file, to: target });
      taken.add(target);
    }
  };

  if ('insertAt' in change) {
    for (let i = frames.length - 1; i >= change.insertAt; i--) move(i, i + 1);
    plan.newFrameFile = getImageFileName(objectName, animationName, change.insertAt, 'Sprite');
  } else {
    for (const file of index.frameFiles(base(change.deleteAt), frames[change.deleteAt]?.fileType)) {
      plan.parked.push({ from: file, to: backupName(file) });
    }
    for (let i = change.deleteAt + 1; i < frames.length; i++) move(i, i - 1);
  }

  // Files in the way: named like a target, but not moved themselves
  const moved = new Set([...plan.parked, ...plan.shifted].map(r => r.from));
  const targets = [...plan.shifted.map(r => r.to), ...(plan.newFrameFile !== undefined ? [plan.newFrameFile] : [])];
  for (const target of targets) {
    for (const file of index.named(target.toLowerCase())) {
      if (!moved.has(file) && !plan.backedUp.some(r => r.from === file)) {
        plan.backedUp.push({ from: file, to: backupName(file) });
      }
    }
  }
  plan.renames = [...plan.backedUp, ...plan.parked, ...plan.shifted];
  const result = simulateImageRenames(files, plan.renames);
  plan.clashes = result.clashes.map(c => `images/${c.from} cannot be renamed to images/${c.to}: images/${c.occupant} would be replaced`);
  if (plan.newFrameFile !== undefined && plan.clashes.length === 0) {
    const occupant = result.present.get(plan.newFrameFile.toLowerCase())?.[0];
    if (occupant !== undefined) plan.clashes.push(`images/${occupant} would be replaced by the new frame's image`);
  }
  return plan;
}

/** A rename whose target name is taken by another file when it would run. */
export interface ImageRenameClash extends ImageFileRename {
  /** The file under the target name (ignoring case) */
  occupant: string;
  /** Whether an earlier rename of the list put `occupant` there */
  renamedThere: boolean;
}

/**
 * Apply `renames` in order to a listing of images/, comparing names ignoring
 * case (as Windows and macOS do): a target name is free when no file has it
 * at that point, also when an earlier rename moved its file away. Returns the
 * renames whose target is taken by another file (these are skipped) and the
 * files present afterwards by lowercase name.
 */
export function simulateImageRenames(
  files: readonly string[],
  renames: readonly ImageFileRename[],
): { clashes: ImageRenameClash[]; present: Map<string, string[]> } {
  const present = new Map<string, string[]>();
  const add = (file: string) => present.set(file.toLowerCase(), [...(present.get(file.toLowerCase()) ?? []), file]);
  files.forEach(add);
  const renamedThere = new Set<string>();
  const clashes: ImageRenameClash[] = [];
  for (const { from, to } of renames) {
    const occupant = (present.get(to.toLowerCase()) ?? []).find(file => file !== from);
    if (occupant !== undefined) {
      clashes.push({ from, to, occupant, renamedThere: renamedThere.has(occupant) });
      continue;
    }
    const left = (present.get(from.toLowerCase()) ?? []).filter(file => file !== from);
    if (left.length > 0) present.set(from.toLowerCase(), left); else present.delete(from.toLowerCase());
    add(to);
    renamedThere.add(to);
  }
  return { clashes, present };
}

/** An animation of a Sprite's "animations" container and where it is. */
export interface AnimationEntry<T = Record<string, unknown>> {
  animation: T;
  /** The items list that holds it: the container's, or an animation folder's */
  items: T[];
  /** Names of the animation folders it is in, outermost first (empty at the top level) */
  folders: string[];
}

/**
 * Every animation of a Sprite's "animations" container, those in animation
 * folders (subfolders, at any depth) included: the top-level items first,
 * then each folder's, depth-first.
 */
export function animationEntries<T = Record<string, unknown>>(container: unknown): Array<AnimationEntry<T>> {
  const out: Array<AnimationEntry<T>> = [];
  const walk = (node: unknown, folders: string[]) => {
    if (typeof node !== 'object' || node === null) return;
    const { items, subfolders } = node as { items?: unknown; subfolders?: unknown };
    if (Array.isArray(items)) {
      for (const item of items) {
        if (typeof item === 'object' && item !== null) out.push({ animation: item as T, items: items as T[], folders });
      }
    }
    if (Array.isArray(subfolders)) {
      for (const folder of subfolders) {
        const name = typeof folder === 'object' && folder !== null ? (folder as { name?: unknown }).name : undefined;
        walk(folder, [...folders, typeof name === 'string' ? name : '?']);
      }
    }
  };
  walk(container, []);
  return out;
}

/** Every animation of a Sprite's "animations" container, those in animation folders included. */
export function everyAnimation<T = Record<string, unknown>>(container: unknown): T[] {
  return animationEntries<T>(container).map(entry => entry.animation);
}

/**
 * The animation named `name` (exactly) in a Sprite's "animations" container,
 * in any animation folder, with the items list that holds it; the first one
 * in animationEntries order if the name is used twice.
 */
export function findAnimation<T = Record<string, unknown>>(container: unknown, name: string): AnimationEntry<T> | undefined {
  return animationEntries<T>(container).find(entry => (entry.animation as { name?: unknown }).name === name);
}

/**
 * The animation names of a Sprite for a "not found" message: an animation in
 * an animation folder is shown with its folder path ("Moves/Walk"), followed
 * by a note that the tools take the name alone.
 */
export function describeAvailableAnimations(container: unknown): string {
  const entries = animationEntries(container);
  const names = entries.map(entry => [...entry.folders, String(entry.animation.name)].join('/'));
  const note = entries.some(entry => entry.folders.length > 0)
    ? ' (animations in animation folders are shown with their folder path; pass the animation name alone)'
    : '';
  return `${names.join(', ')}${note}`;
}

/**
 * The other animations of the object (in any animation folder) that use
 * frame image files of `animation`: they have frames, and their names differ
 * from its name only in case (image file names are lowercase). None of the
 * editor-saved projects checked has such a pair, but older versions of these
 * tools could create one.
 */
export function animationsSharingImageFiles(container: unknown, animation: { name: string }): string[] {
  const lower = animation.name.toLowerCase();
  return everyAnimation(container)
    .filter(a => a !== animation && typeof a.name === 'string' && a.name.toLowerCase() === lower
      && Array.isArray(a.frames) && a.frames.length > 0)
    .map(a => a.name as string);
}

/**
 * Set "initial-animation" to `newName` on the instances of `objectName` in
 * `layout` that name `oldName`. Returns how many instances changed; with
 * `newName` undefined, only counts them.
 */
export function renameInitialAnimation(
  layout: unknown,
  objectName: string,
  oldName: string,
  newName?: string,
): number {
  let count = 0;
  forEachLayoutInstance(layout, instance => {
    if (instance.type !== objectName) return;
    const properties = instance.properties;
    if (typeof properties !== 'object' || properties === null) return;
    const props = properties as Record<string, unknown>;
    if (props['initial-animation'] !== oldName) return;
    count++;
    if (newName !== undefined) props['initial-animation'] = newName;
  });
  return count;
}

/** Names of the families in `families` (as read by readAllFamilies) that list `objectName` as a member. */
export function familiesContaining(objectName: string, families: ReadonlyMap<string, unknown>): string[] {
  const names: string[] = [];
  for (const [name, family] of families) {
    const members = typeof family === 'object' && family !== null ? (family as { members?: unknown }).members : undefined;
    if (Array.isArray(members) && members.includes(objectName)) names.push(name);
  }
  return names;
}

/**
 * How many condition/action parameters of `objectClasses` (the object, and
 * the families it belongs to, whose conditions and actions can name its
 * animations too) in an event sheet are the string expression naming
 * `animationName` (e.g. "Set animation" with `"Walk"`). A rename leaves them
 * as they are. Parameters that compute a name (e.g. `"Walk" & n`) are not
 * counted, so this is a lower bound.
 */
export function countAnimationNameParameters(
  sheet: unknown,
  objectClasses: string | readonly string[],
  animationName: string,
): number {
  const classes = new Set(typeof objectClasses === 'string' ? [objectClasses] : objectClasses);
  const expression = `"${animationName}"`;
  let count = 0;
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    const record = node as Record<string, unknown>;
    if (typeof record.objectClass === 'string' && classes.has(record.objectClass)
      && typeof record.parameters === 'object' && record.parameters !== null) {
      for (const value of Object.values(record.parameters as Record<string, unknown>)) {
        if (value === expression) count++;
      }
    }
    for (const value of Object.values(record)) {
      if (typeof value === 'object' && value !== null) visit(value);
    }
  };
  visit(sheet);
  return count;
}
