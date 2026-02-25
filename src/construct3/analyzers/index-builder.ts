/**
 * Cross-reference index builder for Construct 3 projects.
 * Foundation for all analysis features: builds lazily on first use, cached.
 */

import type { Construct3ProjectReader } from '../project-reader.js';
import type {
  C3Event,
  BlockEvent,
  FunctionBlockEvent,
  GroupEvent,
  IncludeEvent,
  Condition,
  Action,
  ObjectReference,
  Layout,
} from '../types.js';

const MAX_NODES = 100_000;
const MAX_DEPTH = 50;

export class ProjectIndex {
  /** Object → where used in events */
  objectToEventSheets: Map<string, ObjectReference[]> = new Map();

  /** Event sheet include graph */
  eventSheetIncludes: Map<string, string[]> = new Map();
  eventSheetIncludedBy: Map<string, string[]> = new Map();

  /** Layout → event sheet binding */
  layoutToEventSheet: Map<string, string> = new Map();

  /** Object → layout placements */
  objectToLayouts: Map<string, string[]> = new Map();

  /** Function definitions & call sites */
  functionDefinitions: Map<string, { sheet: string; params: string[] }> = new Map();
  functionCalls: Map<string, { sheet: string; path: string }[]> = new Map();

  /** Family membership */
  familyMembers: Map<string, string[]> = new Map();
  objectToFamilies: Map<string, string[]> = new Map();

  /** All event sheet names */
  allEventSheets: string[] = [];
  /** All object names */
  allObjects: string[] = [];
  /** All layout names */
  allLayouts: string[] = [];

  /** Warnings collected during indexing */
  warnings: string[] = [];

  private built = false;

  isBuilt(): boolean {
    return this.built;
  }

  async build(reader: Construct3ProjectReader): Promise<void> {
    if (this.built) return;

    this.allEventSheets = await reader.listEventSheets();
    this.allObjects = await reader.listObjectTypes();
    this.allLayouts = await reader.listLayouts();

    // Index event sheets
    const eventSheets = await reader.readAllEventSheets();
    for (const [sheetName, sheet] of eventSheets) {
      this.eventSheetIncludes.set(sheetName, []);
      if (Array.isArray(sheet.events)) {
        this.indexEventSheet(sheetName, sheet.events);
      }
    }

    // Build includedBy reverse map
    for (const [sheet, includes] of this.eventSheetIncludes) {
      for (const included of includes) {
        if (!this.eventSheetIncludedBy.has(included)) {
          this.eventSheetIncludedBy.set(included, []);
        }
        this.eventSheetIncludedBy.get(included)!.push(sheet);
      }
    }

    // Index layouts
    const layouts = await reader.readAllLayouts();
    for (const [layoutName, layout] of layouts) {
      this.indexLayout(layoutName, layout);
    }

    // Index families
    const families = await reader.readAllFamilies();
    for (const [familyName, familyData] of families) {
      this.indexFamily(familyName, familyData);
    }

    this.built = true;
  }

  private indexEventSheet(sheetName: string, events: C3Event[]): void {
    // Iterative (stack-based) traversal to avoid stack overflow
    const stack: Array<{ event: C3Event; path: string; depth: number }> = [];
    let nodeCount = 0;

    // Push events in reverse so we process in order
    for (let i = events.length - 1; i >= 0; i--) {
      stack.push({ event: events[i], path: '', depth: 0 });
    }

    while (stack.length > 0) {
      if (nodeCount++ > MAX_NODES) {
        this.warnings.push(`Event sheet "${sheetName}": traversal limit reached (${MAX_NODES} nodes)`);
        break;
      }

      const { event, path, depth } = stack.pop()!;
      if (depth > MAX_DEPTH) {
        this.warnings.push(`Event sheet "${sheetName}": max depth exceeded at ${path}`);
        continue;
      }

      const eventType = event.eventType;

      if (eventType === 'block') {
        const block = event as BlockEvent;
        const blockPath = path ? `${path} > block` : 'block';

        // Index conditions
        if (block.conditions) {
          for (let i = 0; i < block.conditions.length; i++) {
            this.indexCondition(sheetName, block.conditions[i], `${blockPath} > condition:${i}`);
          }
        }

        // Index actions
        if (block.actions) {
          for (let i = 0; i < block.actions.length; i++) {
            this.indexAction(sheetName, block.actions[i], `${blockPath} > action:${i}`);
          }
        }

        // Push children
        if (block.children) {
          for (let i = block.children.length - 1; i >= 0; i--) {
            stack.push({ event: block.children[i], path: blockPath, depth: depth + 1 });
          }
        }
      } else if (eventType === 'function-block') {
        const func = event as FunctionBlockEvent;
        const funcName = func.functionName || 'unknown';
        const funcPath = path ? `${path} > function:${funcName}` : `function:${funcName}`;

        // Record function definition
        const paramNames = func.parameters?.map(p => p.name) || [];
        this.functionDefinitions.set(funcName, { sheet: sheetName, params: paramNames });

        // Index conditions & actions
        if (func.conditions) {
          for (let i = 0; i < func.conditions.length; i++) {
            this.indexCondition(sheetName, func.conditions[i], `${funcPath} > condition:${i}`);
          }
        }
        if (func.actions) {
          for (let i = 0; i < func.actions.length; i++) {
            this.indexAction(sheetName, func.actions[i], `${funcPath} > action:${i}`);
          }
        }

        // Push children
        if (func.children) {
          for (let i = func.children.length - 1; i >= 0; i--) {
            stack.push({ event: func.children[i], path: funcPath, depth: depth + 1 });
          }
        }
      } else if (eventType === 'group') {
        const group = event as GroupEvent;
        const groupPath = path ? `${path} > group:${group.title}` : `group:${group.title}`;

        // Index children (even if disabled — they're part of the structure)
        if (group.children) {
          for (let i = group.children.length - 1; i >= 0; i--) {
            stack.push({ event: group.children[i], path: groupPath, depth: depth + 1 });
          }
        }
      } else if (eventType === 'include') {
        const include = event as IncludeEvent;
        const includes = this.eventSheetIncludes.get(sheetName) || [];
        if (!includes.includes(include.includeSheet)) {
          includes.push(include.includeSheet);
          this.eventSheetIncludes.set(sheetName, includes);
        }
      } else if (eventType === 'script') {
        // Can't parse inline JS for object refs — skip with note
      }
      // variable, comment — no object references to index
    }
  }

  private indexCondition(sheetName: string, condition: Condition, path: string): void {
    if (!condition.objectClass) return;
    const objName = condition.objectClass;
    this.addObjectReference(objName, sheetName, path, 'condition');
  }

  private indexAction(sheetName: string, action: Action, path: string): void {
    // Script actions have type: 'script' instead of objectClass
    if ('type' in action && action.type === 'script') return;

    const stdAction = action as { objectClass?: string; callFunction?: string; id?: string };
    if (stdAction.objectClass) {
      this.addObjectReference(stdAction.objectClass, sheetName, path, 'action');
    }

    // Check for function calls
    if (stdAction.callFunction) {
      const calls = this.functionCalls.get(stdAction.callFunction) || [];
      calls.push({ sheet: sheetName, path });
      this.functionCalls.set(stdAction.callFunction, calls);
    }

    // Also check id for "callFunction" pattern
    if (stdAction.id === 'callFunction' && stdAction.callFunction) {
      // Already handled above
    }
  }

  private addObjectReference(objectName: string, sheetName: string, path: string, context: 'condition' | 'action'): void {
    if (!this.objectToEventSheets.has(objectName)) {
      this.objectToEventSheets.set(objectName, []);
    }
    this.objectToEventSheets.get(objectName)!.push({
      objectName,
      eventSheet: sheetName,
      path,
      context,
    });
  }

  private indexLayout(layoutName: string, layout: Layout): void {
    // Bind layout to its event sheet (field is 'eventSheet' in C3 layout JSON)
    const eventSheet = (layout as Record<string, unknown>)['eventSheet'] ?? layout['event-sheet'];
    if (typeof eventSheet === 'string') {
      this.layoutToEventSheet.set(layoutName, eventSheet);
    }

    // Index object placements from instances
    if (layout.layers) {
      for (const layer of layout.layers) {
        if (layer.instances) {
          for (const instance of layer.instances) {
            if (instance.type) {
              if (!this.objectToLayouts.has(instance.type)) {
                this.objectToLayouts.set(instance.type, []);
              }
              const layouts = this.objectToLayouts.get(instance.type)!;
              if (!layouts.includes(layoutName)) {
                layouts.push(layoutName);
              }
            }
          }
        }
      }
    }
  }

  private indexFamily(familyName: string, familyData: Record<string, unknown>): void {
    const members = familyData.members as string[] | undefined;
    if (!Array.isArray(members)) return;

    this.familyMembers.set(familyName, members);
    for (const member of members) {
      if (!this.objectToFamilies.has(member)) {
        this.objectToFamilies.set(member, []);
      }
      this.objectToFamilies.get(member)!.push(familyName);
    }
  }

  /**
   * Get unique event sheets that reference a given object
   */
  getEventSheetsForObject(objectName: string): string[] {
    const refs = this.objectToEventSheets.get(objectName) || [];
    return [...new Set(refs.map(r => r.eventSheet))];
  }

  /**
   * Get objects that co-occur in the same event blocks as the given object
   */
  getCoOccurringObjects(objectName: string): string[] {
    const refs = this.objectToEventSheets.get(objectName) || [];
    const coObjects = new Set<string>();

    for (const ref of refs) {
      // Find all other objects referenced in the same event sheet
      for (const [otherObj, otherRefs] of this.objectToEventSheets) {
        if (otherObj === objectName) continue;
        for (const otherRef of otherRefs) {
          if (otherRef.eventSheet === ref.eventSheet) {
            coObjects.add(otherObj);
            break;
          }
        }
      }
    }

    return [...coObjects];
  }

  /**
   * Get the total number of events in an event sheet (from the raw events array)
   */
  countEvents(events: C3Event[]): number {
    let count = 0;
    const stack = [...events];
    while (stack.length > 0) {
      count++;
      const event = stack.pop()!;
      if ('children' in event && Array.isArray(event.children)) {
        stack.push(...event.children);
      }
    }
    return count;
  }
}

/** Singleton lazy builder */
let cachedIndex: ProjectIndex | null = null;

export async function getProjectIndex(reader: Construct3ProjectReader): Promise<ProjectIndex> {
  if (cachedIndex && cachedIndex.isBuilt()) return cachedIndex;
  cachedIndex = new ProjectIndex();
  await cachedIndex.build(reader);
  return cachedIndex;
}

/** Reset the cached project index so it rebuilds on next use. */
export function resetProjectIndex(): void {
  cachedIndex = null;
}
