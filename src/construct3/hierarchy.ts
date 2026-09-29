/**
 * Hierarchy (scene graph) links between layout instances.
 *
 * The editor stores both sides of a link in `sceneGraphData` on the world
 * instances of one layout: the child has `"parent-uid"` (the parent's UID;
 * null on an instance without a parent) and its own `flags`, the parent lists
 * `{ uid, flags }` for each child in `children`, an array that is absent when
 * it has no children. Checked against Scirra's public example projects
 * (github.com/Scirra/Construct-Example-Projects: three-cups, rotating-maze,
 * blacksmith-forge, dig-the-way and dock-fishing, 33 instances with
 * sceneGraphData): no empty `children` array, children on another layer than
 * their parent (3 in three-cups), one record with neither a parent nor
 * children (rotating-maze), none on non-world instances.
 *
 * Links go by UID, and UIDs are reused: a new instance gets the highest UID in
 * the project plus one, so after the instance with the highest UID is deleted,
 * the next new instance gets its UID. A link left pointing at a deleted
 * instance would then point at the new one. Deleting instances therefore
 * removes the links to them (unlinkRemovedInstances), and the ID generator
 * counts the UIDs that links name (hierarchyUids).
 */

import type { Instance, Layout } from './types.js';
import { forEachLayoutInstance, type LayerEntry } from './layers.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An instance's sceneGraphData record, or undefined when it has none. */
export function sceneGraphOf(instance: unknown): Record<string, unknown> | undefined {
  return isRecord(instance) && isRecord(instance.sceneGraphData) ? instance.sceneGraphData : undefined;
}

/** The parent UID a sceneGraphData record names, or undefined for none (null or missing). */
function parentUidOf(sceneGraph: Record<string, unknown>): number | undefined {
  const parent = sceneGraph['parent-uid'];
  return typeof parent === 'number' ? parent : undefined;
}

/** The child UIDs a sceneGraphData record lists. */
function childUidsOf(sceneGraph: Record<string, unknown>): number[] {
  const children = sceneGraph.children;
  if (!Array.isArray(children)) return [];
  return children
    .map(child => (isRecord(child) ? child.uid : undefined))
    .filter((uid): uid is number => typeof uid === 'number');
}

/** Every UID a hierarchy link of this instance names: its parent and its children. */
export function hierarchyUids(instance: unknown): number[] {
  const sceneGraph = sceneGraphOf(instance);
  if (!sceneGraph) return [];
  const parent = parentUidOf(sceneGraph);
  return [...(parent !== undefined ? [parent] : []), ...childUidsOf(sceneGraph)];
}

/** What unlinkRemovedInstances changed on the instances left in the layout. */
export interface HierarchyUnlink {
  /** UIDs of instances whose parent was removed: they no longer have a parent */
  detachedChildren: number[];
  /** UIDs of instances that listed a removed instance as a child: the entry was removed */
  updatedParents: number[];
}

/**
 * Remove the hierarchy links to instances that were removed from `layout`
 * (`removed`: their UIDs, the instances already taken out of the layout): an
 * instance whose parent was removed gets `"parent-uid": null` (it stays in
 * the layout, without a parent), and a removed child is taken out of its
 * parent's `children` (an emptied array is removed, as the editor saves a
 * parent without children). Children are detached, not deleted with their
 * parent: what the editor does with the children of an instance deleted in
 * the Layout View is not verified, and detaching loses no instance.
 */
export function unlinkRemovedInstances(layout: Layout, removed: ReadonlySet<number>): HierarchyUnlink {
  const result: HierarchyUnlink = { detachedChildren: [], updatedParents: [] };
  if (removed.size === 0) return result;
  forEachLayoutInstance(layout, instance => {
    const sceneGraph = sceneGraphOf(instance);
    if (!sceneGraph) return;
    const parent = parentUidOf(sceneGraph);
    if (parent !== undefined && removed.has(parent)) {
      sceneGraph['parent-uid'] = null;
      if (typeof instance.uid === 'number') result.detachedChildren.push(instance.uid);
    }
    if (Array.isArray(sceneGraph.children)) {
      const kept = sceneGraph.children.filter(child => !(isRecord(child) && typeof child.uid === 'number' && removed.has(child.uid)));
      if (kept.length !== sceneGraph.children.length) {
        if (kept.length > 0) sceneGraph.children = kept;
        else delete sceneGraph.children;
        if (typeof instance.uid === 'number') result.updatedParents.push(instance.uid);
      }
    }
  });
  return result;
}

/** The warning sentences for what unlinkRemovedInstances changed; empty when nothing. */
export function hierarchyUnlinkWarnings(unlink: HierarchyUnlink): string[] {
  const warnings: string[] = [];
  if (unlink.detachedChildren.length > 0) {
    warnings.push(`Detached hierarchy children of the removed instance(s): UID ${unlink.detachedChildren.join(', ')} ` +
      '(they stay in the layout, without a parent).');
  }
  if (unlink.updatedParents.length > 0) {
    warnings.push(`Removed the hierarchy links from UID ${unlink.updatedParents.join(', ')} to the removed instance(s).`);
  }
  return warnings;
}

/** A hierarchy link that does not hold up, for validate_project. */
export interface HierarchyLinkProblem {
  /** UID of the instance whose record has the link */
  uid: number;
  type: string;
  /** Its layer; undefined for a non-world instance */
  entry?: LayerEntry;
  /**
   * - "missing-parent": "parent-uid" names no instance of the layout
   * - "missing-child": a `children` entry names no instance of the layout
   * - "parent-not-linked": the parent does not list this instance as a child
   * - "child-not-linked": the child names another parent, or none
   */
  problem: 'missing-parent' | 'missing-child' | 'parent-not-linked' | 'child-not-linked';
  /** The UID the link names */
  target: number;
}

/**
 * Hierarchy links in one layout that point at no instance of the layout, or
 * whose other side does not name this instance (e.g. a link left behind when
 * an instance was deleted, which a reused UID then points at another
 * instance). Each broken link is reported once, from the side that has it.
 */
export function findHierarchyLinkProblems(layout: unknown): HierarchyLinkProblem[] {
  const byUid = new Map<number, Instance>();
  forEachLayoutInstance(layout, instance => {
    if (typeof instance.uid === 'number' && !byUid.has(instance.uid)) byUid.set(instance.uid, instance);
  });
  const problems: HierarchyLinkProblem[] = [];
  forEachLayoutInstance(layout, (instance, entry) => {
    const sceneGraph = sceneGraphOf(instance);
    if (!sceneGraph || typeof instance.uid !== 'number') return;
    const base = { uid: instance.uid, type: String(instance.type), ...(entry ? { entry } : {}) };
    const parent = parentUidOf(sceneGraph);
    if (parent !== undefined) {
      const parentGraph = sceneGraphOf(byUid.get(parent));
      if (!byUid.has(parent)) problems.push({ ...base, problem: 'missing-parent', target: parent });
      else if (!parentGraph || !childUidsOf(parentGraph).includes(instance.uid)) {
        problems.push({ ...base, problem: 'parent-not-linked', target: parent });
      }
    }
    for (const child of childUidsOf(sceneGraph)) {
      const childInstance = byUid.get(child);
      if (!childInstance) {
        problems.push({ ...base, problem: 'missing-child', target: child });
        continue;
      }
      // A link the child has to another parent is checked (and reported) from the child's side
      const childGraph = sceneGraphOf(childInstance);
      const childParent = childGraph ? parentUidOf(childGraph) : undefined;
      if (childParent !== instance.uid) {
        problems.push({ ...base, problem: 'child-not-linked', target: child });
      }
    }
  });
  return problems;
}
