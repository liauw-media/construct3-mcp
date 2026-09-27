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

    // Same rule as find_orphaned_objects and validate_project
    if (!index.isObjectUsed(objName)) {
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
      // Used objects (family use included), so totalReferenced + orphanedObjects.length = totalObjects
      totalReferenced: index.allObjects.length - orphanedObjects.length,
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
 * Find objects not used by any event (directly or through a family) and not
 * placed in any layout (layers or non-world instances). See index-builder.ts
 * for what counts as a use in events.
 */
export async function findOrphanedObjects(
  reader: Construct3ProjectReader
): Promise<OrphanedObjectsResult> {
  const index = await getProjectIndex(reader);
  const objectTypes = await reader.readAllObjectTypes();

  const orphaned: OrphanedObjectsResult['orphanedObjects'] = [];

  for (const objName of index.allObjects) {
    if (!index.isObjectUsed(objName)) {
      const objData = objectTypes.get(objName);
      orphaned.push({
        name: objName,
        pluginId: objData?.['plugin-id'] || 'unknown',
        isGlobal: objData?.isGlobal === true,
      });
    }
  }

  return {
    orphanedObjects: orphaned,
    count: orphaned.length,
    totalObjects: index.allObjects.length,
  };
}
