/**
 * MCP Tools for querying Construct3 project
 */

import { z } from 'zod';
import type { Construct3ProjectReader } from '../construct3/project-reader.js';

export function registerQueryTools(server: any, reader: Construct3ProjectReader) {
  // Tool: List all objects
  server.tool({
    name: 'list_objects',
    description: 'List all object types in the Construct3 project',
    parameters: z.object({
      filter: z.string().optional().describe('Optional filter pattern to search for object names'),
    }),
  }, async (args: { filter?: string }) => {
    try {
      const objects = args.filter
        ? reader.searchObjects(args.filter)
        : await reader.listObjectTypes();

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                count: objects.length,
                objects: objects,
                filtered: !!args.filter,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error listing objects: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  });

  // Tool: List all event sheets
  server.tool({
    name: 'list_eventsheets',
    description: 'List all event sheets in the Construct3 project',
    parameters: z.object({}),
  }, async () => {
    try {
      const eventSheets = await reader.listEventSheets();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                count: eventSheets.length,
                eventSheets: eventSheets,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error listing event sheets: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  });

  // Tool: List all layouts
  server.tool({
    name: 'list_layouts',
    description: 'List all layouts in the Construct3 project',
    parameters: z.object({}),
  }, async () => {
    try {
      const layouts = await reader.listLayouts();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                count: layouts.length,
                layouts: layouts,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error listing layouts: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  });

  // Tool: List all families
  server.tool({
    name: 'list_families',
    description: 'List all object families in the Construct3 project',
    parameters: z.object({}),
  }, async () => {
    try {
      const families = await reader.listFamilies();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                count: families.length,
                families: families,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error listing families: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  });

  // Tool: Get object details
  server.tool({
    name: 'get_object_details',
    description: 'Get detailed information about a specific object type',
    parameters: z.object({
      name: z.string().describe('The name of the object type'),
    }),
  }, async (args: { name: string }) => {
    try {
      const objectData = await reader.readObjectType(args.name);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(objectData, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error reading object "${args.name}": ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  });

  // Tool: Get event sheet details
  server.tool({
    name: 'get_eventsheet_details',
    description: 'Get detailed information about a specific event sheet',
    parameters: z.object({
      name: z.string().describe('The name of the event sheet'),
    }),
  }, async (args: { name: string }) => {
    try {
      const eventSheetData = await reader.readEventSheet(args.name);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(eventSheetData, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error reading event sheet "${args.name}": ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  });

  // Tool: Get layout details
  server.tool({
    name: 'get_layout_details',
    description: 'Get detailed information about a specific layout',
    parameters: z.object({
      name: z.string().describe('The name of the layout'),
    }),
  }, async (args: { name: string }) => {
    try {
      const layoutData = await reader.readLayout(args.name);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(layoutData, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error reading layout "${args.name}": ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  });

  // Tool: Search objects
  server.tool({
    name: 'search_objects',
    description: 'Search for objects by name pattern',
    parameters: z.object({
      pattern: z.string().describe('Search pattern (case-insensitive)'),
    }),
  }, async (args: { pattern: string }) => {
    try {
      const results = reader.searchObjects(args.pattern);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                pattern: args.pattern,
                count: results.length,
                results: results,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error searching objects: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  });

  // Tool: Get project summary
  server.tool({
    name: 'get_project_summary',
    description: 'Get a comprehensive summary of the entire project',
    parameters: z.object({}),
  }, async () => {
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
        content: [
          {
            type: 'text',
            text: JSON.stringify(summary, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error getting project summary: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  });
}
