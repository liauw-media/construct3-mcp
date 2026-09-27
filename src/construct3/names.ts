/**
 * Name comparison that ignores case, the way the Construct 3 editor compares
 * most project names.
 *
 * The editor (projectResources.js of release r495.2) treats two names as the
 * same when `a === b || a.normalize().toLowerCase() === b.normalize().toLowerCase()`
 * and refuses such a name as "already used" for layouts and event sheets
 * (project-wide), object classes (object types and families share one
 * namespace), the layers of one layout (sub-layers included), the animations
 * of one object (in any animation folder), event variables (in the scope
 * described in event-variable-names.ts) and sibling project-bar folders (r449
 * does the same). Timeline names are the exception:
 * the editor compares them exactly.
 *
 * Independently of the editor, every entity file is named after its entity
 * (<category>/<folders>/<name>.json, folders mirroring the project bar), and
 * names that differ only in case name the same file on Windows and on
 * default macOS file systems.
 */

/** Comparison key for a name: Unicode-normalized (NFC) and lowercased. */
export function nameKey(name: string): string {
  return name.normalize().toLowerCase();
}

/**
 * The name in `existing` that equals `name` ignoring case (the exact name when
 * it is there), or undefined.
 */
export function findNameClash(name: string, existing: Iterable<string>): string | undefined {
  const key = nameKey(name);
  let clash: string | undefined;
  for (const candidate of existing) {
    if (candidate === name) return candidate;
    if (clash === undefined && nameKey(candidate) === key) clash = candidate;
  }
  return clash;
}

/** A project-bar folder container or folder as stored in project.c3proj. */
interface FolderNode {
  name?: unknown;
  subfolders?: unknown;
}

function namedSubfolders(node: FolderNode | undefined): Array<FolderNode & { name: string }> {
  if (!node || !Array.isArray(node.subfolders)) return [];
  return (node.subfolders as FolderNode[]).filter(
    (f): f is FolderNode & { name: string } => !!f && typeof f.name === 'string' && f.name !== '',
  );
}

/**
 * Check a "/"-separated project-bar folder path against the folders of
 * `container`. When one of its folders differs from an existing sibling folder
 * only in case, returns the path spelled the way the existing folders are
 * (new folders keep the requested spelling); otherwise undefined. Folders
 * without a name (the timelines Transitions folder) are skipped.
 */
export function findFolderPathClash(container: FolderNode | undefined, path: string): string | undefined {
  const spelled: string[] = [];
  let clash = false;
  let node: FolderNode | undefined = container;
  for (const part of path.split('/')) {
    const siblings = namedSubfolders(node);
    const match = findNameClash(part, siblings.map(f => f.name));
    if (match === undefined) {
      spelled.push(part);
      node = undefined;
      continue;
    }
    if (match !== part) clash = true;
    spelled.push(match);
    node = siblings.find(f => f.name === match);
  }
  return clash ? spelled.join('/') : undefined;
}
