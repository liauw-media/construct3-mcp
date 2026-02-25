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

const detailSchema = z.enum(['summary', 'standard', 'full']).optional().default('standard')
  .describe('Level of detail: summary (<2K tokens), standard, or full');

export function registerAnalysisTools(server: McpServer, reader: Construct3ProjectReader) {
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
    'Get function definitions and call sites across event sheets',
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
    'Get where objects are used (event sheets, layouts, families, co-occurring objects)',
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
    'Find objects not referenced in any event sheet or placed in any layout',
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
    'Track sound, image, font, and video asset usage across the project',
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
    'Run integrity checks: file existence, duplicate SIDs/UIDs, broken references, orphaned files.',
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
}
