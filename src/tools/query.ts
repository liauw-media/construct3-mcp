/**
 * MCP Tools for querying Construct3 project
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Construct3ProjectReader } from '../construct3/project-reader.js';

export function registerQueryTools(server: McpServer, reader: Construct3ProjectReader) {
  server.tool(
    'list_objects',
    'List all object types in the Construct3 project',
    { filter: z.string().max(200).optional().describe('Optional filter pattern to search for object names') },
    async (args) => {
      try {
        const objects = args.filter
          ? reader.searchObjects(args.filter)
          : await reader.listObjectTypes();
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ count: objects.length, objects, filtered: !!args.filter }, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error listing objects: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'list_eventsheets',
    'List all event sheets in the Construct3 project',
    {},
    async () => {
      try {
        const eventSheets = await reader.listEventSheets();
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ count: eventSheets.length, eventSheets }, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error listing event sheets: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'list_layouts',
    'List all layouts in the Construct3 project',
    {},
    async () => {
      try {
        const layouts = await reader.listLayouts();
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ count: layouts.length, layouts }, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error listing layouts: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'list_families',
    'List all object families in the Construct3 project',
    {},
    async () => {
      try {
        const families = await reader.listFamilies();
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ count: families.length, families }, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error listing families: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'get_object_details',
    'Get detailed information about a specific object type',
    { name: z.string().max(200).describe('The name of the object type') },
    async (args) => {
      try {
        const objectData = await reader.readObjectType(args.name);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(objectData, null, 2) }],
        };
      } catch (error) {
        const suggestions = reader.findNearestName(args.name, 'objects');
        const hint = suggestions.length > 0 ? `\nDid you mean: ${suggestions.join(', ')}?\nUse list_objects to see all available names.` : '\nUse list_objects to see all available names.';
        return {
          content: [{ type: 'text' as const, text: `Error reading object "${args.name}": ${error instanceof Error ? error.message : String(error)}${hint}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'get_eventsheet_details',
    'Get detailed information about a specific event sheet',
    { name: z.string().max(200).describe('The name of the event sheet') },
    async (args) => {
      try {
        const eventSheetData = await reader.readEventSheet(args.name);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(eventSheetData, null, 2) }],
        };
      } catch (error) {
        const suggestions = reader.findNearestName(args.name, 'eventsheets');
        const hint = suggestions.length > 0 ? `\nDid you mean: ${suggestions.join(', ')}?\nUse list_eventsheets to see all available names.` : '\nUse list_eventsheets to see all available names.';
        return {
          content: [{ type: 'text' as const, text: `Error reading event sheet "${args.name}": ${error instanceof Error ? error.message : String(error)}${hint}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'get_layout_details',
    'Get detailed information about a specific layout',
    { name: z.string().max(200).describe('The name of the layout') },
    async (args) => {
      try {
        const layoutData = await reader.readLayout(args.name);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(layoutData, null, 2) }],
        };
      } catch (error) {
        const suggestions = reader.findNearestName(args.name, 'layouts');
        const hint = suggestions.length > 0 ? `\nDid you mean: ${suggestions.join(', ')}?\nUse list_layouts to see all available names.` : '\nUse list_layouts to see all available names.';
        return {
          content: [{ type: 'text' as const, text: `Error reading layout "${args.name}": ${error instanceof Error ? error.message : String(error)}${hint}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'search_objects',
    'Search for objects by name pattern',
    { pattern: z.string().max(200).describe('Search pattern (case-insensitive)') },
    async (args) => {
      try {
        const results = reader.searchObjects(args.pattern);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ pattern: args.pattern, count: results.length, results }, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error searching objects: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'get_project_summary',
    'Get a comprehensive summary of the entire project',
    {},
    async () => {
      try {
        const metadata = reader.getMetadata();
        const addons = reader.getUsedAddons();
        const objects = await reader.listObjectTypes();
        const eventSheets = await reader.listEventSheets();
        const layouts = await reader.listLayouts();
        const families = await reader.listFamilies();

        const summary = {
          project: metadata,
          statistics: {
            objectTypes: objects.length,
            eventSheets: eventSheets.length,
            layouts: layouts.length,
            families: families.length,
            plugins: addons.filter((a) => a.type === 'plugin').length,
            behaviors: addons.filter((a) => a.type === 'behavior').length,
            effects: addons.filter((a) => a.type === 'effect').length,
          },
          lists: {
            objects: objects.slice(0, 10),
            eventSheets: eventSheets.slice(0, 10),
            layouts: layouts.slice(0, 10),
          },
          note: 'Lists are limited to first 10 items. Use specific list tools for complete data.',
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(summary, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error getting project summary: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );
}
