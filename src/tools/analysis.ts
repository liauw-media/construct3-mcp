/**
 * MCP Tools for Phase 2 analysis features.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Construct3ProjectReader } from '../construct3/project-reader.js';
import { getEventSheetFlow, getFunctionMap } from '../construct3/analyzers/event-flow.js';
import { getObjectDependencies, findOrphanedObjects } from '../construct3/analyzers/object-deps.js';
import { getAssetUsage } from '../construct3/analyzers/asset-usage.js';
import { analyzePerformance } from '../construct3/analyzers/performance.js';
import { validateProjectIntegrity } from '../construct3/analyzers/integrity.js';
import { getGroupSettings } from '../construct3/analyzers/group-settings.js';
import { buildEventOutline, locateEvent, renderOutline } from '../construct3/analyzers/event-outline.js';
import type { EventSheet } from '../construct3/types.js';
import { notFoundError, toolError, toolResult } from './shared.js';
import { findRuntimeTraps } from '../construct3/analyzers/runtime-traps.js';
import { withProjectSync } from './project-sync.js';

const detailSchema = z.enum(['summary', 'standard', 'full']).optional().default('standard')
  .describe('Level of detail: summary (<2K tokens), standard, or full');

export function registerAnalysisTools(mcpServer: McpServer, reader: Construct3ProjectReader) {
  const server = withProjectSync(mcpServer, reader);
  // Tool: Event sheet flow visualization
  server.tool(
    'get_eventsheet_flow',
    'Get event sheet include hierarchy and layout bindings as Mermaid diagram or JSON',
    {
      eventsheet: z.string().max(200).optional().describe('Specific event sheet to start from (omit for full project)'),
      format: z.enum(['mermaid', 'json']).optional().default('mermaid').describe('Output format'),
      detail: detailSchema,
    },
    async (args) => {
      try {
        const result = await getEventSheetFlow(reader, {
          eventsheet: args.eventsheet,
          format: args.format,
          detail: args.detail,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );

  // Tool: Function map
  server.tool(
    'get_function_map',
    'Get function definitions and call sites across event sheets. Call sites are Call function actions, Functions.Name(...) calls in expressions and function map registrations (Map function / Map function default), each marked with "via"; function names match ignoring case.',
    {
      eventsheet: z.string().max(200).optional().describe('Filter to a specific event sheet'),
      detail: detailSchema,
    },
    async (args) => {
      try {
        const result = await getFunctionMap(reader, {
          eventsheet: args.eventsheet,
          detail: args.detail,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );

  // Tool: Object dependencies
  server.tool(
    'get_object_dependencies',
    'Get where objects are used (event sheets, layouts including sub-layers and object properties, families, co-occurring objects). Project-wide, orphanedObjects follows find_orphaned_objects, and orphanedFamilyMembers lists the orphans that are family members with their families (delete_object refuses them until they leave the family). Event sheets, layouts and families that could not be parsed (over the 10MB read limit, not valid JSON) are searched as text and listed in unscannedFiles: an object whose name (or SID) such a file holds, or any object when such a file cannot be read at all, gets possiblyReferencedIn (not counted in referenceCount) and, project-wide, is listed in possiblyUsedObjects instead of orphanedObjects. An object whose own object type file could not be parsed gets "unanalysed" (its SID is unknown, so references by SID are not counted) and, without a use found, is listed in unanalysedObjects instead of orphanedObjects',
    {
      object: z.string().max(200).optional().describe('Specific object name (omit for project-wide top 20)'),
      detail: detailSchema,
    },
    async (args) => {
      try {
        const result = await getObjectDependencies(reader, {
          object: args.object,
          detail: args.detail,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );

  // Tool: Find orphaned objects
  server.tool(
    'find_orphaned_objects',
    'Find objects not used by any event (as condition/action object, object parameter, expression, runtime.objects in a script action or the literal name of System "Create object (by name)"; directly or through a family), not placed in any layout (on any layer or sub-layer, including non-world instances) and not named by an object property of another instance. An orphan that is a member of a family lists it in "families": delete_object refuses it until it leaves the family. Event sheets, layouts and families that could not be parsed (over the 10MB read limit, not valid JSON) are searched as text and listed in unscannedFiles: an object whose name (or SID) such a file holds, or any object when such a file cannot be read at all, is listed in possiblyUsed with those files instead of orphanedObjects. An object whose own object type file could not be parsed (its SID is unknown, so uses by SID cannot be looked up) is listed in unanalysedObjects with the reason instead. Project script files are not scanned.',
    {},
    async () => {
      try {
        const result = await findOrphanedObjects(reader);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );

  // Tool: Asset usage tracking
  server.tool(
    'get_asset_usage',
    'Track sound, music, image (sprite animations and single-image objects), font, video, icon and project file usage across the project. '
      + 'Each asset is used, unused or not-analysed (with a reason); unused and not-analysed assets are listed first.',
    {
      type: z.enum(['sound', 'music', 'image', 'font', 'video', 'icon', 'general', 'all']).optional().default('all')
        .describe('Filter by asset type'),
      detail: detailSchema,
    },
    async (args) => {
      try {
        const result = await getAssetUsage(reader, {
          type: args.type,
          detail: args.detail,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );

  // Tool: Performance analysis
  server.tool(
    'analyze_performance',
    'Run heuristic performance audit with categorized issues (info/warning/critical)',
    {
      scope: z.string().max(200).optional().describe('Event sheet or layout name to scope analysis to'),
      detail: detailSchema,
    },
    async (args) => {
      try {
        const result = await analyzePerformance(reader, {
          scope: args.scope,
          detail: args.detail,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );

  // Tool: Project integrity validation
  server.tool(
    'validate_project',
    'Run integrity checks: file existence, duplicate SIDs/UIDs, broken references, orphaned files, and the rules the Construct 3 editor enforces when opening a project (trigger placement, expression syntax, empty expressions, duplicate object names, family plugins). `valid` means no errors AND every file was checked; `complete` is false (and so is `valid`) when a registered object type, family, event sheet or layout file exists but was not checked (over the 10MB read cap, invalid JSON, unreadable; listed in `unscannedFiles`), so no check covered its contents.',
    {},
    async () => {
      try {
        const result = await validateProjectIntegrity(reader);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );

  // Tool: Group settings analysis
  server.tool(
    'get_group_settings',
    'Get all event group settings (isActiveOnStart, disabled) across event sheets. Useful for migration validation.',
    {
      eventsheet: z.string().max(200).optional().describe('Filter to a specific event sheet'),
      activeOnly: z.boolean().optional().describe('Only show groups with isActiveOnStart=true'),
      inactiveOnly: z.boolean().optional().describe('Only show groups with isActiveOnStart=false'),
    },
    async (args) => {
      try {
        const result = await getGroupSettings(reader, {
          eventsheet: args.eventsheet,
          activeOnly: args.activeOnly,
          inactiveOnly: args.inactiveOnly,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );

  /**
   * Read a sheet for the event-number tools. A sheet the project does not list is
   * "not found"; any other failure (e.g. malformed JSON) is passed through.
   */
  async function readSheet(name: string): Promise<{ sheet: EventSheet } | { error: ReturnType<typeof toolError> }> {
    try {
      return { sheet: await reader.readEventSheet(name) };
    } catch (error) {
      const listed = await reader.listEventSheets().then(names => names.includes(name), () => false);
      if (!listed) {
        return { error: notFoundError('Event sheet', name, reader.findNearestName(name, 'eventsheets'), 'list_eventsheets') };
      }
      return { error: toolError(`Error reading event sheet "${name}": ${error instanceof Error ? error.message : String(error)}`) };
    }
  }

  // Tool: Map an editor event number ("es_game, event 72, action 1") to JSON
  server.tool(
    'locate_event',
    'Map an editor event number (as in "es_game, event 72, action 1", or "es_game, number 72, action 1" in script syntax errors) ' +
      'to its JSON path, sid and content. ' +
      'Editor numbers follow display order (depth-first, sub-events and function bodies inline), not the events[] index. ' +
      'Returns the neighbouring events so the mapping can be confirmed, and notes naming the other reading when a numbering rule is unverified.',
    {
      sheet: z.string().max(200).describe('Event sheet name'),
      eventNumber: z.number().int().min(1)
        .describe('Event number as shown by the editor or an error message ("event N" or "number N"; 1-based)'),
      conditionNumber: z.number().int().min(1).optional().describe('Condition number within the event (1-based)'),
      actionNumber: z.number().int().min(0).optional()
        .describe('Action number within the event, as in "action 1" (counted from actionIndexBase)'),
      countActionComments: z.boolean().optional()
        .describe('Count action comment rows when resolving actionNumber (default true, verified for runtime script errors); disabled rows always count'),
      actionIndexBase: z.number().int().min(0).max(1).optional()
        .describe('Number of the first action: 1 (default, verified for runtime script errors) or 0 (editor load errors per c3-skill; unverified)'),
    },
    async (args) => {
      const read = await readSheet(args.sheet);
      if ('error' in read) return read.error;
      try {
        const outline = buildEventOutline(args.sheet, read.sheet.events);
        return toolResult(locateEvent(outline, args.eventNumber, {
          conditionNumber: args.conditionNumber,
          actionNumber: args.actionNumber,
          countActionComments: args.countActionComments,
          actionIndexBase: args.actionIndexBase === 0 ? 0 : 1,
        }));
      } catch (error) {
        return toolError(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // Tool: Readable event sheet outline with editor event numbers
  server.tool(
    'get_eventsheet_outline',
    'Compact, readable outline of an event sheet with editor event numbers ' +
      '(IF conditions, DO actions, CALL functions, SCRIPT first lines, GROUP, FUNCTION, VAR, INCLUDE, COMMENT). ' +
      'Paged for large sheets: a page holds up to limit events and about 40,000 characters; ' +
      'continue from the "Next page: startEvent=N" in its header.',
    {
      sheet: z.string().max(200).describe('Event sheet name'),
      startEvent: z.number().int().min(1).optional().default(1).describe('First event number to show (default 1)'),
      limit: z.number().int().min(1).max(1000).optional().default(100)
        .describe('Maximum number of events per page (default 100); with maxDepth, only the events shown count. ' +
          'A page also ends early at about 40,000 characters, see "Next page" in the header'),
      maxDepth: z.number().int().min(0).max(50).optional()
        .describe('Deepest nesting level to print (0 = top level only); deeper events keep their numbers but are hidden'),
    },
    async (args) => {
      const read = await readSheet(args.sheet);
      if ('error' in read) return read.error;
      try {
        const outline = buildEventOutline(args.sheet, read.sheet.events);
        const page = renderOutline(outline, {
          startEvent: args.startEvent,
          limit: args.limit,
          maxDepth: args.maxDepth,
        });
        return { content: [{ type: 'text' as const, text: page.text }] };
      } catch (error) {
        return toolError(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // Tool: Runtime trap detection
  server.tool(
    'find_runtime_traps',
    'Find event logic that hangs or throws at runtime: Wait for signal tags nothing signals, unused or non-literal signal tags, and script actions that use function parameters as bare JS identifiers (need localVars.<name>). Read-only; see construct3://docs/pitfalls.',
    {
      eventsheet: z.string().max(200).optional().describe('Only report issues located in this event sheet (signal tags are still matched across all sheets)'),
      detail: detailSchema,
    },
    async (args) => {
      try {
        const result = await findRuntimeTraps(reader, {
          eventsheet: args.eventsheet,
          detail: args.detail,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );
}
