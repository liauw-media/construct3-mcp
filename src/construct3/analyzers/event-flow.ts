/**
 * Event sheet flow visualization and function mapping.
 */

import type { Construct3ProjectReader } from '../project-reader.js';
import type { ProjectIndex, FunctionCallSite } from './index-builder.js';
import { getProjectIndex } from './index-builder.js';
import type { EventSheetFlowNode } from '../types.js';

export interface EventFlowResult {
  format: 'mermaid' | 'json';
  diagram?: string;
  nodes?: EventSheetFlowNode[];
  layoutBindings: Record<string, string>;
  warnings: string[];
}

export interface FunctionMapResult {
  functions: Array<{
    name: string;
    sheet: string;
    params: string[];
    /** Call function actions, Functions.Name(...) expression calls and function map registrations (see FunctionCallSite.via) */
    callSites: FunctionCallSite[];
    callCount: number;
    /** Other function blocks whose name matches this one's, ignoring case (a name the editor refuses to give twice) */
    sameNameAs?: Array<{ name: string; sheet: string }>;
  }>;
  summary: {
    totalFunctions: number;
    totalCallSites: number;
    uncalledFunctions: string[];
    /** Function names (ignoring case) that several function blocks have */
    duplicateFunctionNames?: string[];
  };
}

/**
 * Get the event sheet flow for the project or a specific sheet.
 */
export async function getEventSheetFlow(
  reader: Construct3ProjectReader,
  options: {
    eventsheet?: string;
    format?: 'mermaid' | 'json';
    detail?: 'summary' | 'standard' | 'full';
  } = {}
): Promise<EventFlowResult> {
  const index = await getProjectIndex(reader);
  const format = options.format || 'mermaid';
  const detail = options.detail || 'standard';

  const layoutBindings: Record<string, string> = {};
  for (const [layout, sheet] of index.layoutToEventSheet) {
    layoutBindings[layout] = sheet;
  }

  const warnings = [...index.warnings];

  if (format === 'json') {
    return {
      format: 'json',
      nodes: buildFlowNodes(index, reader, options.eventsheet, detail),
      layoutBindings,
      warnings,
    };
  }

  // Mermaid format
  const diagram = buildMermaidDiagram(index, options.eventsheet, detail);
  return { format: 'mermaid', diagram, layoutBindings, warnings };
}

function buildFlowNodes(
  index: ProjectIndex,
  reader: Construct3ProjectReader,
  specificSheet: string | undefined,
  detail: string
): EventSheetFlowNode[] {
  const sheets = specificSheet
    ? getReachableSheets(index, specificSheet)
    : index.allEventSheets;

  return sheets.map(sheetName => {
    const includes = index.eventSheetIncludes.get(sheetName) || [];
    const includedBy = index.eventSheetIncludedBy.get(sheetName) || [];
    const layout = findLayoutForSheet(index, sheetName);

    // Count functions and groups from references
    let functionCount = 0;
    let groupCount = 0;
    for (const def of index.functionDefinitionList) {
      if (def.sheet === sheetName) functionCount++;
    }
    // Approximate group count from the event sheet references
    const refs = index.objectToEventSheets;
    let eventCount = 0;
    for (const [, objRefs] of refs) {
      // One per condition/action (its own object), not its parameter, expression or script references
      eventCount += objRefs.filter(r => r.eventSheet === sheetName && (r.context === 'condition' || r.context === 'action')).length;
    }

    return {
      name: sheetName,
      includes,
      includedBy,
      layout,
      eventCount,
      functionCount,
      groupCount,
    };
  });
}

function buildMermaidDiagram(
  index: ProjectIndex,
  specificSheet: string | undefined,
  detail: string
): string {
  const lines: string[] = ['graph TD'];

  const sheets = specificSheet
    ? getReachableSheets(index, specificSheet)
    : index.allEventSheets;

  const sheetSet = new Set(sheets);

  // Include edges
  for (const sheet of sheets) {
    const includes = index.eventSheetIncludes.get(sheet) || [];
    for (const included of includes) {
      if (sheetSet.has(included)) {
        lines.push(`  ${sanitizeMermaidId(sheet)} --> ${sanitizeMermaidId(included)}`);
      }
    }
  }

  // Layout bindings (dashed edges)
  for (const [layout, eventSheet] of index.layoutToEventSheet) {
    if (sheetSet.has(eventSheet)) {
      lines.push(`  ${sanitizeMermaidId(layout)}[${layout}] -.->|event sheet| ${sanitizeMermaidId(eventSheet)}`);
    }
  }

  // Add function counts as node labels in standard/full detail
  if (detail !== 'summary') {
    for (const sheet of sheets) {
      let funcCount = 0;
      for (const def of index.functionDefinitionList) {
        if (def.sheet === sheet) funcCount++;
      }
      if (funcCount > 0) {
        lines.push(`  ${sanitizeMermaidId(sheet)}["${sheet} (${funcCount} fn)"]`);
      }
    }
  }

  return lines.join('\n');
}

function getReachableSheets(index: ProjectIndex, startSheet: string): string[] {
  const visited = new Set<string>();
  const stack = [startSheet];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);

    const includes = index.eventSheetIncludes.get(current) || [];
    for (const included of includes) {
      if (!visited.has(included)) {
        stack.push(included);
      }
    }
  }

  return [...visited];
}

function findLayoutForSheet(index: ProjectIndex, sheetName: string): string | undefined {
  for (const [layout, sheet] of index.layoutToEventSheet) {
    if (sheet === sheetName) return layout;
  }
  return undefined;
}

function sanitizeMermaidId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
}

/**
 * Get function definitions and call sites across the project.
 */
export async function getFunctionMap(
  reader: Construct3ProjectReader,
  options: {
    eventsheet?: string;
    detail?: 'summary' | 'standard' | 'full';
  } = {}
): Promise<FunctionMapResult> {
  const index = await getProjectIndex(reader);

  const functions: FunctionMapResult['functions'] = [];
  let totalCallSites = 0;
  const uncalledFunctions: string[] = [];
  // Function blocks whose names match ignoring case are listed one by one;
  // calls name them by name, so they share their call sites (counted once)
  const byName = new Map<string, Array<{ name: string; sheet: string }>>();
  for (const def of index.functionDefinitionList) {
    const key = def.name.toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), def]);
  }
  const counted = new Set<string>();

  for (const def of index.functionDefinitionList) {
    if (options.eventsheet && def.sheet !== options.eventsheet) continue;
    const key = def.name.toLowerCase();

    const callSites = index.getFunctionCalls(def.name);
    if (!counted.has(key)) totalCallSites += callSites.length;
    counted.add(key);

    if (callSites.length === 0 && !uncalledFunctions.includes(def.name)) {
      uncalledFunctions.push(def.name);
    }

    const others = (byName.get(key) ?? []).filter(o => o !== def).map(o => ({ name: o.name, sheet: o.sheet }));
    functions.push({
      name: def.name,
      sheet: def.sheet,
      params: def.params,
      callSites: options.detail === 'full' ? callSites : callSites.slice(0, 10),
      callCount: callSites.length,
      ...(others.length > 0 ? { sameNameAs: others } : {}),
    });
  }
  const duplicateFunctionNames = [...byName.values()].filter(g => g.length > 1).map(g => g[0].name);

  // Sort by call count descending
  functions.sort((a, b) => b.callCount - a.callCount);

  return {
    functions: options.detail === 'summary' ? functions.slice(0, 20) : functions,
    summary: {
      totalFunctions: functions.length,
      totalCallSites,
      uncalledFunctions,
      ...(duplicateFunctionNames.length > 0 ? { duplicateFunctionNames } : {}),
    },
  };
}
