/**
 * The image files of an object type in images/.
 *
 * A Sprite's frames are stored as lower("<object>-<animation>-NNN.<ext>")
 * (see animation-rename.ts); an object type that saves one `image` instead of
 * animations (Tiled Background, 9-patch, Particles, Sprite font, ...) as
 * lower("<object>.<ext>"), ext following the image's fileType. Checked on
 * Scirra's public example projects (github.com/Scirra/Construct-Example-Projects,
 * winter-tree: "branch.png" for the Tiled Background "Branch", next to
 * "background-animation 1-000.png" for the Sprite "Background").
 *
 * Deleting an object type leaves these files without a user. delete_object
 * keeps them as <file>.bak (as the frame tools keep the image of a deleted
 * frame), and validate_project reports files in images/ named after no object
 * type (orphaned-image).
 */

import { everyAnimation, frameImageBaseName, indexImageFiles, type ImageFileIndex, type ImageFileRename } from './animation-rename.js';
import { nameKey } from './names.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The files of `files` (a listing of images/) that hold the frames or the
 * single image of the object type `objectName` (its name as stored in its
 * file, which the editor names the files after), in frame order. Found as
 * the frame tools find them: by the frame's fileType extension, ignoring case
 * and Unicode normalization; for another fileType, every file with the name
 * and a single extension. `index` is indexImageFiles(files), for a caller
 * that looks up several object types in the same listing (built here when
 * not given).
 */
export function objectImageFiles(
  objectName: string,
  objectType: unknown,
  files: readonly string[],
  index: ImageFileIndex = indexImageFiles(files),
): string[] {
  if (!isRecord(objectType)) return [];
  const found: string[] = [];
  if (objectType.animations !== undefined) {
    for (const anim of everyAnimation<{ name?: unknown; frames?: unknown }>(objectType.animations)) {
      if (typeof anim.name !== 'string' || !Array.isArray(anim.frames)) continue;
      anim.frames.forEach((frame, i) => {
        const fileType = isRecord(frame) ? frame.fileType : undefined;
        found.push(...index.frameFiles(frameImageBaseName(objectName, anim.name as string, i), fileType));
      });
    }
  } else if (isRecord(objectType.image)) {
    found.push(...index.frameFiles(objectName.toLowerCase(), objectType.image.fileType));
  }
  return [...new Set(found)];
}

/**
 * Whether a file in images/ is named after the object type `objectName`: a
 * frame "<object>-..." or a single image "<object>.<ext>", ignoring case and
 * Unicode normalization.
 */
export function isNamedAfterObject(file: string, objectName: string): boolean {
  const key = nameKey(file);
  const object = nameKey(objectName);
  return key.startsWith(`${object}-`) || key.startsWith(`${object}.`);
}

/**
 * isNamedAfterObject for many object names at once: a test whether a file is
 * named after any of `objectNames`. The names go into a set once, and a file
 * is looked up by each part of its name before a "-" or ".", so testing every
 * file of images/ takes time in proportion to the files and names, not to
 * their product (validate_project's orphaned-image check).
 */
export function namedAfterAnyObject(objectNames: Iterable<string>): (file: string) => boolean {
  const objects = new Set<string>();
  for (const name of objectNames) objects.add(nameKey(name));
  return file => {
    const key = nameKey(file);
    for (let i = 0; i < key.length; i++) {
      if ((key[i] === '-' || key[i] === '.') && objects.has(key.slice(0, i))) return true;
    }
    return false;
  };
}

/** How delete_object keeps the image files of the object type it deletes. */
export interface ObjectImageParking {
  /** Renames of the object's image files to free .bak names */
  renames: ImageFileRename[];
  /** Files of the object that another object type uses as well (same name), left in place */
  shared: string[];
  /**
   * Files of the object that are named after an object type whose file could
   * not be parsed (its images are unknown, it may use them), left in place
   */
  unknownUse: string[];
}

/**
 * Plan keeping the image files of `objectName` as <file>.bak: every file its
 * frames or single image use (objectImageFiles), except files another object
 * type in `others` uses too (the same name, e.g. object "a-b" animation "c"
 * and object "a" animation "b-c") and files named after an object type in
 * `unparsed` (registered, but its file could not be parsed). The .bak name is
 * <file>.bak, or <file>.1.bak, ... when that is taken, compared ignoring case.
 * The listing is indexed once for all object types, so the plan takes time in
 * proportion to the files and frames, not to their product.
 */
export function planObjectImageParking(
  objectName: string,
  objectType: unknown,
  files: readonly string[],
  others: ReadonlyMap<string, unknown>,
  unparsed: readonly string[],
): ObjectImageParking {
  const index = indexImageFiles(files);
  const own = objectImageFiles(objectName, objectType, files, index);
  const plan: ObjectImageParking = { renames: [], shared: [], unknownUse: [] };
  if (own.length === 0) return plan;

  const usedByOthers = new Set<string>();
  for (const [name, other] of others) {
    const stored = isRecord(other) && typeof other.name === 'string' && other.name !== '' ? other.name : name;
    for (const file of objectImageFiles(stored, other, files, index)) usedByOthers.add(file);
  }
  const taken = new Set(files.map(nameKey));
  const backupName = (file: string): string => {
    for (let n = 0; ; n++) {
      const name = n === 0 ? `${file}.bak` : `${file}.${n}.bak`;
      if (!taken.has(nameKey(name))) {
        taken.add(nameKey(name));
        return name;
      }
    }
  };
  const namedAfterUnparsed = namedAfterAnyObject(unparsed);
  for (const file of own) {
    if (usedByOthers.has(file)) plan.shared.push(file);
    else if (namedAfterUnparsed(file)) plan.unknownUse.push(file);
    else plan.renames.push({ from: file, to: backupName(file) });
  }
  return plan;
}
