/**
 * Object type tools: create_object, update_object_properties, delete_object.
 */

import { z } from 'zod';
import type { MutationToolDeps } from './shared.js';
import type { WriteResult, ObjectType, Instance, Layout } from '../construct3/types.js';
import type { Construct3ProjectReader } from '../construct3/project-reader.js';
import type { Construct3ProjectWriter } from '../construct3/project-writer.js';
import { validateName, validateSubfolder, toolResult, toolError } from './shared.js';
import { getProjectIndex } from '../construct3/analyzers/index-builder.js';
import {
  GLOBAL_PLUGINS,
  NONWORLD_GLOBAL_PLUGINS,
  createSpriteObject,
  createTextObject,
  createTiledBgObject,
  createGlobalObject,
  createGenericObject,
  createInstanceVariable,
  createBehavior,
} from '../construct3/templates.js';

export function registerObjectTools({ server, reader, writer, idGen }: MutationToolDeps) {
  // ─── create_object ──────────────────────────────────────────

  server.tool(
    'create_object',
    'Create a new object type in the Construct3 project',
    {
      name: z.string().max(200).describe('Object name (must be unique, alphanumeric + underscore)'),
      pluginId: z.string().max(100).describe('Plugin ID — "Sprite", "Text", "TiledBg", "NinePatch", "Audio", etc.'),
      isGlobal: z.boolean().optional().default(false).describe('Whether object is global (auto-detected for known global plugins)'),
      subfolder: z.string().max(500).optional().describe('Subfolder path in project (e.g., "UI/Buttons")'),
    },
    async (args) => {
      try {
        validateName(args.name);
        if (args.subfolder) validateSubfolder(args.subfolder);

        // Check uniqueness
        const existing = await reader.listObjectTypes();
        if (existing.includes(args.name)) {
          return toolError(`Object "${args.name}" already exists. Use update_object_properties to modify it.`);
        }

        // Ensure the plugin is registered in usedAddons
        const addonWarning = await writer.ensureAddonRegistered('plugin', args.pluginId);

        const sid = await idGen.generateSid(reader);
        const isSingleglobal = GLOBAL_PLUGINS.has(args.pluginId);
        const isNonworldGlobal = NONWORLD_GLOBAL_PLUGINS.has(args.pluginId);
        let data: ObjectType;
        let uid: number | undefined;

        if (isSingleglobal || (args.isGlobal && !isNonworldGlobal)) {
          uid = await idGen.generateUid(reader);
          const sgiSid = await idGen.generateSid(reader);
          data = createGlobalObject(args.name, args.pluginId, sid, uid, sgiSid);
        } else if (args.pluginId === 'Sprite') {
          const animSid = await idGen.generateSid(reader);
          const imageSpriteId = await idGen.generateImageSpriteId(reader);

          // Write placeholder PNG before JSON — abort if image fails
          await writer.writeImageFiles([{
            objectName: args.name,
            animationName: 'Animation 1',
            frameIndex: 0,
            pluginId: 'Sprite',
            width: 1,
            height: 1,
          }]);

          data = createSpriteObject(args.name, sid, animSid, imageSpriteId);
        } else if (args.pluginId === 'Text') {
          data = createTextObject(args.name, sid);
        } else if (args.pluginId === 'TiledBg') {
          const imageSpriteId = await idGen.generateImageSpriteId(reader);

          // Write placeholder PNG before JSON — abort if image fails
          await writer.writeImageFiles([{
            objectName: args.name,
            animationName: '',
            frameIndex: 0,
            pluginId: 'TiledBg',
            width: 1,
            height: 1,
          }]);

          data = createTiledBgObject(args.name, sid, imageSpriteId);
        } else {
          data = createGenericObject(args.name, args.pluginId, sid);
          // Nonworld-global plugins (Arr, Json, Dictionary) are isGlobal but not singleglobal-inst
          if (isNonworldGlobal) {
            data.isGlobal = true;
          }
        }

        await writer.writeEntityFile('objectTypes', args.name, data, args.subfolder);
        await writer.addToProject('objectTypes', args.name, args.subfolder);

        const warnings: string[] = [];
        if (addonWarning) warnings.push(addonWarning);

        const result: WriteResult = {
          success: true,
          entity: args.name,
          category: 'object',
          action: 'created',
          generatedSid: sid,
          generatedUid: uid,
          warnings: warnings.length > 0 ? warnings : undefined,
        };
        return toolResult(result);
      } catch (error) {
        return toolError(`Error creating object: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── update_object_properties ─────────────────────────────

  server.tool(
    'update_object_properties',
    'Update properties of an existing object type (variables, behaviors, global status)',
    {
      name: z.string().max(200).describe('Existing object name'),
      isGlobal: z.boolean().optional().describe('Change global status'),
      addVariables: z.array(z.object({
        name: z.string().describe('Variable name'),
        type: z.enum(['number', 'string', 'boolean']).describe('Variable type'),
      })).optional().describe('Instance variables to add'),
      removeVariables: z.array(z.string()).optional().describe('Instance variable names to remove'),
      addBehaviors: z.array(z.object({
        behaviorId: z.string().describe('Behavior plugin ID (e.g., "Tween", "Sin", "Timer")'),
        name: z.string().describe('Behavior instance name'),
      })).optional().describe('Behaviors to add'),
      removeBehaviors: z.array(z.string()).optional().describe('Behavior names to remove'),
    },
    async (args) => {
      try {
        // Check at least one update is provided
        if (args.isGlobal === undefined && !args.addVariables?.length && !args.removeVariables?.length && !args.addBehaviors?.length && !args.removeBehaviors?.length) {
          return toolError('No updates provided. Specify at least one of: isGlobal, addVariables, removeVariables, addBehaviors, removeBehaviors.');
        }

        // Read existing object — preserves ALL original fields
        let obj: ObjectType;
        try {
          obj = await reader.readObjectType(args.name);
        } catch {
          const suggestions = reader.findNearestName(args.name, 'objects');
          const hint = suggestions.length > 0
            ? `\nDid you mean: ${suggestions.join(', ')}?`
            : '\nUse list_objects to see all available names.';
          return toolError(`Object "${args.name}" not found.${hint}`);
        }

        const warnings: string[] = [];

        // Update global status
        if (args.isGlobal !== undefined) {
          obj.isGlobal = args.isGlobal;
        }

        // Add variables
        if (args.addVariables && args.addVariables.length > 0) {
          if (!Array.isArray(obj.instanceVariables)) {
            obj.instanceVariables = [];
          }
          const vars = obj.instanceVariables as Array<Record<string, unknown>>;
          for (const v of args.addVariables) {
            if (vars.some(existing => existing.name === v.name)) {
              warnings.push(`Variable "${v.name}" already exists, skipping`);
              continue;
            }
            const sid = await idGen.generateSid(reader);
            vars.push(createInstanceVariable(v.name, v.type, sid));
          }
        }

        // Remove variables
        if (args.removeVariables && args.removeVariables.length > 0) {
          if (Array.isArray(obj.instanceVariables)) {
            const vars = obj.instanceVariables as Array<Record<string, unknown>>;
            for (const varName of args.removeVariables) {
              const idx = vars.findIndex(v => v.name === varName);
              if (idx !== -1) {
                vars.splice(idx, 1);
              } else {
                warnings.push(`Variable "${varName}" not found, skipping`);
              }
            }
          }
        }

        // Add behaviors
        if (args.addBehaviors && args.addBehaviors.length > 0) {
          for (const b of args.addBehaviors) {
            const bWarning = await writer.ensureAddonRegistered('behavior', b.behaviorId);
            if (bWarning) warnings.push(bWarning);
          }

          if (!Array.isArray(obj.behaviorTypes)) {
            obj.behaviorTypes = [];
          }
          const behaviors = obj.behaviorTypes as Array<Record<string, unknown>>;
          for (const b of args.addBehaviors) {
            if (behaviors.some(existing => existing.name === b.name)) {
              warnings.push(`Behavior "${b.name}" already exists, skipping`);
              continue;
            }
            const sid = await idGen.generateSid(reader);
            behaviors.push(createBehavior(b.behaviorId, b.name, sid));
          }
        }

        // Remove behaviors
        if (args.removeBehaviors && args.removeBehaviors.length > 0) {
          if (Array.isArray(obj.behaviorTypes)) {
            const behaviors = obj.behaviorTypes as Array<Record<string, unknown>>;
            for (const bName of args.removeBehaviors) {
              const idx = behaviors.findIndex(b => b.name === bName);
              if (idx !== -1) {
                behaviors.splice(idx, 1);
              } else {
                warnings.push(`Behavior "${bName}" not found, skipping`);
              }
            }
          }
        }

        // Write updated object
        const subfolder = writer.getSubfolderForEntity('objectTypes', args.name);
        const backupPath = await writer.writeEntityFile('objectTypes', args.name, obj, subfolder);

        // Sync layout instances: ensure all instances of this object have
        // behaviors/instanceVariables dicts so C3 can resolve them on load.
        if (args.addBehaviors?.length || args.removeBehaviors?.length || args.addVariables?.length || args.removeVariables?.length) {
          const syncedLayouts = await syncLayoutInstances(reader, writer, args.name);
          if (syncedLayouts.length > 0) {
            warnings.push(`Updated instances in layout(s): ${syncedLayouts.join(', ')}`);
          }
        }

        const result: WriteResult = {
          success: true,
          entity: args.name,
          category: 'object',
          action: 'updated',
          warnings: warnings.length > 0 ? warnings : undefined,
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        return toolError(`Error updating object: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── delete_object ────────────────────────────────────────

  server.tool(
    'delete_object',
    'Delete an object type from the project (checks references first)',
    {
      name: z.string().max(200).describe('Object name to delete'),
      force: z.boolean().optional().default(false).describe('If true, delete even if referenced (does NOT clean up references)'),
    },
    async (args) => {
      try {
        // Verify the object exists
        const existing = await reader.listObjectTypes();
        if (!existing.includes(args.name)) {
          const suggestions = reader.findNearestName(args.name, 'objects');
          const hint = suggestions.length > 0
            ? `\nDid you mean: ${suggestions.join(', ')}?`
            : '\nUse list_objects to see all available names.';
          return toolError(`Object "${args.name}" not found.${hint}`);
        }

        // Check references
        const index = await getProjectIndex(reader);
        const eventSheetRefs = index.getEventSheetsForObject(args.name);
        const layoutRefs = index.objectToLayouts.get(args.name) || [];
        const familyRefs = index.objectToFamilies.get(args.name) || [];

        const hasRefs = eventSheetRefs.length > 0 || layoutRefs.length > 0 || familyRefs.length > 0;

        if (hasRefs && !args.force) {
          return toolResult({
            success: false,
            entity: args.name,
            category: 'object',
            action: 'delete_blocked',
            message: 'Object is still referenced. Use force=true to delete anyway (references will NOT be cleaned up).',
            references: {
              eventSheets: eventSheetRefs,
              layouts: layoutRefs,
              families: familyRefs,
            },
          });
        }

        const warnings: string[] = [];
        if (hasRefs && args.force) {
          warnings.push(`Object deleted but still referenced in: ${[...eventSheetRefs, ...layoutRefs].join(', ')}. References were NOT cleaned up.`);
        }

        const subfolder = writer.getSubfolderForEntity('objectTypes', args.name);
        const backupPath = await writer.deleteEntityFile('objectTypes', args.name, subfolder);
        await writer.removeFromProject('objectTypes', args.name);

        const result: WriteResult = {
          success: true,
          entity: args.name,
          category: 'object',
          action: 'deleted',
          warnings: warnings.length > 0 ? warnings : undefined,
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        return toolError(`Error deleting object: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}

/**
 * Ensure all layout instances of an object type have the standard
 * `behaviors` and `instanceVariables` dicts that C3 expects.
 * Without these, C3 may fail to load the project after a behavior or
 * variable is added to the object type definition.
 *
 * Returns the names of any layouts that were modified.
 */
async function syncLayoutInstances(
  reader: Construct3ProjectReader,
  writer: Construct3ProjectWriter,
  objectName: string,
): Promise<string[]> {
  const layouts = await reader.readAllLayouts();
  const modifiedLayouts: string[] = [];

  for (const [layoutName, layout] of layouts) {
    let modified = false;

    for (const layer of layout.layers) {
      for (const instance of layer.instances) {
        if (instance.type === objectName) {
          modified = ensureInstanceFields(instance) || modified;
        }
      }
    }

    // Also check nonworld-instances
    const nonworld = (layout as Record<string, unknown>)['nonworld-instances'] as Instance[] | undefined;
    if (Array.isArray(nonworld)) {
      for (const instance of nonworld) {
        if (instance.type === objectName) {
          modified = ensureInstanceFields(instance) || modified;
        }
      }
    }

    if (modified) {
      const subfolder = writer.getSubfolderForEntity('layouts', layoutName);
      await writer.writeEntityFile('layouts', layoutName, layout, subfolder);
      modifiedLayouts.push(layoutName);
    }
  }

  return modifiedLayouts;
}

/**
 * Ensure an instance has the standard fields C3 expects.
 * Returns true if the instance was modified.
 */
function ensureInstanceFields(instance: Instance): boolean {
  let modified = false;
  const inst = instance as Record<string, unknown>;

  if (!inst.behaviors || typeof inst.behaviors !== 'object') {
    inst.behaviors = {};
    modified = true;
  }
  if (!inst.instanceVariables || typeof inst.instanceVariables !== 'object') {
    inst.instanceVariables = {};
    modified = true;
  }

  return modified;
}
