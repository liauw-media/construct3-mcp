/**
 * MCP Prompts for common Construct3 workflows
 */

import { z } from 'zod';
import type { Construct3ProjectReader } from '../construct3/project-reader.js';

export function registerWorkflowPrompts(
  server: any,
  reader: Construct3ProjectReader
) {
  // Prompt: Analyze project structure
  server.prompt({
    name: 'analyze_project',
    description: 'Get a detailed analysis of the Construct3 project structure and organization',
    parameters: z.object({}),
  }, async () => {
    const metadata = reader.getMetadata();
    const objects = await reader.listObjectTypes();
    const eventSheets = await reader.listEventSheets();
    const layouts = await reader.listLayouts();

    return {
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Please analyze this Construct3 project:

Project: ${metadata.name}
Version: ${metadata.version}
Author: ${metadata.author}
Runtime: ${metadata.runtime}

Statistics:
- Object Types: ${objects.length}
- Event Sheets: ${eventSheets.length}
- Layouts: ${layouts.length}

Please provide:
1. An overview of the project structure
2. Analysis of naming conventions
3. Potential organizational improvements
4. Any observed patterns or conventions`,
          },
        },
      ],
    };
  });

  // Prompt: Find object usage
  server.prompt({
    name: 'find_object_usage',
    description: 'Find where a specific object is used throughout the project',
    parameters: z.object({
      objectName: z.string().describe('The name of the object to search for'),
    }),
  }, async (args: { objectName: string }) => {
    return {
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Please help me find all references to the object "${args.objectName}" in this Construct3 project.

Search through:
1. Event sheets (look for conditions and actions referencing this object)
2. Layouts (check if it's placed in any layouts)
3. Other objects (check for references in behaviors or properties)

Provide a comprehensive list of where this object is used.`,
          },
        },
      ],
    };
  });

  // Prompt: Explain event sheet
  server.prompt({
    name: 'explain_eventsheet',
    description: 'Get a detailed explanation of how an event sheet works',
    parameters: z.object({
      eventSheetName: z.string().describe('The name of the event sheet to explain'),
    }),
  }, async (args: { eventSheetName: string }) => {
    try {
      const eventSheet = await reader.readEventSheet(args.eventSheetName);
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Please explain how this Construct3 event sheet works:

Event Sheet: ${args.eventSheetName}

Event Structure:
${JSON.stringify(eventSheet, null, 2)}

Please provide:
1. A high-level overview of what this event sheet does
2. Explanation of key events and their logic flow
3. Any included event sheets and their purpose
4. Suggestions for optimization or improvements`,
            },
          },
        ],
      };
    } catch (error) {
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Error: Could not load event sheet "${args.eventSheetName}": ${error instanceof Error ? error.message : String(error)}`,
            },
          },
        ],
      };
    }
  });

  // Prompt: Review game logic
  server.prompt({
    name: 'review_game_logic',
    description: 'Review the overall game logic and architecture',
    parameters: z.object({}),
  }, async () => {
    const eventSheets = await reader.listEventSheets();
    const layouts = await reader.listLayouts();

    return {
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Please review the game logic architecture of this Construct3 project:

Event Sheets (${eventSheets.length}):
${eventSheets.map((es) => `- ${es}`).join('\n')}

Layouts (${layouts.length}):
${layouts.map((l) => `- ${l}`).join('\n')}

Please analyze:
1. How the event sheets are organized and related
2. The flow between different layouts
3. Separation of concerns (UI, game logic, data management)
4. Potential improvements to code organization
5. Any architectural patterns or anti-patterns observed`,
          },
        },
      ],
    };
  });

  // Prompt: Document object
  server.prompt({
    name: 'document_object',
    description: 'Generate documentation for a specific object type',
    parameters: z.object({
      objectName: z.string().describe('The name of the object to document'),
    }),
  }, async (args: { objectName: string }) => {
    try {
      const objectData = await reader.readObjectType(args.objectName);
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Please create comprehensive documentation for this Construct3 object:

Object: ${args.objectName}

Object Data:
${JSON.stringify(objectData, null, 2)}

Please include:
1. Object purpose and description
2. Plugin/type information
3. Key properties and their meanings
4. Behaviors attached (if any)
5. Typical usage patterns
6. Related objects or dependencies`,
            },
          },
        ],
      };
    } catch (error) {
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Error: Could not load object "${args.objectName}": ${error instanceof Error ? error.message : String(error)}`,
            },
          },
        ],
      };
    }
  });

  // Prompt: Optimize project
  server.prompt({
    name: 'optimize_project',
    description: 'Get optimization suggestions for the project',
    parameters: z.object({}),
  }, async () => {
    const metadata = reader.getMetadata();
    const addons = reader.getUsedAddons();
    const objects = await reader.listObjectTypes();

    return {
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Please suggest optimizations for this Construct3 project:

Project: ${metadata.name}
Viewport: ${metadata.viewportWidth}x${metadata.viewportHeight}
Runtime: ${metadata.runtime}

Objects: ${objects.length}
Addons: ${addons.length}

Focus on:
1. Performance optimizations
2. Asset organization
3. Event sheet structure
4. Object usage patterns
5. Best practices compliance
6. Memory management

Provide specific, actionable recommendations.`,
          },
        },
      ],
    };
  });
}
