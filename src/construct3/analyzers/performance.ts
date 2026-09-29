/**
 * Performance heuristic analysis for Construct 3 projects.
 */

import type { Construct3ProjectReader } from '../project-reader.js';
import type { PerformanceIssue, C3Event, BlockEvent, GroupEvent, FunctionBlockEvent } from '../types.js';
import { findOrphanedObjects } from './object-deps.js';
import { forEachLayerInstance } from '../layers.js';
import { countAnimationFrames } from './animations.js';
import { isTriggerId } from './load-rules.js';
import { getProjectIndex } from './index-builder.js';
import { searchUnscannedFiles } from './unscanned-uses.js';
import { patternTerm } from '../raw-text-search.js';
import { isElseBlock } from '../event-shapes.js';

/** Events visited per sheet at most */
const MAX_NODES = 100_000;

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
        message: `${everyTickCount} event block(s) with no trigger condition (runs every tick; top-level blocks and blocks in groups active on start, sub-events not counted)`,
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

    // Check: Layout with > 500 instances (on all layers and sub-layers)
    let instanceCount = 0;
    forEachLayerInstance(layout.layers, () => { instanceCount++; });
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
    // Check: Objects with > 50 animation frames (all animations, subfolders included)
    const { frames: totalFrames } = countAnimationFrames(objData.animations);
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

  // Check: Orphaned objects (find_orphaned_objects, whose rule validate_project follows too: objects
  // that files the index could not parse possibly use are not orphans)
  const orphans = await findOrphanedObjects(reader);
  const orphanedCount = orphans.count;
  const possiblyUsed = orphans.possiblyUsed?.length ?? 0;
  const unanalysed = orphans.unanalysedObjects ?? [];

  if (orphanedCount > 0) {
    issues.push({
      severity: 'info',
      category: 'cleanup',
      location: 'project',
      message: `${orphanedCount} object(s) not used by any event (directly or through a family) and without an instance in any layout (on any layer or sub-layer, including non-world instances)` +
        (possiblyUsed > 0 ? `; ${possiblyUsed} more possibly used in files that could not be parsed (find_orphaned_objects lists them as possiblyUsed)` : ''),
      suggestion: 'Use find_orphaned_objects to list them. Before removing one, check what this analysis cannot see: ' +
        'project script files, objects created by a name built at runtime, and script references it does not recognise.',
    });
  }
  if (unanalysed.length > 0) {
    issues.push({
      severity: 'info',
      category: 'cleanup',
      location: 'project',
      message: `${unanalysed.length} object(s) without a use found whose own object type file could not be parsed ` +
        `(${unanalysed.slice(0, 5).map(o => `${o.file}: ${o.reason}`).join(', ')}${unanalysed.length > 5 ? ', ...' : ''}): ` +
        'their SID is unknown, so whether they are used could not be told; they are not counted as unused',
      suggestion: 'find_orphaned_objects lists them as unanalysedObjects. Repair or split the object type file (validate_project lists it) to analyse them.',
    });
  }

  // Check: Unused addons
  const project = reader.getProject();
  const usedPluginIds = new Set<string>();
  for (const [, objData] of objectTypes) {
    usedPluginIds.add(objData['plugin-id']);
  }
  const candidates = project.usedAddons.filter(
    a => a.type === 'plugin' && !a.bundled && !usedPluginIds.has(a.id)
  );
  // The plugins of object types whose file could not be parsed are unknown: search their text
  const possiblyUsedAddons = await addonsPossiblyUsedByUnparsedObjects(reader, candidates.map(a => a.id));
  const unusedAddons = candidates.filter(a => !possiblyUsedAddons.has(a.id));
  const possiblyUsedNames = candidates.filter(a => possiblyUsedAddons.has(a.id)).map(a => a.name);
  if (unusedAddons.length > 0 || possiblyUsedNames.length > 0) {
    issues.push({
      severity: 'info',
      category: 'cleanup',
      location: 'project',
      message: `${unusedAddons.length} addon(s) declared but not used by any object` +
        (unusedAddons.length > 0 ? `: ${unusedAddons.map(a => a.name).join(', ')}` : '') +
        (possiblyUsedNames.length > 0
          ? `; ${possiblyUsedNames.length} more possibly used by object types whose files could not be parsed: ${possiblyUsedNames.join(', ')}`
          : ''),
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

/**
 * Of the plugin ids `ids`, those that object types whose own file could not
 * be parsed (over the read limit, not valid JSON) possibly use: their text
 * holds `"plugin-id": "<id>"`. All of them while such a file cannot be read
 * even as text. Nothing is read while every object type file was parsed.
 */
async function addonsPossiblyUsedByUnparsedObjects(reader: Construct3ProjectReader, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const files = (await getProjectIndex(reader)).unscannedFiles.filter(f => f.category === 'objectTypes');
  if (files.length === 0) return new Set();
  const terms = ids.map(id => {
    const value = JSON.stringify(id).replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
    return patternTerm(id, `"plugin-id"\\s{0,16}:\\s{0,16}${value}`, value.length + 48);
  });
  const found = new Set<string>();
  for (const result of await searchUnscannedFiles(reader, files, () => terms)) {
    for (const id of result.found ?? ids) found.add(id);
  }
  return found;
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

/**
 * Event blocks that run every tick: blocks at the top level of the sheet or
 * in groups (nested to any depth) without a trigger among their conditions
 * (isTriggerId, the rule validate_project's trigger placement check uses;
 * conditions such as System "Every tick" or a comparison are tested every
 * tick). Not counted:
 * - sub-events: they run as part of their parent, only when its trigger
 *   fires or its function or custom action runs, and otherwise together
 *   with the parent, which is counted;
 * - else blocks: they belong to the block before them;
 * - function and custom action blocks, which run when called;
 * - disabled blocks, and blocks in a disabled group or a group that is not
 *   active on start (until an action activates it).
 */
function countEveryTickBlocks(events: C3Event[]): number {
  let count = 0;
  let nodes = 0;
  const stack: unknown[] = [...events];

  while (stack.length > 0 && nodes++ < MAX_NODES) {
    const event = stack.pop();
    if (!event || typeof event !== 'object') continue;
    const record = event as Record<string, unknown>;
    if (record.disabled === true) continue;
    if (record.eventType === 'group') {
      if ((record as unknown as GroupEvent).isActiveOnStart === false) continue;
      if (Array.isArray(record.children)) stack.push(...record.children);
    } else if (record.eventType === 'block' && !isElseBlock(record)) {
      const conditions = Array.isArray(record.conditions) ? record.conditions as unknown[] : [];
      const triggered = conditions.some(c => c !== null && typeof c === 'object' && isTriggerId((c as { id?: unknown }).id));
      if (!triggered) count++;
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
