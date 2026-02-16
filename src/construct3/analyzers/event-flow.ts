/**
 * Event sheet flow visualization and function mapping.
 */

import type { Construct3ProjectReader } from '../project-reader.js';
import type { ProjectIndex } from './index-builder.js';
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
    callSites: Array<{ sheet: string; path: string }>;
    callCount: number;
  }>;
  summary: {
    totalFunctions: number;
    totalCallSites: number;
    uncalledFunctions: string[];
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
    for (const [, def] of index.functionDefinitions) {
      if (def.sheet === sheetName) functionCount++;
    }
    // Approximate group count from the event sheet references
    const refs = index.objectToEventSheets;
    let eventCount = 0;
    for (const [, objRefs] of refs) {
      eventCount += objRefs.filter(r => r.eventSheet === sheetName).length;
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
      for (const [, def] of index.functionDefinitions) {
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

  for (const [funcName, def] of index.functionDefinitions) {
    if (options.eventsheet && def.sheet !== options.eventsheet) continue;

    const callSites = index.functionCalls.get(funcName) || [];
    totalCallSites += callSites.length;

    if (callSites.length === 0) {
      uncalledFunctions.push(funcName);
    }

    functions.push({
      name: funcName,
      sheet: def.sheet,
      params: def.params,
      callSites: options.detail === 'full' ? callSites : callSites.slice(0, 10),
      callCount: callSites.length,
    });
  }

  // Sort by call count descending
  functions.sort((a, b) => b.callCount - a.callCount);

  return {
    functions: options.detail === 'summary' ? functions.slice(0, 20) : functions,
    summary: {
      totalFunctions: functions.length,
      totalCallSites,
      uncalledFunctions,
    },
  };
}
