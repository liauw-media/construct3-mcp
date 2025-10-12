/**
 * MCP Resources for Construct3 project information
 */

import { z } from 'zod';
import type { Construct3ProjectReader } from '../construct3/project-reader.js';

export function registerProjectResources(
  server: any,
  reader: Construct3ProjectReader
) {
  // Resource: Project metadata
  server.resource({
    uri: 'construct3://project/info',
    name: 'Project Information',
    description: 'Get basic metadata about the Construct3 project',
    mimeType: 'application/json',
  }, async () => {
    const metadata = reader.getMetadata();
    return {
      contents: [{
        uri: 'construct3://project/info',
        mimeType: 'application/json',
        text: JSON.stringify(metadata, null, 2),
      }],
    };
  });

  // Resource: Project structure overview
  server.resource({
    uri: 'construct3://project/structure',
    name: 'Project Structure',
    description: 'Get a complete overview of the project structure',
    mimeType: 'application/json',
  }, async () => {
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
        uri: 'construct3://project/structure',
        mimeType: 'application/json',
        text: JSON.stringify(structure, null, 2),
      }],
    };
  });

  // Resource: Used addons list
  server.resource({
    uri: 'construct3://project/addons',
    name: 'Project Addons',
    description: 'List all plugins, behaviors, and effects used in the project',
    mimeType: 'application/json',
  }, async () => {
    const addons = reader.getUsedAddons();
    const categorized = {
      plugins: addons.filter((a) => a.type === 'plugin'),
      behaviors: addons.filter((a) => a.type === 'behavior'),
      effects: addons.filter((a) => a.type === 'effect'),
      total: addons.length,
    };
    return {
      contents: [{
        uri: 'construct3://project/addons',
        mimeType: 'application/json',
        text: JSON.stringify(categorized, null, 2),
      }],
    };
  });

  // Resource Template: Specific object type details
  server.resource({
    uri: 'construct3://objects/{name}',
    name: 'Object Type Details',
    description: 'Get detailed information about a specific object type',
    mimeType: 'application/json',
  }, async (params: { name: string }) => {
    try {
      const objectData = await reader.readObjectType(params.name);
      return {
        contents: [{
          uri: `construct3://objects/${params.name}`,
          mimeType: 'application/json',
          text: JSON.stringify(objectData, null, 2),
        }],
      };
    } catch (error) {
      throw new Error(
        `Object type "${params.name}" not found: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  // Resource Template: Specific event sheet details
  server.resource({
    uri: 'construct3://eventsheets/{name}',
    name: 'Event Sheet Details',
    description: 'Get detailed information about a specific event sheet',
    mimeType: 'application/json',
  }, async (params: { name: string }) => {
    try {
      const eventSheetData = await reader.readEventSheet(params.name);
      return {
        contents: [{
          uri: `construct3://eventsheets/${params.name}`,
          mimeType: 'application/json',
          text: JSON.stringify(eventSheetData, null, 2),
        }],
      };
    } catch (error) {
      throw new Error(
        `Event sheet "${params.name}" not found: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  // Resource Template: Specific layout details
  server.resource({
    uri: 'construct3://layouts/{name}',
    name: 'Layout Details',
    description: 'Get detailed information about a specific layout',
    mimeType: 'application/json',
  }, async (params: { name: string }) => {
    try {
      const layoutData = await reader.readLayout(params.name);
      return {
        contents: [{
          uri: `construct3://layouts/${params.name}`,
          mimeType: 'application/json',
          text: JSON.stringify(layoutData, null, 2),
        }],
      };
    } catch (error) {
      throw new Error(
        `Layout "${params.name}" not found: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });
}
