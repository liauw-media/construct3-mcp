/**
 * Layout tools: create_layout, add_instance_to_layout, delete_layout, update_layout,
 * add_layer, delete_layer, update_layer, delete_instance_from_layout, update_instance.
 */

import { z } from 'zod';
import type { MutationToolDeps } from './shared.js';
import type { WriteResult, Layout, Layer } from '../construct3/types.js';
import { validateName, toolResult, toolError, notFoundError } from './shared.js';
import { getProjectIndex } from '../construct3/analyzers/index-builder.js';
import {
  DEFAULT_INSTANCE_PROPERTIES,
  createLayout,
  createInstance,
  createLayer,
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
        console.error('[create_layout] failed:', error);
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
        let objData: import('../construct3/types.js').ObjectType | undefined;
        try {
          const obj = await reader.readObjectType(args.objectType);
          objData = obj;
          pluginId = obj['plugin-id'];
          // Block global-only objects from being placed on layouts
          if (obj['singleglobal-inst']) {
            return toolError(`Object "${args.objectType}" is a global plugin (${pluginId}) and cannot be placed on layouts.`);
          }
          // Nonworld-global objects (Arr, Json, Dictionary) go in nonworld-instances, not on layers
          if (obj.isGlobal === true) {
            isNonworld = true;
          }
        } catch {
          return toolError(`Object type "${args.objectType}" does not exist. Use list_objects to see available objects.`);
        }

        let layout: Layout;
        try {
          layout = await reader.readLayout(args.layoutName);
        } catch {
          return notFoundError('Layout', args.layoutName, reader.findNearestName(args.layoutName, 'layouts'), 'list_layouts');
        }

        const uid = await idGen.generateUid(reader);
        const sid = await idGen.generateSid(reader);
        const warnings: string[] = [];

        // Validate instanceVariables keys against object type definition
        if (args.instanceVariables && objData) {
          const definedVars = new Set((objData.instanceVariables ?? []).map(v => v.name));
          for (const key of Object.keys(args.instanceVariables)) {
            if (!definedVars.has(key)) {
              warnings.push(`Instance variable "${key}" is not defined on "${args.objectType}". Defined variables: ${[...definedVars].join(', ') || '(none)'}. It may be inherited from a family.`);
            }
          }
        }

        // Validate behaviors keys against object type definition
        if (args.behaviors && objData) {
          const definedBehaviors = new Set((objData.behaviorTypes ?? []).map(b => b.name));
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
        console.error('[add_instance_to_layout] failed:', error);
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
          return notFoundError('Layout', args.name, reader.findNearestName(args.name, 'layouts'), 'list_layouts');
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
        console.error('[delete_layout] failed:', error);
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
          return notFoundError('Layout', args.name, reader.findNearestName(args.name, 'layouts'), 'list_layouts');
        }

        const warnings: string[] = [];

        // Validate and apply event sheet binding
        if (args.eventSheet !== undefined) {
          const sheets = await reader.listEventSheets();
          if (!sheets.includes(args.eventSheet)) {
            return notFoundError('Event sheet', args.eventSheet, reader.findNearestName(args.eventSheet, 'eventsheets'), 'list_eventsheets');
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
        console.error('[update_layout] failed:', error);
        return toolError(`Error updating layout: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── add_layer ────────────────────────────────────────────

  server.tool(
    'add_layer',
    'Add a new layer to an existing layout',
    {
      layoutName: z.string().max(200).describe('Layout to add the layer to'),
      layerName: z.string().max(200).describe('New layer name (must be unique within the layout)'),
      index: z.number().int().min(0).optional().describe('Insert at this position (0 = bottom, default: append to top)'),
      isInitiallyVisible: z.boolean().optional().default(true).describe('Layer starts visible (default: true)'),
      isTransparent: z.boolean().optional().default(true).describe('Layer is transparent (default: true)'),
      parallaxX: z.number().optional().default(1).describe('Horizontal parallax rate (default: 1)'),
      parallaxY: z.number().optional().default(1).describe('Vertical parallax rate (default: 1)'),
      blendMode: z.enum(['normal', 'additive', 'xor', 'copy', 'destination-over', 'source-in', 'destination-in', 'source-out', 'destination-out', 'source-atop', 'destination-atop']).optional().default('normal').describe('Blend mode (default: normal)'),
    },
    async (args) => {
      try {
        let layout: Layout;
        try {
          layout = await reader.readLayout(args.layoutName);
        } catch {
          return notFoundError('Layout', args.layoutName, reader.findNearestName(args.layoutName, 'layouts'), 'list_layouts');
        }

        // Check for duplicate layer name within this layout
        if (layout.layers.some(l => l.name === args.layerName)) {
          return toolError(`Layer "${args.layerName}" already exists in layout "${args.layoutName}".`);
        }

        const layerSid = await idGen.generateSid(reader);
        const newLayer: Layer = {
          ...createLayer(args.layerName, layerSid),
          isInitiallyVisible: args.isInitiallyVisible,
          isTransparent: args.isTransparent,
          parallaxX: args.parallaxX,
          parallaxY: args.parallaxY,
          blendMode: args.blendMode,
        };

        if (args.index !== undefined) {
          layout.layers.splice(args.index, 0, newLayer);
        } else {
          layout.layers.push(newLayer);
        }

        const subfolder = writer.getSubfolderForEntity('layouts', args.layoutName);
        const backupPath = await writer.writeEntityFile('layouts', args.layoutName, layout, subfolder);

        const result: WriteResult = {
          success: true,
          entity: args.layoutName,
          category: 'layout',
          action: 'updated',
          generatedSid: layerSid,
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[add_layer] failed:', error);
        return toolError(`Error adding layer: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── delete_layer ─────────────────────────────────────────

  server.tool(
    'delete_layer',
    'Delete a layer from a layout (must not be the last layer)',
    {
      layoutName: z.string().max(200).describe('Layout name'),
      layerName: z.string().max(200).describe('Layer name to delete'),
      force: z.boolean().optional().default(false).describe('Delete even if the layer contains instances (instances will be lost)'),
    },
    async (args) => {
      try {
        let layout: Layout;
        try {
          layout = await reader.readLayout(args.layoutName);
        } catch {
          return notFoundError('Layout', args.layoutName, reader.findNearestName(args.layoutName, 'layouts'), 'list_layouts');
        }

        const layerIdx = layout.layers.findIndex(l => l.name === args.layerName);
        if (layerIdx === -1) {
          const available = layout.layers.map(l => l.name).join(', ');
          return toolError(`Layer "${args.layerName}" not found in layout "${args.layoutName}". Available layers: ${available}`);
        }

        // Prevent deleting the last layer
        if (layout.layers.length <= 1) {
          return toolError(`Cannot delete the last layer in layout "${args.layoutName}". A layout must have at least one layer.`);
        }

        const layer = layout.layers[layerIdx];
        const instanceCount = layer.instances.length;

        if (instanceCount > 0 && !args.force) {
          return toolResult({
            success: false,
            entity: args.layoutName,
            category: 'layout',
            action: 'delete_blocked',
            message: `Layer "${args.layerName}" contains ${instanceCount} instance(s). Use force=true to delete the layer and all its instances.`,
            instanceCount,
          });
        }

        layout.layers.splice(layerIdx, 1);

        const subfolder = writer.getSubfolderForEntity('layouts', args.layoutName);
        const backupPath = await writer.writeEntityFile('layouts', args.layoutName, layout, subfolder);

        const result: WriteResult = {
          success: true,
          entity: args.layoutName,
          category: 'layout',
          action: 'updated',
          backupFile: backupPath,
          warnings: instanceCount > 0 ? [`Deleted layer contained ${instanceCount} instance(s) — they have been removed.`] : undefined,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[delete_layer] failed:', error);
        return toolError(`Error deleting layer: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── update_layer ─────────────────────────────────────────

  server.tool(
    'update_layer',
    'Update properties of an existing layer (name, visibility, parallax, blend mode, etc.)',
    {
      layoutName: z.string().max(200).describe('Layout name'),
      layerName: z.string().max(200).describe('Layer name to update'),
      newName: z.string().max(200).optional().describe('Rename the layer'),
      isInitiallyVisible: z.boolean().optional().describe('Change initial visibility'),
      isInitiallyInteractive: z.boolean().optional().describe('Change initial interactivity'),
      isTransparent: z.boolean().optional().describe('Change transparency'),
      parallaxX: z.number().optional().describe('Horizontal parallax rate'),
      parallaxY: z.number().optional().describe('Vertical parallax rate'),
      blendMode: z.enum(['normal', 'additive', 'xor', 'copy', 'destination-over', 'source-in', 'destination-in', 'source-out', 'destination-out', 'source-atop', 'destination-atop']).optional().describe('Blend mode'),
      scaleRate: z.number().optional().describe('Scale rate (parallax zoom)'),
      zElevation: z.number().optional().describe('Z elevation for 3D layering'),
    },
    async (args) => {
      try {
        const hasUpdates = args.newName !== undefined || args.isInitiallyVisible !== undefined ||
          args.isInitiallyInteractive !== undefined || args.isTransparent !== undefined ||
          args.parallaxX !== undefined || args.parallaxY !== undefined ||
          args.blendMode !== undefined || args.scaleRate !== undefined || args.zElevation !== undefined;

        if (!hasUpdates) {
          return toolError('No updates provided. Specify at least one of: newName, isInitiallyVisible, isInitiallyInteractive, isTransparent, parallaxX, parallaxY, blendMode, scaleRate, zElevation.');
        }

        let layout: Layout;
        try {
          layout = await reader.readLayout(args.layoutName);
        } catch {
          return notFoundError('Layout', args.layoutName, reader.findNearestName(args.layoutName, 'layouts'), 'list_layouts');
        }

        const layer = layout.layers.find(l => l.name === args.layerName);
        if (!layer) {
          const available = layout.layers.map(l => l.name).join(', ');
          return toolError(`Layer "${args.layerName}" not found in layout "${args.layoutName}". Available layers: ${available}`);
        }

        // Check new name uniqueness
        if (args.newName !== undefined && args.newName !== args.layerName) {
          if (layout.layers.some(l => l.name === args.newName)) {
            return toolError(`Layer "${args.newName}" already exists in layout "${args.layoutName}".`);
          }
          layer.name = args.newName;
        }

        if (args.isInitiallyVisible !== undefined) layer.isInitiallyVisible = args.isInitiallyVisible;
        if (args.isInitiallyInteractive !== undefined) layer.isInitiallyInteractive = args.isInitiallyInteractive;
        if (args.isTransparent !== undefined) layer.isTransparent = args.isTransparent;
        if (args.parallaxX !== undefined) layer.parallaxX = args.parallaxX;
        if (args.parallaxY !== undefined) layer.parallaxY = args.parallaxY;
        if (args.blendMode !== undefined) layer.blendMode = args.blendMode;
        if (args.scaleRate !== undefined) layer.scaleRate = args.scaleRate;
        if (args.zElevation !== undefined) layer.zElevation = args.zElevation;

        const subfolder = writer.getSubfolderForEntity('layouts', args.layoutName);
        const backupPath = await writer.writeEntityFile('layouts', args.layoutName, layout, subfolder);

        const result: WriteResult = {
          success: true,
          entity: args.layoutName,
          category: 'layout',
          action: 'updated',
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[update_layer] failed:', error);
        return toolError(`Error updating layer: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── delete_instance_from_layout ─────────────────────────

  server.tool(
    'delete_instance_from_layout',
    'Remove a placed object instance from a layout by its UID',
    {
      layoutName: z.string().max(200).describe('Layout name'),
      uid: z.number().int().describe('UID of the instance to remove'),
    },
    async (args) => {
      try {
        let layout: Layout;
        try {
          layout = await reader.readLayout(args.layoutName);
        } catch {
          return notFoundError('Layout', args.layoutName, reader.findNearestName(args.layoutName, 'layouts'), 'list_layouts');
        }

        // Search layers
        let found = false;
        let removedType: string | undefined;

        for (const layer of layout.layers) {
          const idx = layer.instances.findIndex(inst => inst.uid === args.uid);
          if (idx !== -1) {
            removedType = layer.instances[idx].type;
            layer.instances.splice(idx, 1);
            found = true;
            break;
          }
        }

        // Search nonworld-instances
        if (!found) {
          const nonworld = layout['nonworld-instances'] as Array<Record<string, unknown>> | undefined;
          if (Array.isArray(nonworld)) {
            const idx = nonworld.findIndex(inst => inst.uid === args.uid);
            if (idx !== -1) {
              removedType = nonworld[idx].type as string;
              nonworld.splice(idx, 1);
              found = true;
            }
          }
        }

        if (!found) {
          return toolError(`Instance with UID ${args.uid} not found in layout "${args.layoutName}". Use get_layout_details to see all instance UIDs.`);
        }

        const subfolder = writer.getSubfolderForEntity('layouts', args.layoutName);
        const backupPath = await writer.writeEntityFile('layouts', args.layoutName, layout, subfolder);

        const result: WriteResult = {
          success: true,
          entity: args.layoutName,
          category: 'layout',
          action: 'updated',
          backupFile: backupPath,
          warnings: removedType ? [`Removed instance of "${removedType}" (UID ${args.uid}).`] : undefined,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[delete_instance_from_layout] failed:', error);
        return toolError(`Error deleting instance: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── update_instance ─────────────────────────────────────

  server.tool(
    'update_instance',
    'Update properties of a placed instance on a layout (position, size, angle, visibility, etc.)',
    {
      layoutName: z.string().max(200).describe('Layout name'),
      uid: z.number().int().describe('UID of the instance to update'),
      x: z.number().optional().describe('New X position'),
      y: z.number().optional().describe('New Y position'),
      width: z.number().optional().describe('New width'),
      height: z.number().optional().describe('New height'),
      angle: z.number().optional().describe('New rotation angle in radians'),
      zElevation: z.number().optional().describe('New Z elevation'),
      color: z.array(z.number().min(0).max(1)).length(4).optional().describe('New RGBA tint [r,g,b,a] values 0-1'),
      showing: z.boolean().optional().describe('Initial visibility'),
      locked: z.boolean().optional().describe('Locked in editor'),
      tags: z.string().max(500).optional().describe('Comma-separated tags'),
      instanceVariables: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe('Instance variable values to update'),
    },
    async (args) => {
      try {
        const hasUpdates = args.x !== undefined || args.y !== undefined || args.width !== undefined ||
          args.height !== undefined || args.angle !== undefined || args.zElevation !== undefined ||
          args.color !== undefined || args.showing !== undefined || args.locked !== undefined ||
          args.tags !== undefined || args.instanceVariables !== undefined;

        if (!hasUpdates) {
          return toolError('No updates provided. Specify at least one property to update.');
        }

        let layout: Layout;
        try {
          layout = await reader.readLayout(args.layoutName);
        } catch {
          return notFoundError('Layout', args.layoutName, reader.findNearestName(args.layoutName, 'layouts'), 'list_layouts');
        }

        // Find the instance in layers
        let found = false;

        for (const layer of layout.layers) {
          const inst = layer.instances.find(i => i.uid === args.uid);
          if (inst) {
            // Update world properties
            if (inst.world) {
              if (args.x !== undefined) inst.world.x = args.x;
              if (args.y !== undefined) inst.world.y = args.y;
              if (args.width !== undefined) inst.world.width = args.width;
              if (args.height !== undefined) inst.world.height = args.height;
              if (args.angle !== undefined) inst.world.angle = args.angle;
              if (args.zElevation !== undefined) inst.world.zElevation = args.zElevation;
              if (args.color !== undefined) inst.world.color = args.color;
            }
            if (args.showing !== undefined) inst.showing = args.showing;
            if (args.locked !== undefined) inst.locked = args.locked;
            if (args.tags !== undefined) inst.tags = args.tags;
            if (args.instanceVariables !== undefined) {
              inst.instanceVariables = { ...(inst.instanceVariables ?? {}), ...args.instanceVariables };
            }
            found = true;
            break;
          }
        }

        // Also check nonworld-instances (no world prop, but can update other fields)
        if (!found) {
          const nonworld = layout['nonworld-instances'] as Array<Record<string, unknown>> | undefined;
          if (Array.isArray(nonworld)) {
            const inst = nonworld.find(i => i.uid === args.uid);
            if (inst) {
              if (args.showing !== undefined) inst.showing = args.showing;
              if (args.locked !== undefined) inst.locked = args.locked;
              if (args.tags !== undefined) inst.tags = args.tags;
              if (args.instanceVariables !== undefined) {
                inst.instanceVariables = { ...(inst.instanceVariables as Record<string, unknown> ?? {}), ...args.instanceVariables };
              }
              const ignoredWorldProps = [args.x, args.y, args.width, args.height, args.angle, args.zElevation, args.color].filter(v => v !== undefined);
              if (ignoredWorldProps.length > 0) {
                // nonworld instances have no position — silently ignore spatial props
              }
              found = true;
            }
          }
        }

        if (!found) {
          return toolError(`Instance with UID ${args.uid} not found in layout "${args.layoutName}". Use get_layout_details to see all instance UIDs.`);
        }

        const subfolder = writer.getSubfolderForEntity('layouts', args.layoutName);
        const backupPath = await writer.writeEntityFile('layouts', args.layoutName, layout, subfolder);

        const result: WriteResult = {
          success: true,
          entity: args.layoutName,
          category: 'layout',
          action: 'updated',
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[update_instance] failed:', error);
        return toolError(`Error updating instance: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
