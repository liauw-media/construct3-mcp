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
function frameImageBaseName(objectName: string, animationName: string, frameIndex: number): string {
  return getImageFileName(objectName, animationName, frameIndex, 'Sprite').replace(/\.png$/, '');
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
  const byLowerName = new Map<string, string[]>();
  for (const file of files) {
    const lower = file.toLowerCase();
    const list = byLowerName.get(lower);
    if (list) list.push(file); else byLowerName.set(lower, [file]);
  }

  const plan: FrameImageRenamePlan = { renames: [], missing: [], clashes: [] };
  frames.forEach((frame, index) => {
    const oldBase = frameImageBaseName(objectName, oldName, index);
    const newBase = frameImageBaseName(objectName, newName, index);
    const extension = frameImageExtension(frame?.fileType);
    const sources = extension !== undefined
      ? byLowerName.get(`${oldBase}.${extension}`) ?? []
      : files.filter(file => {
        const lower = file.toLowerCase();
        return lower.startsWith(`${oldBase}.`) && /^[^.]+$/.test(lower.slice(oldBase.length + 1));
      });
    if (sources.length === 0) {
      plan.missing.push(`${oldBase}.${extension ?? '*'}`);
      return;
    }
    for (const from of sources) {
      const to = `${newBase}.${from.slice(oldBase.length + 1).toLowerCase()}`;
      if (from === to) continue;
      // Another file under the target name (any case) would be replaced, or
      // two files that differ only in case would get the same name
      if ((byLowerName.get(to) ?? []).some(file => file !== from) || plan.renames.some(r => r.to === to)) {
        plan.clashes.push(to);
        continue;
      }
      plan.renames.push({ from, to });
    }
  });
  return plan;
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
