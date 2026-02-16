/**
 * Object dependency graph analysis.
 */

import type { Construct3ProjectReader } from '../project-reader.js';
import type { ObjectDependencyNode } from '../types.js';
import { getProjectIndex } from './index-builder.js';

export interface ObjectDependencyResult {
  object?: ObjectDependencyNode;
  projectWide?: {
    topConnected: ObjectDependencyNode[];
    orphanedObjects: string[];
    totalObjects: number;
    totalReferenced: number;
  };
}

export interface OrphanedObjectsResult {
  orphanedObjects: Array<{
    name: string;
    pluginId: string;
    isGlobal: boolean;
  }>;
  count: number;
  totalObjects: number;
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

    return { object: buildObjectNode(index, options.object) };
  }

  // Project-wide view
  const allNodes: ObjectDependencyNode[] = [];
  const orphanedObjects: string[] = [];

  for (const objName of index.allObjects) {
    const node = buildObjectNode(index, objName);
    allNodes.push(node);

    if (node.referencedIn.eventSheets.length === 0 && node.referencedIn.layouts.length === 0) {
      orphanedObjects.push(objName);
    }
  }

  // Sort by total reference count
  allNodes.sort((a, b) => b.referenceCount - a.referenceCount);

  const limit = options.detail === 'full' ? allNodes.length : 20;

  return {
    projectWide: {
      topConnected: allNodes.slice(0, limit),
      orphanedObjects,
      totalObjects: index.allObjects.length,
      totalReferenced: allNodes.filter(n => n.referenceCount > 0).length,
    },
  };
}

function buildObjectNode(index: import('./index-builder.js').ProjectIndex, objectName: string): ObjectDependencyNode {
  const eventSheets = index.getEventSheetsForObject(objectName);
  const layouts = index.objectToLayouts.get(objectName) || [];
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
 * Find objects not referenced in any event sheet or placed in any layout.
 */
export async function findOrphanedObjects(
  reader: Construct3ProjectReader
): Promise<OrphanedObjectsResult> {
  const index = await getProjectIndex(reader);
  const objectTypes = await reader.readAllObjectTypes();

  const orphaned: OrphanedObjectsResult['orphanedObjects'] = [];

  for (const objName of index.allObjects) {
    const eventSheetRefs = index.getEventSheetsForObject(objName);
    const layoutPlacements = index.objectToLayouts.get(objName) || [];

    // Also check family references — if a family references this object,
    // it might be used indirectly via the family name
    const families = index.objectToFamilies.get(objName) || [];
    let familyReferenced = false;
    for (const family of families) {
      const familyRefs = index.getEventSheetsForObject(family);
      if (familyRefs.length > 0) {
        familyReferenced = true;
        break;
      }
    }

    if (eventSheetRefs.length === 0 && layoutPlacements.length === 0 && !familyReferenced) {
      const objData = objectTypes.get(objName);
      orphaned.push({
        name: objName,
        pluginId: objData?.['plugin-id'] || 'unknown',
        isGlobal: objData?.['is-global'] === true,
      });
    }
  }

  return {
    orphanedObjects: orphaned,
    count: orphaned.length,
    totalObjects: index.allObjects.length,
  };
}
