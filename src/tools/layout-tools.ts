/**
 * Layout tools: create_layout, add_instance_to_layout, delete_layout, update_layout.
 */

import { z } from 'zod';
import type { MutationToolDeps } from './shared.js';
import type { WriteResult, Layout } from '../construct3/types.js';
import { validateName, toolResult, toolError } from './shared.js';
import { getProjectIndex } from '../construct3/analyzers/index-builder.js';
import {
  DEFAULT_INSTANCE_PROPERTIES,
  createLayout,
  createInstance,
} from '../construct3/templates.js';
import type { InstanceOverrides } from '../construct3/templates.js';

export function registerLayoutTools({ server, reader, writer, idGen }: MutationToolDeps) {
  // ─── create_layout ────────────────────────────────────────

  server.tool(
    'create_layout',
    'Create a new layout in the project',
    {
      name: z.string().max(200).describe('Layout name'),
      width: z.number().int().positive().optional().describe('Width in pixels (default: project viewport width)'),
      height: z.number().int().positive().optional().describe('Height in pixels (default: project viewport height)'),
      eventSheet: z.string().max(200).optional().describe('Linked event sheet name'),
      layers: z.array(z.string()).optional().describe('Layer names (default: single "Layer 0")'),
    },
    async (args) => {
      try {
        validateName(args.name);

        // Check uniqueness
        const existing = await reader.listLayouts();
        if (existing.includes(args.name)) {
          return toolError(`Layout "${args.name}" already exists.`);
        }

        // Validate event sheet
        if (args.eventSheet) {
          const sheets = await reader.listEventSheets();
          if (!sheets.includes(args.eventSheet)) {
            return toolError(`Event sheet "${args.eventSheet}" does not exist. Use list_eventsheets to see available sheets.`);
          }
        }

        const metadata = reader.getMetadata();
        const width = args.width || metadata.viewportWidth;
        const height = args.height || metadata.viewportHeight;

        const layoutSid = await idGen.generateSid(reader);

        // Generate layer SIDs
        let layerDefs: Array<{ name: string; sid: number }>;
        if (args.layers && args.layers.length > 0) {
          layerDefs = [];
          for (const layerName of args.layers) {
            layerDefs.push({ name: layerName, sid: await idGen.generateSid(reader) });
          }
        } else {
          const layerSid = await idGen.generateSid(reader);
          layerDefs = [{ name: 'Layer 0', sid: layerSid }];
        }

        const data = createLayout(args.name, layoutSid, width, height, args.eventSheet, layerDefs);

        await writer.writeEntityFile('layouts', args.name, data);
        await writer.addToProject('layouts', args.name);

        const result: WriteResult = {
          success: true,
          entity: args.name,
          category: 'layout',
          action: 'created',
          generatedSid: layoutSid,
        };
        return toolResult(result);
      } catch (error) {
        return toolError(`Error creating layout: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── add_instance_to_layout ───────────────────────────────

  server.tool(
    'add_instance_to_layout',
    'Place an object instance on a layout layer. For copying instances between layouts, read the source with get_layout_details and pass instance properties here — all visual and behavioral properties (angle, color, instanceVariables, behaviors, etc.) are preserved when specified.',
    {
      layoutName: z.string().max(200).describe('Target layout'),
      layerName: z.string().max(200).describe('Target layer within layout'),
      objectType: z.string().max(200).describe('Object type name to place'),
      x: z.number().describe('X position'),
      y: z.number().describe('Y position'),
      width: z.number().optional().default(100).describe('Instance width'),
      height: z.number().optional().default(100).describe('Instance height'),
      properties: z.record(z.unknown())
        .refine(obj => JSON.stringify(obj).length <= 50_000, 'Properties payload too large (max 50KB)')
        .optional()
        .describe('Plugin-specific instance properties (auto-filled for known plugins if omitted)'),
      // Instance-level overrides
      angle: z.number().optional().describe('Rotation angle in radians (default: 0)'),
      color: z.array(z.number().min(0).max(1)).length(4).optional().describe('RGBA tint as [r, g, b, a] with values 0-1 (default: [1,1,1,1])'),
      zElevation: z.number().optional().describe('Z elevation for 3D layering (default: 0)'),
      originX: z.number().min(0).max(1).optional().describe('Horizontal origin 0-1 (default: 0.5 = center)'),
      originY: z.number().min(0).max(1).optional().describe('Vertical origin 0-1 (default: 0.5 = center)'),
      instanceVariables: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
        .describe('Instance variable values as {varName: value}'),
      behaviors: z.record(z.string(), z.record(z.unknown()))
        .refine(obj => Object.keys(obj).length <= 50, 'Too many behaviors (max 50)')
        .refine(obj => JSON.stringify(obj).length <= 50_000, 'Behaviors payload too large (max 50KB)')
        .optional()
        .describe('Behavior runtime state as {behaviorName: {prop: val}}'),
      tags: z.string().max(500).regex(/^[a-zA-Z0-9_, ]*$/).optional()
        .describe('Comma-separated instance tags (default: empty)'),
      showing: z.boolean().optional().describe('Whether instance is initially visible (default: true)'),
      locked: z.boolean().optional().describe('Whether instance is locked in the editor (default: false)'),
    },
    async (args) => {
      try {
        // Validate object type exists and read its plugin ID
        let pluginId: string | undefined;
        let isNonworld = false;
        let objData: Record<string, unknown> | undefined;
        try {
          const obj = await reader.readObjectType(args.objectType);
          objData = obj as unknown as Record<string, unknown>;
          pluginId = obj['plugin-id'];
          // Block global-only objects from being placed on layouts
          if (objData['singleglobal-inst']) {
            return toolError(`Object "${args.objectType}" is a global plugin (${pluginId}) and cannot be placed on layouts.`);
          }
          // Nonworld-global objects (Arr, Json, Dictionary) go in nonworld-instances, not on layers
          if (objData.isGlobal === true) {
            isNonworld = true;
          }
        } catch {
          return toolError(`Object type "${args.objectType}" does not exist. Use list_objects to see available objects.`);
        }

        let layout: Layout;
        try {
          layout = await reader.readLayout(args.layoutName);
        } catch {
          const suggestions = reader.findNearestName(args.layoutName, 'layouts');
          const hint = suggestions.length > 0
            ? `\nDid you mean: ${suggestions.join(', ')}?`
            : '\nUse list_layouts to see all available names.';
          return toolError(`Layout "${args.layoutName}" not found.${hint}`);
        }

        const uid = await idGen.generateUid(reader);
        const sid = await idGen.generateSid(reader);
        const warnings: string[] = [];

        // Validate instanceVariables keys against object type definition
        if (args.instanceVariables && objData) {
          const ivDefs = objData.instanceVariables as Array<{ name: string }> | undefined;
          const definedVars = new Set((ivDefs ?? []).map(v => v.name));
          for (const key of Object.keys(args.instanceVariables)) {
            if (!definedVars.has(key)) {
              warnings.push(`Instance variable "${key}" is not defined on "${args.objectType}". Defined variables: ${[...definedVars].join(', ') || '(none)'}. It may be inherited from a family.`);
            }
          }
        }

        // Validate behaviors keys against object type definition
        if (args.behaviors && objData) {
          const bhDefs = objData.behaviorTypes as Array<{ name: string }> | undefined;
          const definedBehaviors = new Set((bhDefs ?? []).map(b => b.name));
          for (const key of Object.keys(args.behaviors)) {
            if (!definedBehaviors.has(key)) {
              warnings.push(`Behavior "${key}" is not defined on "${args.objectType}". Defined behaviors: ${[...definedBehaviors].join(', ') || '(none)'}. It may be inherited from a family.`);
            }
          }
        }

        // Build overrides from optional params
        const overrides: InstanceOverrides = {};
        if (args.angle !== undefined) overrides.angle = args.angle;
        if (args.color !== undefined) overrides.color = args.color;
        if (args.zElevation !== undefined) overrides.zElevation = args.zElevation;
        if (args.originX !== undefined) overrides.originX = args.originX;
        if (args.originY !== undefined) overrides.originY = args.originY;
        if (args.instanceVariables !== undefined) overrides.instanceVariables = args.instanceVariables;
        if (args.behaviors !== undefined) overrides.behaviors = args.behaviors;
        if (args.tags !== undefined) overrides.tags = args.tags;
        if (args.showing !== undefined) overrides.showing = args.showing;
        if (args.locked !== undefined) overrides.locked = args.locked;
        const hasOverrides = Object.keys(overrides).length > 0;

        if (isNonworld) {
          if (!layout['nonworld-instances']) layout['nonworld-instances'] = [];
          layout['nonworld-instances'].push({
            type: args.objectType,
            properties: args.properties ?? {},
            uid,
            sid,
            tags: overrides.tags ?? '',
            instanceVariables: overrides.instanceVariables ?? {},
            behaviors: overrides.behaviors ?? {},
            showing: overrides.showing ?? true,
            locked: overrides.locked ?? false,
          });
          warnings.push(`"${args.objectType}" is a global (nonworld) object — placed in nonworld-instances instead of on a layer. Layer and position parameters were ignored.`);
        } else {
          const targetLayer = layout.layers.find(l => l.name === args.layerName);
          if (!targetLayer) {
            const layerNames = layout.layers.map(l => l.name).join(', ');
            return toolError(`Layer "${args.layerName}" not found in layout "${args.layoutName}". Available layers: ${layerNames}`);
          }

          const pluginProps = args.properties
            ?? (pluginId ? DEFAULT_INSTANCE_PROPERTIES[pluginId] : undefined)
            ?? {};

          if (!args.properties && pluginId && !DEFAULT_INSTANCE_PROPERTIES[pluginId]) {
            warnings.push(`No default instance properties known for plugin "${pluginId}". Instance created with empty properties — you may need to configure them in the C3 editor.`);
          }

          const instance = createInstance(
            args.objectType, uid, sid, args.x, args.y, args.width, args.height,
            pluginProps,
            hasOverrides ? overrides : undefined,
          );

          targetLayer.instances.push(instance);
        }

        const subfolder = writer.getSubfolderForEntity('layouts', args.layoutName);
        await writer.writeEntityFile('layouts', args.layoutName, layout, subfolder);

        const result: WriteResult = {
          success: true,
          entity: args.layoutName,
          category: 'layout',
          action: 'updated',
          generatedSid: sid,
          generatedUid: uid,
          warnings: warnings.length > 0 ? warnings : undefined,
        };
        return toolResult(result);
      } catch (error) {
        return toolError(`Error adding instance: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── delete_layout ────────────────────────────────────────

  server.tool(
    'delete_layout',
    'Delete a layout from the project (checks references first)',
    {
      name: z.string().max(200).describe('Layout name to delete'),
      force: z.boolean().optional().default(false).describe('If true, delete even if referenced (does NOT clean up references)'),
    },
    async (args) => {
      try {
        // Verify the layout exists
        const existing = await reader.listLayouts();
        if (!existing.includes(args.name)) {
          const suggestions = reader.findNearestName(args.name, 'layouts');
          const hint = suggestions.length > 0
            ? `\nDid you mean: ${suggestions.join(', ')}?`
            : '\nUse list_layouts to see all available names.';
          return toolError(`Layout "${args.name}" not found.${hint}`);
        }

        // Block deletion of the startup layout unconditionally
        const metadata = reader.getMetadata();
        if (metadata.firstLayout === args.name) {
          return toolError(`Cannot delete "${args.name}" — it is the project's startup layout (firstLayout). Change the startup layout in project settings first.`);
        }

        // Check references via project index
        const index = await getProjectIndex(reader);

        const warnings: string[] = [];

        // Warn about bound event sheet
        const boundSheet = index.layoutToEventSheet.get(args.name);
        if (boundSheet) {
          warnings.push(`Layout was bound to event sheet "${boundSheet}". The event sheet was NOT deleted.`);
        }

        // Warn about objects placed on this layout
        const placedObjects: string[] = [];
        for (const [objName, layouts] of index.objectToLayouts) {
          if (layouts.includes(args.name)) {
            placedObjects.push(objName);
          }
        }
        if (placedObjects.length > 0) {
          warnings.push(`Objects placed on this layout: ${placedObjects.join(', ')}. Instances were removed with the layout file.`);
        }

        if (!args.force && (placedObjects.length > 0 || boundSheet)) {
          return toolResult({
            success: false,
            entity: args.name,
            category: 'layout',
            action: 'delete_blocked',
            message: 'Layout has associated data. Use force=true to delete anyway.',
            references: {
              boundEventSheet: boundSheet || null,
              placedObjects,
            },
          });
        }

        const subfolder = writer.getSubfolderForEntity('layouts', args.name);
        const backupPath = await writer.deleteEntityFile('layouts', args.name, subfolder);
        await writer.removeFromProject('layouts', args.name);

        const result: WriteResult = {
          success: true,
          entity: args.name,
          category: 'layout',
          action: 'deleted',
          warnings: warnings.length > 0 ? warnings : undefined,
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        return toolError(`Error deleting layout: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── update_layout ────────────────────────────────────────

  server.tool(
    'update_layout',
    'Update layout properties (event sheet binding, dimensions)',
    {
      name: z.string().max(200).describe('Layout name to update'),
      eventSheet: z.string().max(200).optional().describe('New event sheet binding (validated for existence)'),
      width: z.number().int().positive().optional().describe('New layout width in pixels'),
      height: z.number().int().positive().optional().describe('New layout height in pixels'),
    },
    async (args) => {
      try {
        // Check at least one update is provided
        if (args.eventSheet === undefined && args.width === undefined && args.height === undefined) {
          return toolError('No updates provided. Specify at least one of: eventSheet, width, height.');
        }

        // Read existing layout
        let layout: Layout;
        try {
          layout = await reader.readLayout(args.name);
        } catch {
          const suggestions = reader.findNearestName(args.name, 'layouts');
          const hint = suggestions.length > 0
            ? `\nDid you mean: ${suggestions.join(', ')}?`
            : '\nUse list_layouts to see all available names.';
          return toolError(`Layout "${args.name}" not found.${hint}`);
        }

        const warnings: string[] = [];

        // Validate and apply event sheet binding
        if (args.eventSheet !== undefined) {
          const sheets = await reader.listEventSheets();
          if (!sheets.includes(args.eventSheet)) {
            const suggestions = reader.findNearestName(args.eventSheet, 'eventsheets');
            const hint = suggestions.length > 0
              ? ` Did you mean: ${suggestions.join(', ')}?`
              : ' Use list_eventsheets to see available sheets.';
            return toolError(`Event sheet "${args.eventSheet}" does not exist.${hint}`);
          }
          layout.eventSheet = args.eventSheet;
        }

        // Apply dimension updates
        if (args.width !== undefined) layout.width = args.width;
        if (args.height !== undefined) layout.height = args.height;

        // Write back
        const subfolder = writer.getSubfolderForEntity('layouts', args.name);
        const backupPath = await writer.writeEntityFile('layouts', args.name, layout, subfolder);

        const result: WriteResult = {
          success: true,
          entity: args.name,
          category: 'layout',
          action: 'updated',
          warnings: warnings.length > 0 ? warnings : undefined,
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        return toolError(`Error updating layout: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
