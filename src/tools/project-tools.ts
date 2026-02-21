/**
 * Project metadata tools: update_project_metadata.
 */

import { z } from 'zod';
import type { MutationToolDeps } from './shared.js';
import type { WriteResult } from '../construct3/types.js';
import { toolResult, toolError } from './shared.js';

export function registerProjectTools({ server, writer }: MutationToolDeps) {
  server.tool(
    'update_project_metadata',
    'Update project metadata (name, version, author, description)',
    {
      name: z.string().max(200).optional().describe('Project name'),
      version: z.string().max(50).optional().describe('Project version'),
      author: z.string().max(200).optional().describe('Author name'),
      description: z.string().max(1000).optional().describe('Project description'),
    },
    async (args) => {
      try {
        const updates: Record<string, unknown> = {};
        if (args.name !== undefined) updates.name = args.name;
        if (args.version !== undefined) updates.version = args.version;
        if (args.author !== undefined) updates.author = args.author;
        if (args.description !== undefined) updates.description = args.description;

        if (Object.keys(updates).length === 0) {
          return toolError('No updates provided. Specify at least one of: name, version, author, description.');
        }

        const backupPath = await writer.updateProjectProperties(updates);

        const result: WriteResult = {
          success: true,
          entity: 'project',
          category: 'project',
          action: 'updated',
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        return toolError(`Error updating project metadata: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
