/**
 * The editor's Transitions folder in the project.c3proj timelines container.
 *
 * Construct 3 writes the timelines container with one first-level subfolder
 * that has no "name" key: its Transitions folder. It is often empty; its items
 * are transitions (easing curves that timelines reference by name), stored in
 * timelines/transitions/<name>.json. Checked against editor-saved projects.
 * Shared by the timeline tools and validate_project.
 */

/** Folder on disk, below timelines/, that holds the editor's transitions. */
export const TRANSITIONS_DIR = 'transitions';

/** A project-bar folder node as found in project.c3proj (fields unchecked). */
export type ProjectFolderNode = { name?: unknown; items?: unknown; subfolders?: unknown };

/** True when a project-bar folder has no usable name (missing or empty). */
export function isNamelessFolder(folder: ProjectFolderNode): boolean {
  return typeof folder.name !== 'string' || folder.name === '';
}

/**
 * Index of the Transitions folder among the first-level subfolders of the
 * timelines container: the first one without a name, or -1. A second nameless
 * first-level folder, or a nameless folder nested deeper, is not the
 * Transitions folder but a malformed entry.
 */
export function transitionsFolderIndex(timelines: ProjectFolderNode | undefined): number {
  if (!timelines || !Array.isArray(timelines.subfolders)) return -1;
  return (timelines.subfolders as unknown[]).findIndex(
    sf => typeof sf === 'object' && sf !== null && isNamelessFolder(sf as ProjectFolderNode)
  );
}
