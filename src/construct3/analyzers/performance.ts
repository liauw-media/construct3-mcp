/**
 * Performance heuristic analysis for Construct 3 projects.
 */

import type { Construct3ProjectReader } from '../project-reader.js';
import type { PerformanceIssue, C3Event, BlockEvent, GroupEvent, FunctionBlockEvent } from '../types.js';
import { getProjectIndex } from './index-builder.js';

export interface PerformanceResult {
  summary: { critical: number; warning: number; info: number };
  issues: PerformanceIssue[];
}

/**
 * Analyze project for performance issues using heuristic checks.
 */
export async function analyzePerformance(
  reader: Construct3ProjectReader,
  options: {
    scope?: string;
    detail?: 'summary' | 'standard' | 'full';
  } = {}
): Promise<PerformanceResult> {
  const index = await getProjectIndex(reader);
  const detail = options.detail || 'standard';
  const issues: PerformanceIssue[] = [];

  // Determine which sheets/layouts to analyze
  const scopeSheet = options.scope;
  const scopeLayout = options.scope;

  // Check event sheets
  const eventSheets = await reader.readAllEventSheets();
  for (const [sheetName, sheet] of eventSheets) {
    if (scopeSheet && sheetName !== scopeSheet) continue;

    // Check: Event sheet with > 200 events
    const eventCount = countTotalEvents(sheet.events);
    if (eventCount > 200) {
      issues.push({
        severity: 'warning',
        category: 'event-complexity',
        location: sheetName,
        message: `Event sheet has ${eventCount} events`,
        suggestion: 'Consider splitting into smaller, focused event sheets using includes',
      });
    }

    // Check: Event nesting depth
    const maxDepth = getMaxNestingDepth(sheet.events);
    if (maxDepth > 5) {
      issues.push({
        severity: 'warning',
        category: 'event-complexity',
        location: sheetName,
        message: `Event block has ${maxDepth} levels of nesting`,
        suggestion: 'Extract deeply nested logic into a named function',
      });
    }

    // Check: Every-tick conditions (blocks with no trigger)
    const everyTickCount = countEveryTickBlocks(sheet.events);
    if (everyTickCount > 0) {
      issues.push({
        severity: 'info',
        category: 'performance',
        location: sheetName,
        message: `${everyTickCount} event block(s) with no trigger condition (runs every tick)`,
        suggestion: 'Review if every-tick evaluation is necessary; consider using triggers instead',
      });
    }

    // Check: Inline script actions
    const scriptCount = countScriptActions(sheet.events);
    if (scriptCount > 0) {
      issues.push({
        severity: 'info',
        category: 'code-organization',
        location: sheetName,
        message: `${scriptCount} inline script action(s)`,
        suggestion: 'Consider moving inline scripts to dedicated script files for maintainability',
      });
    }

    // Check: Groups always active with many events
    checkActiveGroups(sheet.events, sheetName, issues);
  }

  // Check layouts
  const layouts = await reader.readAllLayouts();
  for (const [layoutName, layout] of layouts) {
    if (scopeLayout && layoutName !== scopeLayout) continue;

    // Check: Layout with > 500 instances
    let instanceCount = 0;
    if (layout.layers) {
      for (const layer of layout.layers) {
        instanceCount += layer.instances?.length || 0;
      }
    }
    if (instanceCount > 500) {
      issues.push({
        severity: 'warning',
        category: 'layout-complexity',
        location: layoutName,
        message: `Layout has ${instanceCount} instances`,
        suggestion: 'Large instance counts impact performance; consider using object pooling or spawning',
      });
    }
  }

  // Check objects
  const objectTypes = await reader.readAllObjectTypes();
  for (const [objName, objData] of objectTypes) {
    // Check: Objects with > 50 animation frames
    if (objData.animations && Array.isArray(objData.animations)) {
      let totalFrames = 0;
      for (const anim of objData.animations) {
        if (anim.frames && Array.isArray(anim.frames)) {
          totalFrames += anim.frames.length;
        }
      }
      if (totalFrames > 50) {
        issues.push({
          severity: 'info',
          category: 'memory',
          location: objName,
          message: `Object has ${totalFrames} animation frames total`,
          suggestion: 'High frame counts increase memory usage; consider sprite sheet optimization',
        });
      }
    }
  }

  // Check: Orphaned objects
  const orphanedCount = index.allObjects.filter(obj => {
    const refs = index.getEventSheetsForObject(obj);
    const layouts = index.objectToLayouts.get(obj) || [];
    return refs.length === 0 && layouts.length === 0;
  }).length;

  if (orphanedCount > 0) {
    issues.push({
      severity: 'info',
      category: 'cleanup',
      location: 'project',
      message: `${orphanedCount} object(s) not referenced in any event sheet or layout`,
      suggestion: 'Use find_orphaned_objects to identify and consider removing unused objects',
    });
  }

  // Check: Unused addons
  const project = reader.getProject();
  const usedPluginIds = new Set<string>();
  for (const [, objData] of objectTypes) {
    usedPluginIds.add(objData['plugin-id']);
  }
  const unusedAddons = project.usedAddons.filter(
    a => a.type === 'plugin' && !a.bundled && !usedPluginIds.has(a.id)
  );
  if (unusedAddons.length > 0) {
    issues.push({
      severity: 'info',
      category: 'cleanup',
      location: 'project',
      message: `${unusedAddons.length} addon(s) declared but not used by any object: ${unusedAddons.map(a => a.name).join(', ')}`,
      suggestion: 'Remove unused addons to reduce project size',
    });
  }

  // Sort by severity
  const severityOrder = { critical: 0, warning: 1, info: 2 };
  issues.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  const summary = {
    critical: issues.filter(i => i.severity === 'critical').length,
    warning: issues.filter(i => i.severity === 'warning').length,
    info: issues.filter(i => i.severity === 'info').length,
  };

  // Limit output for summary detail
  const outputIssues = detail === 'summary' ? issues.slice(0, 10) : issues;

  return { summary, issues: outputIssues };
}

function countTotalEvents(events: C3Event[]): number {
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

function getMaxNestingDepth(events: C3Event[]): number {
  let maxDepth = 0;
  const stack: Array<{ event: C3Event; depth: number }> = events.map(e => ({ event: e, depth: 1 }));

  while (stack.length > 0) {
    const { event, depth } = stack.pop()!;
    if (depth > maxDepth) maxDepth = depth;

    if ('children' in event && Array.isArray(event.children)) {
      for (const child of event.children) {
        stack.push({ event: child, depth: depth + 1 });
      }
    }
  }
  return maxDepth;
}

function countEveryTickBlocks(events: C3Event[]): number {
  let count = 0;
  const stack = [...events];

  while (stack.length > 0) {
    const event = stack.pop()!;
    if (event.eventType === 'block') {
      const block = event as BlockEvent;
      // A block with no conditions or only non-trigger conditions runs every tick
      if (!block.conditions || block.conditions.length === 0) {
        count++;
      }
    }
    if ('children' in event && Array.isArray(event.children)) {
      stack.push(...event.children);
    }
  }
  return count;
}

function countScriptActions(events: C3Event[]): number {
  let count = 0;
  const stack = [...events];

  while (stack.length > 0) {
    const event = stack.pop()!;

    if (event.eventType === 'script') {
      count++;
    }

    if (event.eventType === 'block') {
      const block = event as BlockEvent;
      if (block.actions) {
        for (const action of block.actions) {
          if ('type' in action && action.type === 'script') {
            count++;
          }
        }
      }
    }

    if (event.eventType === 'function-block') {
      const func = event as FunctionBlockEvent;
      if (func.actions) {
        for (const action of func.actions) {
          if ('type' in action && action.type === 'script') {
            count++;
          }
        }
      }
    }

    if ('children' in event && Array.isArray(event.children)) {
      stack.push(...event.children);
    }
  }
  return count;
}

function checkActiveGroups(events: C3Event[], sheetName: string, issues: PerformanceIssue[]): void {
  for (const event of events) {
    if (event.eventType === 'group') {
      const group = event as GroupEvent;
      const childCount = group.children ? countTotalEvents(group.children) : 0;
      if (group.isActiveOnStart !== false && childCount > 50) {
        issues.push({
          severity: 'info',
          category: 'performance',
          location: `${sheetName} > group:${group.title}`,
          message: `Group "${group.title}" is always active with ${childCount} events`,
          suggestion: 'Consider deactivating the group when not needed to reduce event processing',
        });
      }
    }
  }
}
