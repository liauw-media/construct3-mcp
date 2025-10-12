#!/usr/bin/env node

/**
 * Construct3 MCP Server
 * Model Context Protocol server for Construct 3 game engine projects
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Construct3ProjectReader } from './construct3/project-reader.js';
import { registerProjectResources } from './resources/project.js';
import { registerDocsResources } from './resources/docs.js';
import { registerQueryTools } from './tools/query.js';
import { registerWorkflowPrompts } from './prompts/workflows.js';

// Get project path from command line argument or environment variable
const projectPath =
  process.argv[2] || process.env.C3_PROJECT_PATH || process.cwd();

// Initialize the MCP server
const server = new Server(
  {
    name: 'construct3-mcp-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      resources: {},
      tools: {},
      prompts: {},
    },
  }
);

// Global project reader instance
let projectReader: Construct3ProjectReader | null = null;

/**
 * Initialize the Construct3 project reader
 */
async function initializeProject(path: string): Promise<void> {
  try {
    // Try to find project file if path is a directory
    let projectFile = path;
    if (!path.endsWith('.c3proj')) {
      const foundProject =
        await Construct3ProjectReader.findProjectFile(path);
      if (!foundProject) {
        throw new Error(
          `No .c3proj file found in directory: ${path}`
        );
      }
      projectFile = foundProject;
    }

    // Validate project file
    const isValid = await Construct3ProjectReader.isValidProject(projectFile);
    if (!isValid) {
      throw new Error(`Invalid Construct3 project file: ${projectFile}`);
    }

    // Initialize reader and load project
    projectReader = new Construct3ProjectReader(projectFile);
    await projectReader.loadProject();

    console.error(
      `✓ Loaded Construct3 project: ${projectReader.getMetadata().name}`
    );
  } catch (error) {
    console.error(
      `✗ Failed to initialize project: ${error instanceof Error ? error.message : String(error)}`
    );
    throw error;
  }
}

/**
 * Get or initialize project reader
 */
function getProjectReader(): Construct3ProjectReader {
  if (!projectReader) {
    throw new Error(
      'Project not initialized. Please ensure a valid Construct3 project is loaded.'
    );
  }
  return projectReader;
}

// Register MCP handlers

// List available resources
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const reader = getProjectReader();
  const objects = await reader.listObjectTypes();
  const eventSheets = await reader.listEventSheets();
  const layouts = await reader.listLayouts();

  return {
    resources: [
      {
        uri: 'construct3://project/info',
        name: 'Project Information',
        description: 'Basic metadata about the Construct3 project',
        mimeType: 'application/json',
      },
      {
        uri: 'construct3://project/structure',
        name: 'Project Structure',
        description: 'Complete overview of the project structure',
        mimeType: 'application/json',
      },
      {
        uri: 'construct3://project/addons',
        name: 'Project Addons',
        description: 'List of all plugins, behaviors, and effects',
        mimeType: 'application/json',
      },
      ...objects.map((obj) => ({
        uri: `construct3://objects/${obj}`,
        name: `Object: ${obj}`,
        description: `Details for object type "${obj}"`,
        mimeType: 'application/json',
      })),
      ...eventSheets.map((es) => ({
        uri: `construct3://eventsheets/${es}`,
        name: `Event Sheet: ${es}`,
        description: `Details for event sheet "${es}"`,
        mimeType: 'application/json',
      })),
      ...layouts.map((layout) => ({
        uri: `construct3://layouts/${layout}`,
        name: `Layout: ${layout}`,
        description: `Details for layout "${layout}"`,
        mimeType: 'application/json',
      })),
      {
        uri: 'construct3://docs/index',
        name: 'Construct3 Documentation Index',
        description: 'Index of available Construct3 documentation topics',
        mimeType: 'application/json',
      },
    ],
  };
});

// Read a specific resource
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const reader = getProjectReader();
  const uri = request.params.uri;

  // Parse URI
  if (!uri.startsWith('construct3://')) {
    throw new Error(`Invalid resource URI: ${uri}`);
  }

  const path = uri.replace('construct3://', '');
  const [category, ...rest] = path.split('/');

  if (category === 'project') {
    if (rest[0] === 'info') {
      const metadata = reader.getMetadata();
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(metadata, null, 2),
          },
        ],
      };
    } else if (rest[0] === 'structure') {
      const project = reader.getProject();
      const structure = {
        metadata: reader.getMetadata(),
        counts: {
          objectTypes: project.objectTypes.items.length,
          eventSheets: project.eventSheets.items.length,
          layouts: project.layouts.items.length,
          families: project.families.items.length,
          addons: project.usedAddons.length,
        },
        objectTypes: project.objectTypes,
        eventSheets: project.eventSheets,
        layouts: project.layouts,
        families: project.families,
      };
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(structure, null, 2),
          },
        ],
      };
    } else if (rest[0] === 'addons') {
      const addons = reader.getUsedAddons();
      const categorized = {
        plugins: addons.filter((a) => a.type === 'plugin'),
        behaviors: addons.filter((a) => a.type === 'behavior'),
        effects: addons.filter((a) => a.type === 'effect'),
        total: addons.length,
      };
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(categorized, null, 2),
          },
        ],
      };
    }
  } else if (category === 'objects' && rest.length > 0) {
    const objectName = rest.join('/');
    const objectData = await reader.readObjectType(objectName);
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(objectData, null, 2),
        },
      ],
    };
  } else if (category === 'eventsheets' && rest.length > 0) {
    const eventSheetName = rest.join('/');
    const eventSheetData = await reader.readEventSheet(eventSheetName);
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(eventSheetData, null, 2),
        },
      ],
    };
  } else if (category === 'layouts' && rest.length > 0) {
    const layoutName = rest.join('/');
    const layoutData = await reader.readLayout(layoutName);
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(layoutData, null, 2),
        },
      ],
    };
  } else if (category === 'docs') {
    if (rest[0] === 'index') {
      const docIndex = {
        manual: 'https://www.construct.net/en/make-games/manuals/construct-3',
        categories: {
          interface: 'User interface and editor',
          project: 'Project structure and primitives',
          plugins: 'Plugin reference',
          behaviors: 'Behavior reference',
          effects: 'Effect reference',
          scripting: 'JavaScript scripting',
          publishing: 'Exporting and publishing',
        },
        popularTopics: [
          'sprite', 'text', 'button', 'touch', 'keyboard', 'mouse',
          'audio', 'ajax', 'array', 'dictionary', 'json', 'localstorage',
          'browser', 'platforminfo',
        ],
      };
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(docIndex, null, 2),
          },
        ],
      };
    } else if (rest[0] === 'manual' && rest.length > 1) {
      const topic = rest.slice(1).join('/').toLowerCase();
      const docUrls: Record<string, string> = {
        'sprite': 'https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/sprite',
        'text': 'https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/text',
        'button': 'https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/button',
        'touch': 'https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/touch',
        'keyboard': 'https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/keyboard',
        'mouse': 'https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/mouse',
        'audio': 'https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/audio',
        'ajax': 'https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/ajax',
        'array': 'https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/array',
        'dictionary': 'https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/dictionary',
        'json': 'https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/json',
        'localstorage': 'https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/local-storage',
        'browser': 'https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/browser',
        'eventsheets': 'https://www.construct.net/en/make-games/manuals/construct-3/event-features',
        'layouts': 'https://www.construct.net/en/make-games/manuals/construct-3/project-primitives/layouts',
      };

      const url = docUrls[topic] || `https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/${topic}`;
      return {
        contents: [
          {
            uri,
            mimeType: 'text/markdown',
            text: `# Construct3 Documentation: ${topic}

**Official Documentation URL**: ${url}

Visit the link above for complete documentation on ${topic}.

For the most up-to-date information, always refer to the official Construct3 manual.

**Quick Links**:
- [Full Manual](https://www.construct.net/en/make-games/manuals/construct-3)
- [Tutorials](https://www.construct.net/en/make-games/manuals/construct-3/tutorials)
- [Forums](https://www.construct.net/en/forum/construct-3)`,
          },
        ],
      };
    }
  }

  throw new Error(`Resource not found: ${uri}`);
});

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'list_objects',
        description: 'List all object types in the Construct3 project',
        inputSchema: {
          type: 'object',
          properties: {
            filter: {
              type: 'string',
              description: 'Optional filter pattern to search for object names',
            },
          },
        },
      },
      {
        name: 'list_eventsheets',
        description: 'List all event sheets in the Construct3 project',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'list_layouts',
        description: 'List all layouts in the Construct3 project',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'list_families',
        description: 'List all object families in the Construct3 project',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'get_object_details',
        description: 'Get detailed information about a specific object type',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'The name of the object type',
            },
          },
          required: ['name'],
        },
      },
      {
        name: 'get_eventsheet_details',
        description: 'Get detailed information about a specific event sheet',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'The name of the event sheet',
            },
          },
          required: ['name'],
        },
      },
      {
        name: 'get_layout_details',
        description: 'Get detailed information about a specific layout',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'The name of the layout',
            },
          },
          required: ['name'],
        },
      },
      {
        name: 'search_objects',
        description: 'Search for objects by name pattern',
        inputSchema: {
          type: 'object',
          properties: {
            pattern: {
              type: 'string',
              description: 'Search pattern (case-insensitive)',
            },
          },
          required: ['pattern'],
        },
      },
      {
        name: 'get_project_summary',
        description: 'Get a comprehensive summary of the entire project',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ],
  };
});

// Call a tool
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const reader = getProjectReader();
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'list_objects': {
        const filter = (args as any)?.filter;
        const objects = filter
          ? reader.searchObjects(filter)
          : await reader.listObjectTypes();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  count: objects.length,
                  objects: objects,
                  filtered: !!filter,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case 'list_eventsheets': {
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
      }

      case 'list_layouts': {
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
      }

      case 'list_families': {
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
      }

      case 'get_object_details': {
        const objectName = (args as any)?.name;
        if (!objectName) {
          throw new Error('Object name is required');
        }
        const objectData = await reader.readObjectType(objectName);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(objectData, null, 2),
            },
          ],
        };
      }

      case 'get_eventsheet_details': {
        const eventSheetName = (args as any)?.name;
        if (!eventSheetName) {
          throw new Error('Event sheet name is required');
        }
        const eventSheetData = await reader.readEventSheet(eventSheetName);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(eventSheetData, null, 2),
            },
          ],
        };
      }

      case 'get_layout_details': {
        const layoutName = (args as any)?.name;
        if (!layoutName) {
          throw new Error('Layout name is required');
        }
        const layoutData = await reader.readLayout(layoutName);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(layoutData, null, 2),
            },
          ],
        };
      }

      case 'search_objects': {
        const pattern = (args as any)?.pattern;
        if (!pattern) {
          throw new Error('Search pattern is required');
        }
        const results = reader.searchObjects(pattern);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  pattern: pattern,
                  count: results.length,
                  results: results,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case 'get_project_summary': {
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
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error executing tool "${name}": ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
});

// List available prompts
server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return {
    prompts: [
      {
        name: 'analyze_project',
        description:
          'Get a detailed analysis of the Construct3 project structure and organization',
      },
      {
        name: 'find_object_usage',
        description: 'Find where a specific object is used throughout the project',
        arguments: [
          {
            name: 'objectName',
            description: 'The name of the object to search for',
            required: true,
          },
        ],
      },
      {
        name: 'explain_eventsheet',
        description: 'Get a detailed explanation of how an event sheet works',
        arguments: [
          {
            name: 'eventSheetName',
            description: 'The name of the event sheet to explain',
            required: true,
          },
        ],
      },
      {
        name: 'review_game_logic',
        description: 'Review the overall game logic and architecture',
      },
      {
        name: 'document_object',
        description: 'Generate documentation for a specific object type',
        arguments: [
          {
            name: 'objectName',
            description: 'The name of the object to document',
            required: true,
          },
        ],
      },
      {
        name: 'optimize_project',
        description: 'Get optimization suggestions for the project',
      },
    ],
  };
});

// Get a specific prompt
server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const reader = getProjectReader();
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'analyze_project': {
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
    }

    case 'find_object_usage': {
      const objectName = (args as any)?.objectName;
      if (!objectName) {
        throw new Error('objectName argument is required');
      }
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Please help me find all references to the object "${objectName}" in this Construct3 project.

Search through:
1. Event sheets (look for conditions and actions referencing this object)
2. Layouts (check if it's placed in any layouts)
3. Other objects (check for references in behaviors or properties)

Provide a comprehensive list of where this object is used.`,
            },
          },
        ],
      };
    }

    case 'explain_eventsheet': {
      const eventSheetName = (args as any)?.eventSheetName;
      if (!eventSheetName) {
        throw new Error('eventSheetName argument is required');
      }
      const eventSheet = await reader.readEventSheet(eventSheetName);
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Please explain how this Construct3 event sheet works:

Event Sheet: ${eventSheetName}

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
    }

    case 'review_game_logic': {
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
    }

    case 'document_object': {
      const objectName = (args as any)?.objectName;
      if (!objectName) {
        throw new Error('objectName argument is required');
      }
      const objectData = await reader.readObjectType(objectName);
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Please create comprehensive documentation for this Construct3 object:

Object: ${objectName}

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
    }

    case 'optimize_project': {
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
    }

    default:
      throw new Error(`Unknown prompt: ${name}`);
  }
});

// Main startup
async function main() {
  try {
    console.error('Construct3 MCP Server starting...');
    console.error(`Project path: ${projectPath}`);

    // Initialize the project
    await initializeProject(projectPath);

    // Start the server with stdio transport
    const transport = new StdioServerTransport();
    await server.connect(transport);

    console.error('✓ Construct3 MCP Server ready');
  } catch (error) {
    console.error(
      `✗ Failed to start server: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}

main();
