/**
 * MCP Prompts for common Construct3 workflows
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Construct3ProjectReader } from '../construct3/project-reader.js';

export function registerWorkflowPrompts(
  server: McpServer,
  reader: Construct3ProjectReader
) {
  server.prompt(
    'analyze_project',
    'Get a detailed analysis of the Construct3 project structure and organization',
    async () => {
      const metadata = reader.getMetadata();
      const objects = await reader.listObjectTypes();
      const eventSheets = await reader.listEventSheets();
      const layouts = await reader.listLayouts();

      return {
        messages: [{
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Please analyze this Construct3 project:\n\nProject: ${metadata.name}\nVersion: ${metadata.version}\nAuthor: ${metadata.author}\nRuntime: ${metadata.runtime}\n\nStatistics:\n- Object Types: ${objects.length}\n- Event Sheets: ${eventSheets.length}\n- Layouts: ${layouts.length}\n\nPlease provide:\n1. An overview of the project structure\n2. Analysis of naming conventions\n3. Potential organizational improvements\n4. Any observed patterns or conventions`,
          },
        }],
      };
    }
  );

  server.prompt(
    'find_object_usage',
    'Find where a specific object is used throughout the project',
    { objectName: z.string().describe('The name of the object to search for') },
    async (args) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `Please help me find all references to the object "${args.objectName}" in this Construct3 project.\n\nSearch through:\n1. Event sheets (look for conditions and actions referencing this object)\n2. Layouts (check if it's placed in any layouts)\n3. Other objects (check for references in behaviors or properties)\n\nProvide a comprehensive list of where this object is used.`,
        },
      }],
    })
  );

  server.prompt(
    'explain_eventsheet',
    'Get a detailed explanation of how an event sheet works',
    { eventSheetName: z.string().describe('The name of the event sheet to explain') },
    async (args) => {
      try {
        const eventSheet = await reader.readEventSheet(args.eventSheetName);
        return {
          messages: [{
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Please explain how this Construct3 event sheet works:\n\nEvent Sheet: ${args.eventSheetName}\n\nEvent Structure:\n${JSON.stringify(eventSheet, null, 2)}\n\nPlease provide:\n1. A high-level overview of what this event sheet does\n2. Explanation of key events and their logic flow\n3. Any included event sheets and their purpose\n4. Suggestions for optimization or improvements`,
            },
          }],
        };
      } catch (error) {
        return {
          messages: [{
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Error: Could not load event sheet "${args.eventSheetName}": ${error instanceof Error ? error.message : String(error)}`,
            },
          }],
        };
      }
    }
  );

  server.prompt(
    'review_game_logic',
    'Review the overall game logic and architecture',
    async () => {
      const eventSheets = await reader.listEventSheets();
      const layouts = await reader.listLayouts();

      return {
        messages: [{
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Please review the game logic architecture of this Construct3 project:\n\nEvent Sheets (${eventSheets.length}):\n${eventSheets.map((es) => `- ${es}`).join('\n')}\n\nLayouts (${layouts.length}):\n${layouts.map((l) => `- ${l}`).join('\n')}\n\nPlease analyze:\n1. How the event sheets are organized and related\n2. The flow between different layouts\n3. Separation of concerns (UI, game logic, data management)\n4. Potential improvements to code organization\n5. Any architectural patterns or anti-patterns observed`,
          },
        }],
      };
    }
  );

  server.prompt(
    'document_object',
    'Generate documentation for a specific object type',
    { objectName: z.string().describe('The name of the object to document') },
    async (args) => {
      try {
        const objectData = await reader.readObjectType(args.objectName);
        return {
          messages: [{
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Please create comprehensive documentation for this Construct3 object:\n\nObject: ${args.objectName}\n\nObject Data:\n${JSON.stringify(objectData, null, 2)}\n\nPlease include:\n1. Object purpose and description\n2. Plugin/type information\n3. Key properties and their meanings\n4. Behaviors attached (if any)\n5. Typical usage patterns\n6. Related objects or dependencies`,
            },
          }],
        };
      } catch (error) {
        return {
          messages: [{
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Error: Could not load object "${args.objectName}": ${error instanceof Error ? error.message : String(error)}`,
            },
          }],
        };
      }
    }
  );

  server.prompt(
    'optimize_project',
    'Get optimization suggestions for the project',
    async () => {
      const metadata = reader.getMetadata();
      const addons = reader.getUsedAddons();
      const objects = await reader.listObjectTypes();

      return {
        messages: [{
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Please suggest optimizations for this Construct3 project:\n\nProject: ${metadata.name}\nViewport: ${metadata.viewportWidth}x${metadata.viewportHeight}\nRuntime: ${metadata.runtime}\n\nObjects: ${objects.length}\nAddons: ${addons.length}\n\nFocus on:\n1. Performance optimizations\n2. Asset organization\n3. Event sheet structure\n4. Object usage patterns\n5. Best practices compliance\n6. Memory management\n\nProvide specific, actionable recommendations.`,
          },
        }],
      };
    }
  );
}
