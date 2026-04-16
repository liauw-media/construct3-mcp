/**
 * Project metadata tools: update_project_metadata, list_addons, register_addon, unregister_addon.
 */

import { z } from 'zod';
import { readFile, writeFile, rename, unlink } from 'fs/promises';
import type { MutationToolDeps } from './shared.js';
import type { WriteResult, Addon } from '../construct3/types.js';
import { toolResult, toolError } from './shared.js';
import { KNOWN_SCIRRA_PLUGINS, KNOWN_SCIRRA_BEHAVIORS } from '../construct3/templates.js';

export function registerProjectTools({ server, reader, writer }: MutationToolDeps) {
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
        console.error('[update_project_metadata] failed:', error);
        return toolError(`Error updating project metadata: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── list_addons ──────────────────────────────────────────

  server.tool(
    'list_addons',
    'List all addons (plugins, behaviors, effects) registered in the project',
    {
      type: z.enum(['plugin', 'behavior', 'effect', 'all']).optional().default('all').describe('Filter by addon type (default: all)'),
    },
    async (args) => {
      try {
        const addons = reader.getUsedAddons();
        const filtered = args.type === 'all' ? addons : addons.filter(a => a.type === args.type);
        return toolResult({
          addons: filtered,
          count: filtered.length,
        });
      } catch (error) {
        console.error('[list_addons] failed:', error);
        return toolError(`Error listing addons: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── register_addon ───────────────────────────────────────

  server.tool(
    'register_addon',
    'Register an addon (plugin, behavior, or effect) in the project usedAddons list. For effects, use this before add_effect since effects are not auto-registered.',
    {
      type: z.enum(['plugin', 'behavior', 'effect']).describe('Addon type'),
      id: z.string().max(200).describe('Addon ID (e.g. "Sprite", "Tween", "hsladjust")'),
      name: z.string().max(200).describe('Human-readable display name'),
      author: z.string().max(200).optional().default('Scirra').describe('Addon author (default: Scirra)'),
      bundled: z.boolean().optional().default(false).describe('Whether the addon is bundled with C3 (default: false)'),
    },
    async (args) => {
      try {
        const addons = reader.getUsedAddons();
        const already = addons.some(a => a.type === args.type && a.id === args.id);
        if (already) {
          return toolResult({
            success: true,
            entity: args.id,
            category: 'addon',
            action: 'already_registered',
            warnings: [`Addon "${args.id}" (${args.type}) is already registered in usedAddons.`],
          });
        }

        const projectPath = reader.getProjectPath();
        const content = await readFile(projectPath, 'utf-8');
        const project = JSON.parse(content);

        const newAddon: Addon = {
          type: args.type,
          id: args.id,
          name: args.name,
          author: args.author,
          bundled: args.bundled,
        };
        project.usedAddons.push(newAddon);

        const tmpPath = projectPath + '.tmp';
        await writeFile(tmpPath, JSON.stringify(project, null, '\t'), 'utf-8');
        try {
          await rename(tmpPath, projectPath);
        } catch (e: unknown) {
          if (e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'EEXIST') {
            await unlink(projectPath);
            await rename(tmpPath, projectPath);
          } else {
            try { await unlink(tmpPath); } catch { /* best-effort */ }
            throw e;
          }
        }
        await reader.reloadProject();

        const result: WriteResult = {
          success: true,
          entity: args.id,
          category: 'addon',
          action: 'created',
        };
        return toolResult(result);
      } catch (error) {
        console.error('[register_addon] failed:', error);
        return toolError(`Error registering addon: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── unregister_addon ─────────────────────────────────────

  server.tool(
    'unregister_addon',
    'Remove an addon from the project usedAddons list. Use with caution — removing an addon that is still used will cause C3 to error on load.',
    {
      type: z.enum(['plugin', 'behavior', 'effect']).describe('Addon type'),
      id: z.string().max(200).describe('Addon ID to remove'),
      force: z.boolean().optional().default(false).describe('Remove even if the addon is a known built-in (default: false — requires force=true for built-ins)'),
    },
    async (args) => {
      try {
        const addons = reader.getUsedAddons();
        const idx = addons.findIndex(a => a.type === args.type && a.id === args.id);
        if (idx === -1) {
          return toolError(`Addon "${args.id}" (${args.type}) is not registered in this project.`);
        }

        // Warn if removing a known built-in
        const knownMap = args.type === 'plugin' ? KNOWN_SCIRRA_PLUGINS : (args.type === 'behavior' ? KNOWN_SCIRRA_BEHAVIORS : {});
        if (knownMap[args.id] && !args.force) {
          return toolError(`"${args.id}" is a known Scirra built-in ${args.type}. Use force=true if you really want to unregister it.`);
        }

        const projectPath = reader.getProjectPath();
        const content = await readFile(projectPath, 'utf-8');
        const project = JSON.parse(content);

        const projIdx = (project.usedAddons as Addon[]).findIndex(a => a.type === args.type && a.id === args.id);
        if (projIdx !== -1) {
          project.usedAddons.splice(projIdx, 1);
        }

        const tmpPath = projectPath + '.tmp';
        await writeFile(tmpPath, JSON.stringify(project, null, '\t'), 'utf-8');
        try {
          await rename(tmpPath, projectPath);
        } catch (e: unknown) {
          if (e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'EEXIST') {
            await unlink(projectPath);
            await rename(tmpPath, projectPath);
          } else {
            try { await unlink(tmpPath); } catch { /* best-effort */ }
            throw e;
          }
        }
        await reader.reloadProject();

        const result: WriteResult = {
          success: true,
          entity: args.id,
          category: 'addon',
          action: 'deleted',
          warnings: [`Addon "${args.id}" removed from usedAddons. If any objects/behaviors still reference it, C3 will error on load.`],
        };
        return toolResult(result);
      } catch (error) {
        console.error('[unregister_addon] failed:', error);
        return toolError(`Error unregistering addon: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
