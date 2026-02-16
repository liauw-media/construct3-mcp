/**
 * MCP Resources for Construct3 project information
 */

import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Construct3ProjectReader } from '../construct3/project-reader.js';

export function registerProjectResources(
  server: McpServer,
  reader: Construct3ProjectReader
) {
  // Resource: Project metadata
  server.resource(
    'project-info',
    'construct3://project/info',
    { description: 'Get basic metadata about the Construct3 project', mimeType: 'application/json' },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(reader.getMetadata(), null, 2),
      }],
    })
  );

  // Resource: Project structure overview
  server.resource(
    'project-structure',
    'construct3://project/structure',
    { description: 'Get a complete overview of the project structure', mimeType: 'application/json' },
    async (uri) => {
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
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(structure, null, 2),
        }],
      };
    }
  );

  // Resource: Used addons list
  server.resource(
    'project-addons',
    'construct3://project/addons',
    { description: 'List all plugins, behaviors, and effects used in the project', mimeType: 'application/json' },
    async (uri) => {
      const addons = reader.getUsedAddons();
      const categorized = {
        plugins: addons.filter((a) => a.type === 'plugin'),
        behaviors: addons.filter((a) => a.type === 'behavior'),
        effects: addons.filter((a) => a.type === 'effect'),
        total: addons.length,
      };
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(categorized, null, 2),
        }],
      };
    }
  );

  // Resource Template: Specific object type details
  server.resource(
    'object-details',
    new ResourceTemplate('construct3://objects/{name}', { list: undefined }),
    { description: 'Get detailed information about a specific object type', mimeType: 'application/json' },
    async (uri, variables) => {
      const name = String(variables.name);
      const objectData = await reader.readObjectType(name);
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(objectData, null, 2),
        }],
      };
    }
  );

  // Resource Template: Specific event sheet details
  server.resource(
    'eventsheet-details',
    new ResourceTemplate('construct3://eventsheets/{name}', { list: undefined }),
    { description: 'Get detailed information about a specific event sheet', mimeType: 'application/json' },
    async (uri, variables) => {
      const name = String(variables.name);
      const eventSheetData = await reader.readEventSheet(name);
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(eventSheetData, null, 2),
        }],
      };
    }
  );

  // Resource Template: Specific layout details
  server.resource(
    'layout-details',
    new ResourceTemplate('construct3://layouts/{name}', { list: undefined }),
    { description: 'Get detailed information about a specific layout', mimeType: 'application/json' },
    async (uri, variables) => {
      const name = String(variables.name);
      const layoutData = await reader.readLayout(name);
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(layoutData, null, 2),
        }],
      };
    }
  );
}
