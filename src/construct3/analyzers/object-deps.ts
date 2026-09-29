/**
 * Object dependency graph analysis.
 */

import type { Construct3ProjectReader } from '../project-reader.js';
import type { ObjectDependencyNode } from '../types.js';
import { getProjectIndex, type ProjectIndex } from './index-builder.js';
import { searchUnscannedFiles, type UnscannedFileReport } from './unscanned-uses.js';
import { nameTerm, numberTerm, type RawTextTerm } from '../raw-text-search.js';

/** A file the index could not parse, and whether its text search found anything (no `names`: see the objects) */
export type UnscannedFileSummary = Omit<UnscannedFileReport, 'names'>;

export interface ObjectDependencyResult {
  object?: ObjectDependencyNode;
  projectWide?: {
    topConnected: ObjectDependencyNode[];
    /** Objects nothing refers to; objects whose name is in a file that could not be parsed are in possiblyUsedObjects instead */
    orphanedObjects: string[];
    /** Orphans that are members of a family, with those families: delete_object refuses them until they leave it */
    orphanedFamilyMembers?: Array<{ name: string; families: string[] }>;
    /**
     * Objects the index finds no use of, but that files it could not parse
     * possibly use (their text names the object or holds its SID, or they
     * could not be searched): listed with those files
     */
    possiblyUsedObjects?: Array<{ name: string; files: string[] }>;
    totalObjects: number;
    totalReferenced: number;
  };
  /**
   * Event sheets, layouts and families the index could not parse, searched as
   * text for the object (project-wide: for the objects without a use the index
   * found; "not-searched" when there are none)
   */
  unscannedFiles?: UnscannedFileSummary[];
}

export interface OrphanedObjectsResult {
  orphanedObjects: Array<{
    name: string;
    pluginId: string;
    isGlobal: boolean;
    /** Families (that no event uses) the object is a member of */
    families?: string[];
  }>;
  count: number;
  totalObjects: number;
  /** Objects that would be orphans but that files the index could not parse possibly use, with those files */
  possiblyUsed?: Array<{ name: string; pluginId: string; isGlobal: boolean; files: string[] }>;
  /**
   * Event sheets, layouts and families the index could not parse, searched as
   * text for the objects without a use the index found ("not-searched" when
   * there are none)
   */
  unscannedFiles?: UnscannedFileSummary[];
}

/**
 * Possible uses of `objects` in the event sheets, layouts and families the
 * index could not parse (issue #55): one text search per file for all the
 * names (and, in layouts, the SIDs object properties hold). `byObject` maps
 * each object to the files whose text names it; a file that cannot be read
 * even as text counts for every object. `files` lists every such file, its
 * textSearch about these objects only ("not-searched" when there are none).
 * Nothing is read while every file could be parsed.
 */
async function possibleObjectUses(
  reader: Construct3ProjectReader,
  index: ProjectIndex,
  objects: string[],
): Promise<{ files: UnscannedFileSummary[]; byObject: Map<string, string[]> }> {
  const byObject = new Map<string, string[]>();
  const skipped = index.unscannedFiles.filter(f => f.category !== 'objectTypes');
  if (objects.length === 0) {
    return { files: skipped.map(f => ({ file: f.file, reason: f.reason, textSearch: 'not-searched' as const })), byObject };
  }
  if (skipped.length === 0) return { files: [], byObject };

  const owner = new Map<string, string>();
  const nameTerms: RawTextTerm[] = [];
  const sidTerms: RawTextTerm[] = [];
  for (const name of objects) {
    owner.set(name, name);
    nameTerms.push(nameTerm(name));
    const sid = index.sidOf(name);
    if (sid !== undefined) {
      const key = `sid:${sid}`;
      owner.set(key, name);
      sidTerms.push(numberTerm(sid, key));
    }
  }
  const searched = await searchUnscannedFiles(reader, skipped,
    file => file.category === 'layouts' ? [...nameTerms, ...sidTerms] : nameTerms);

  const files: UnscannedFileSummary[] = [];
  for (const { file, found } of searched) {
    const users = found === null ? objects : [...new Set([...found].map(key => owner.get(key)!))];
    for (const name of users) {
      if (!byObject.has(name)) byObject.set(name, []);
      byObject.get(name)!.push(file.file);
    }
    files.push({
      file: file.file,
      reason: file.reason,
      textSearch: found === null ? 'unreadable' : found.size > 0 ? 'possible-use' : 'no-match',
    });
  }
  return { files, byObject };
}

/**
 * Get object dependency info for a specific object or project-wide.
 */
export async function getObjectDependencies(
  reader: Construct3ProjectReader,
  options: {
    object?: string;
    detail?: 'summary' | 'standard' | 'full';
  } = {}
): Promise<ObjectDependencyResult> {
  const index = await getProjectIndex(reader);

  if (options.object) {
    // Validate the object exists
    if (!index.allObjects.includes(options.object)) {
      const suggestions = reader.findNearestName(options.object, 'objects');
      const hint = suggestions.length > 0
        ? ` Did you mean: ${suggestions.join(', ')}?`
        : '';
      throw new Error(`Object "${options.object}" not found.${hint} Use list_objects to see all available names.`);
    }

    const node = buildObjectNode(index, options.object);
    const { files, byObject } = await possibleObjectUses(reader, index, [options.object]);
    const possibly = byObject.get(options.object);
    return {
      object: possibly ? { ...node, possiblyReferencedIn: possibly } : node,
      ...(files.length > 0 ? { unscannedFiles: files } : {}),
    };
  }

  // Project-wide view. Same rule as find_orphaned_objects: objects the index finds
  // no use of, unless files it could not parse possibly use them
  const unused = index.allObjects.filter(objName => !index.isObjectUsed(objName));
  const { files, byObject } = await possibleObjectUses(reader, index, unused);
  const allNodes: ObjectDependencyNode[] = [];
  const orphanedObjects: string[] = [];
  const orphanedFamilyMembers: Array<{ name: string; families: string[] }> = [];
  const possiblyUsedObjects: Array<{ name: string; files: string[] }> = [];

  for (const objName of index.allObjects) {
    const node = buildObjectNode(index, objName);
    const possibly = byObject.get(objName);
    allNodes.push(possibly ? { ...node, possiblyReferencedIn: possibly } : node);

    if (possibly) {
      possiblyUsedObjects.push({ name: objName, files: possibly });
    } else if (!index.isObjectUsed(objName)) {
      orphanedObjects.push(objName);
      const families = index.getObjectUsage(objName).families;
      if (families.length > 0) orphanedFamilyMembers.push({ name: objName, families });
    }
  }

  // Sort by total reference count
  allNodes.sort((a, b) => b.referenceCount - a.referenceCount);

  const limit = options.detail === 'full' ? allNodes.length : 20;

  return {
    projectWide: {
      topConnected: allNodes.slice(0, limit),
      orphanedObjects,
      ...(orphanedFamilyMembers.length > 0 ? { orphanedFamilyMembers } : {}),
      ...(possiblyUsedObjects.length > 0 ? { possiblyUsedObjects } : {}),
      totalObjects: index.allObjects.length,
      // Used objects (family use included), so
      // totalReferenced + orphanedObjects.length + possiblyUsedObjects.length = totalObjects
      totalReferenced: index.allObjects.length - orphanedObjects.length - possiblyUsedObjects.length,
    },
    ...(files.length > 0 ? { unscannedFiles: files } : {}),
  };
}

function buildObjectNode(index: import('./index-builder.js').ProjectIndex, objectName: string): ObjectDependencyNode {
  const eventSheets = index.getEventSheetsForObject(objectName);
  // Layouts with an instance (any layer or sub-layer, or non-world) or an object property naming it
  const usage = index.getObjectUsage(objectName);
  const layouts = [...new Set([
    ...(index.objectToLayouts.get(objectName) || []),
    ...usage.instanceProperties.map(p => p.layout),
  ])];
  const families = index.objectToFamilies.get(objectName) || [];
  const coOccurs = index.getCoOccurringObjects(objectName);
  const refs = index.objectToEventSheets.get(objectName) || [];

  return {
    objectName,
    referencedIn: { eventSheets, layouts },
    families,
    coOccursWith: coOccurs.slice(0, 20), // Limit co-occurrence list
    referenceCount: refs.length + layouts.length,
  };
}

/**
 * Find objects not used by any event (directly or through a family), not
 * placed in any layout (any layer or sub-layer, or non-world instances) and not
 * named by an object property of another instance. See index-builder.ts for
 * what counts as a use. Orphans that are family members list their families:
 * delete_object refuses them until they leave the family.
 */
export async function findOrphanedObjects(
  reader: Construct3ProjectReader
): Promise<OrphanedObjectsResult> {
  const index = await getProjectIndex(reader);
  const objectTypes = await reader.readAllObjectTypes();
  const unused = index.allObjects.filter(objName => !index.isObjectUsed(objName));
  const { files, byObject } = await possibleObjectUses(reader, index, unused);

  const orphaned: OrphanedObjectsResult['orphanedObjects'] = [];
  const possiblyUsed: NonNullable<OrphanedObjectsResult['possiblyUsed']> = [];

  for (const objName of unused) {
    const objData = objectTypes.get(objName);
    const pluginId = objData?.['plugin-id'] || 'unknown';
    const isGlobal = objData?.isGlobal === true;
    const possibly = byObject.get(objName);
    if (possibly) {
      possiblyUsed.push({ name: objName, pluginId, isGlobal, files: possibly });
      continue;
    }
    const families = index.getObjectUsage(objName).families;
    orphaned.push({ name: objName, pluginId, isGlobal, ...(families.length > 0 ? { families } : {}) });
  }

  return {
    orphanedObjects: orphaned,
    count: orphaned.length,
    totalObjects: index.allObjects.length,
    ...(possiblyUsed.length > 0 ? { possiblyUsed } : {}),
    ...(files.length > 0 ? { unscannedFiles: files } : {}),
  };
}
